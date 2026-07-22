#![cfg(unix)]

use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use agent_workspace_terminal_runtime::{TerminalEvent, TerminalManager, TerminalSpawnRequest};
use tempfile::TempDir;
use tokio::{sync::broadcast, time::timeout};
use uuid::Uuid;

const PROGRAM_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
enum Interaction {
    Shell,
    Editor,
    Tmux,
}

struct SmokeProgram {
    name: &'static str,
    args: &'static [&'static str],
    interaction: Interaction,
}

const PROGRAMS: [SmokeProgram; 6] = [
    SmokeProgram {
        name: "bash",
        args: &["--noprofile", "--norc", "-i"],
        interaction: Interaction::Shell,
    },
    SmokeProgram {
        name: "zsh",
        args: &["-f", "-i"],
        interaction: Interaction::Shell,
    },
    SmokeProgram {
        name: "fish",
        args: &["--no-config", "--interactive"],
        interaction: Interaction::Shell,
    },
    SmokeProgram {
        name: "vim",
        args: &["-N", "-u", "NONE", "-i", "NONE", "-n"],
        interaction: Interaction::Editor,
    },
    SmokeProgram {
        name: "nvim",
        args: &["-u", "NONE", "-i", "NONE", "-n"],
        interaction: Interaction::Editor,
    },
    SmokeProgram {
        name: "tmux",
        args: &[],
        interaction: Interaction::Tmux,
    },
];

#[tokio::test]
async fn installed_shells_editors_and_tmux_complete_real_pty_smokes() {
    let mut failures = Vec::new();

    for program in &PROGRAMS {
        let Ok(executable) = which::which(program.name) else {
            eprintln!("{:<5} SKIP (not installed)", program.name);
            continue;
        };

        match smoke_program(program, executable).await {
            Ok(()) => eprintln!("{:<5} PASS", program.name),
            Err(error) => {
                eprintln!("{:<5} FAIL ({error})", program.name);
                failures.push(format!("{}: {error}", program.name));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "installed real-program PTY smokes failed:\n{}",
        failures.join("\n")
    );
}

async fn smoke_program(program: &SmokeProgram, executable: PathBuf) -> Result<(), String> {
    let temporary_home = tempfile::tempdir().map_err(|error| error.to_string())?;
    let marker = format!(
        "AGENT_WORKSPACE_SMOKE_{}_{}",
        program.name.to_ascii_uppercase(),
        Uuid::new_v4().simple()
    );
    let (marker_start, marker_end) = marker.split_at(marker.len() / 2);
    let tmux_server = format!("agent-workspace-smoke-{}", Uuid::new_v4().simple());
    let command = terminal_command(program, &executable, &tmux_server);
    let input = terminal_input(program.interaction, marker_start, marker_end);
    let manager = TerminalManager::new();
    let mut events = manager.subscribe();

    let terminal = manager
        .create(TerminalSpawnRequest {
            rows: 30,
            cols: 100,
            cwd: Some(temporary_home.path().to_path_buf()),
            command: Some(command),
            executable_identity: None,
            environment: isolated_environment(&temporary_home),
        })
        .await
        .map_err(|error| format!("spawn failed: {error}"))?;

    let result = timeout(PROGRAM_TIMEOUT, async {
        manager
            .write(&terminal.id, input)
            .await
            .map_err(|error| format!("PTY input failed: {error}"))?;
        if matches!(program.interaction, Interaction::Editor) {
            wait_for_marker(&mut events, &terminal.id, marker.as_bytes()).await?;
            manager
                .write(&terminal.id, b":qa!\r".to_vec())
                .await
                .map_err(|error| format!("PTY exit input failed: {error}"))?;
            wait_for_successful_exit(&mut events, &terminal.id).await
        } else {
            wait_for_marker_and_exit(&mut events, &terminal.id, marker.as_bytes()).await
        }
    })
    .await
    .map_err(|_| format!("timed out after {} seconds", PROGRAM_TIMEOUT.as_secs()))
    .and_then(std::convert::identity);

    // This is deliberately unconditional: terminate is idempotent after a normal exit and
    // prevents a failed assertion or timeout from leaving an interactive program behind.
    let termination = manager.terminate(&terminal.id).await;
    manager.shutdown_all().await;
    if matches!(program.interaction, Interaction::Tmux) {
        cleanup_tmux(&executable, &tmux_server, temporary_home.path());
    }

    match (result, termination) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(format!("cleanup failed: {error}")),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn terminal_command(program: &SmokeProgram, executable: &Path, tmux_server: &str) -> Vec<String> {
    let mut command = vec![executable.to_string_lossy().into_owned()];
    if matches!(program.interaction, Interaction::Tmux) {
        command.extend([
            "-L".to_owned(),
            tmux_server.to_owned(),
            "-f".to_owned(),
            "/dev/null".to_owned(),
            "new-session".to_owned(),
            "/bin/sh".to_owned(),
        ]);
    } else {
        command.extend(program.args.iter().map(|argument| (*argument).to_owned()));
    }
    command
}

fn terminal_input(interaction: Interaction, marker_start: &str, marker_end: &str) -> Vec<u8> {
    match interaction {
        Interaction::Shell | Interaction::Tmux => {
            format!("printf '%s%s\\n' '{marker_start}' '{marker_end}'\nexit\n").into_bytes()
        }
        Interaction::Editor => {
            format!(":echo \"{marker_start}\" . \"{marker_end}\"\r").into_bytes()
        }
    }
}

fn isolated_environment(temporary_home: &TempDir) -> Vec<(String, String)> {
    let home = temporary_home.path().to_string_lossy().into_owned();
    vec![
        ("HOME".to_owned(), home.clone()),
        ("XDG_CONFIG_HOME".to_owned(), home.clone()),
        ("ZDOTDIR".to_owned(), home.clone()),
        ("TMUX_TMPDIR".to_owned(), home),
        ("HISTFILE".to_owned(), "/dev/null".to_owned()),
    ]
}

async fn wait_for_marker_and_exit(
    events: &mut broadcast::Receiver<TerminalEvent>,
    terminal_id: &str,
    marker: &[u8],
) -> Result<(), String> {
    let mut output = Vec::new();
    loop {
        match events.recv().await {
            Ok(TerminalEvent::Output {
                terminal_id: event_terminal_id,
                chunk,
            }) if event_terminal_id == terminal_id => output.extend_from_slice(&chunk.data),
            Ok(TerminalEvent::Exited {
                terminal_id: event_terminal_id,
                exit_code,
                signal,
            }) if event_terminal_id == terminal_id => {
                if exit_code != 0 {
                    return Err(format!(
                        "exited with code {exit_code} and signal {signal:?}"
                    ));
                }
                if !contains_bytes(&output, marker) {
                    return Err("exited successfully without emitting the marker".to_owned());
                }
                return Ok(());
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                return Err(format!("event receiver lagged by {skipped} messages"));
            }
            Err(broadcast::error::RecvError::Closed) => {
                return Err("event channel closed before process exit".to_owned());
            }
        }
    }
}

async fn wait_for_marker(
    events: &mut broadcast::Receiver<TerminalEvent>,
    terminal_id: &str,
    marker: &[u8],
) -> Result<(), String> {
    let mut output = Vec::new();
    loop {
        match events.recv().await {
            Ok(TerminalEvent::Output {
                terminal_id: event_terminal_id,
                chunk,
            }) if event_terminal_id == terminal_id => {
                output.extend_from_slice(&chunk.data);
                if contains_bytes(&output, marker) {
                    return Ok(());
                }
            }
            Ok(TerminalEvent::Exited {
                terminal_id: event_terminal_id,
                exit_code,
                signal,
            }) if event_terminal_id == terminal_id => {
                return Err(format!(
                    "exited with code {exit_code} and signal {signal:?} before emitting the marker"
                ));
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                return Err(format!("event receiver lagged by {skipped} messages"));
            }
            Err(broadcast::error::RecvError::Closed) => {
                return Err("event channel closed before marker output".to_owned());
            }
        }
    }
}

async fn wait_for_successful_exit(
    events: &mut broadcast::Receiver<TerminalEvent>,
    terminal_id: &str,
) -> Result<(), String> {
    loop {
        match events.recv().await {
            Ok(TerminalEvent::Exited {
                terminal_id: event_terminal_id,
                exit_code,
                signal,
            }) if event_terminal_id == terminal_id => {
                if exit_code != 0 {
                    return Err(format!(
                        "exited with code {exit_code} and signal {signal:?}"
                    ));
                }
                return Ok(());
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                return Err(format!("event receiver lagged by {skipped} messages"));
            }
            Err(broadcast::error::RecvError::Closed) => {
                return Err("event channel closed before process exit".to_owned());
            }
        }
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn cleanup_tmux(executable: &Path, server: &str, temporary_home: &Path) {
    let _ = Command::new(executable)
        .env("TMUX_TMPDIR", temporary_home)
        .args(["-L", server, "kill-server"])
        .status();
}
