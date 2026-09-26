import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFile(resolve(repositoryDirectory, path), 'utf8')
const execFileAsync = promisify(execFile)

test('CI builds the Node desktop and inspects packaged Linux artifacts', async () => {
  const workflow = await read('.github/workflows/ci.yml')
  assert.match(workflow, /node-version: 22\.22\.3/u)
  assert.match(workflow, /pnpm validate/u)
  assert.match(workflow, /pnpm package:linux/u)
  assert.match(workflow, /inspect-node-preview\.sh/u)
  assert.doesNotMatch(workflow, /cargo|rustup|build:service/u)
})

test('Linux package workflows retain default lanes and add one software-rendered AppImage lane', async () => {
  const [candidate, scheduled] = await Promise.all([
    read('.github/workflows/release-candidate.yml'),
    read('.github/workflows/package-smoke.yml')
  ])

  assert.ok(
    candidate.includes(
      'name: Clean ${{ matrix.os }} ${{ matrix.type }} ${{ matrix.display }} ${{ matrix.rendering }} smoke'
    )
  )
  assert.ok(
    scheduled.includes(
      'name: Clean Ubuntu ${{ matrix.type }} ${{ matrix.display }} ${{ matrix.rendering }} install and launch'
    )
  )
  assert.equal(candidate.match(/^\s+rendering: default$/gmu)?.length, 4)
  assert.equal(scheduled.match(/^\s+rendering: default$/gmu)?.length, 2)
  assert.equal(
    candidate.match(
      /- os: Ubuntu 24\.04\n\s+family: ubuntu\n\s+type: appimage\n\s+display: x11\n\s+rendering: software\n\s+launch_args: --disable-gpu/gu
    )?.length,
    1
  )
  assert.equal(
    scheduled.match(
      /- type: appimage\n\s+display: x11\n\s+rendering: software\n\s+launch_args: --disable-gpu/gu
    )?.length,
    1
  )

  for (const workflow of [candidate, scheduled]) {
    assert.equal(
      workflow.match(/rendering: software\n\s+launch_args: --disable-gpu/gu)?.length,
      1
    )
    assert.match(workflow, /if: matrix\.type == 'appimage'/u)
    assert.match(workflow, /LAUNCH_ARGS: \$\{\{ matrix\.launch_args \}\}/u)
    assert.match(workflow, /if \[\[ -n \$LAUNCH_ARGS \]\]; then/u)
    assert.match(
      workflow,
      /launch-probe\.sh" "\$scratch\/squashfs-root\/AppRun" "\$LAUNCH_ARGS"/u
    )
    assert.match(workflow, /launch-probe\.sh" "\$scratch\/squashfs-root\/AppRun"\n/u)
  }
})

test('Linux package workflows define checksum-verified Arch AppImage readiness lanes', async () => {
  const [candidate, scheduled] = await Promise.all([
    read('.github/workflows/release-candidate.yml'),
    read('.github/workflows/package-smoke.yml')
  ])
  const image =
    'archlinux:base-20260712.0.555161@sha256:fe6972d4dc1f660c0c10f4c41b2de8986bab89e7e2955378f8beadb8ebcd7433'
  const packages =
    'pacman -Syu --noconfirm --needed ca-certificates coreutils file findutils git procps-ng xorg-server-xvfb xorg-xauth alsa-lib gtk3 nss libxss mesa'

  assert.match(
    candidate,
    /- os: Arch Linux\n\s+family: arch\n\s+type: appimage\n\s+display: x11\n\s+rendering: default\n\s+launch_args: ''/u
  )
  assert.match(candidate, /if: matrix\.family == 'ubuntu'/u)
  assert.match(candidate, /if: matrix\.family == 'fedora'/u)
  assert.match(candidate, /if: matrix\.family == 'arch'/u)
  assert.match(scheduled, /^  arch:\n\s+name: Clean Arch Linux extracted AppImage X11 install and launch/mu)

  for (const workflow of [candidate, scheduled]) {
    assert.ok(workflow.includes(image))
    assert.ok(workflow.includes(packages))
    assert.match(workflow, /verify-downloaded-artifacts\.sh/u)
    assert.match(workflow, /inspect-artifact\.sh appimage "\$artifact"/u)
    assert.match(workflow, /--appimage-extract/u)
    assert.match(workflow, /launch-probe\.sh" "\$scratch\/squashfs-root\/AppRun"/u)
  }
})

test('Linux package workflows define bounded headless native-Wayland readiness lanes', async () => {
  const [candidate, scheduled] = await Promise.all([
    read('.github/workflows/release-candidate.yml'),
    read('.github/workflows/package-smoke.yml')
  ])

  assert.equal(
    candidate.match(
      /- os: Ubuntu 24\.04\n\s+family: ubuntu\n\s+type: appimage\n\s+display: wayland\n\s+rendering: weston-pixman\n\s+launch_args: ''/gu
    )?.length,
    1
  )
  assert.equal(
    scheduled.match(
      /- type: appimage\n\s+display: wayland\n\s+rendering: weston-pixman\n\s+launch_args: ''/gu
    )?.length,
    1
  )
  assert.match(
    candidate,
    /name: Install headless Wayland compositor\n\s+if: matrix\.family == 'ubuntu' && matrix\.display == 'wayland'/u
  )
  assert.match(
    scheduled,
    /name: Install headless Wayland compositor\n\s+if: matrix\.display == 'wayland'/u
  )
  for (const workflow of [candidate, scheduled]) {
    assert.match(workflow, /apt-get install -y --no-install-recommends weston/u)
    assert.match(workflow, /DISPLAY_SERVER: \$\{\{ matrix\.display \}\}/u)
    assert.match(workflow, /export XDG_SESSION_TYPE=wayland/u)
    assert.match(workflow, /export WAYLAND_DISPLAY=agent-workspace-wayland/u)
    assert.match(workflow, /unset DISPLAY/u)
    assert.match(
      workflow,
      /weston --backend=headless --renderer=pixman --shell=kiosk --socket="\$WAYLAND_DISPLAY" --idle-time=0 --no-config/u
    )
    assert.match(workflow, /for _ in \{1\.\.100\}; do/u)
    assert.match(workflow, /\[\[ -S \$wayland_runtime\/\$WAYLAND_DISPLAY \]\]/u)
    assert.match(workflow, /trap cleanup_wayland EXIT/u)
    assert.match(workflow, /for _ in \{1\.\.20\}; do/u)
    assert.match(workflow, /kill -KILL "\$weston_pid"/u)
  }
})

test('Linux launch probe preserves a secure Wayland socket and bypasses Xvfb', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'wayland-launch-probe-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const runtime = resolve(directory, 'runtime')
  const bin = resolve(directory, 'bin')
  const socket = resolve(runtime, 'wayland-test')
  const capture = resolve(directory, 'environment.txt')
  const xvfbCapture = resolve(directory, 'xvfb-called')
  const executable = resolve(directory, 'fake-app')
  await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(bin)])
  await chmod(runtime, 0o700)
  await Promise.all([
    writeFile(
      executable,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n%s\\n%s\\n' "$XDG_RUNTIME_DIR" "$XDG_SESSION_TYPE" "\${WAYLAND_DISPLAY:-}" > "$PROBE_CAPTURE"
bash -c 'exec -a "resources/node-linux/server/dist/bin.mjs" sleep 30' &
bash -c 'exec -a "electron --type=renderer" sleep 30' &
wait
`
    ),
    writeFile(
      resolve(bin, 'xvfb-run'),
      `#!/usr/bin/env bash
printf 'called\\n' > "$XVFB_CAPTURE"
exit 97
`
    )
  ])
  await Promise.all([chmod(executable, 0o700), chmod(resolve(bin, 'xvfb-run'), 0o700)])

  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(socket, resolvePromise)
  })
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)))

  const probe = resolve(repositoryDirectory, 'scripts/release/launch-probe.sh')
  const environment = {
    ...process.env,
    DISPLAY: '',
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    PROBE_CAPTURE: capture,
    WAYLAND_DISPLAY: 'wayland-test',
    XDG_RUNTIME_DIR: runtime,
    XDG_SESSION_TYPE: 'wayland',
    XVFB_CAPTURE: xvfbCapture
  }
  const { stdout } = await execFileAsync(probe, [executable], {
    cwd: repositoryDirectory,
    env: environment
  })
  assert.match(stdout, /packaged launch ready:/u)
  assert.equal(await readFile(capture, 'utf8'), `${runtime}\nwayland\nwayland-test\n`)
  await assert.rejects(readFile(xvfbCapture, 'utf8'), { code: 'ENOENT' })

  await execFileAsync(probe, [executable], {
    cwd: repositoryDirectory,
    env: {
      ...environment,
      DISPLAY: ':99',
      WAYLAND_DISPLAY: '',
      XDG_SESSION_TYPE: 'wayland'
    }
  })
  const [x11Runtime, x11Session, x11Display] = (await readFile(capture, 'utf8')).split('\n')
  assert.match(x11Runtime, /\/runtime$/u)
  assert.notEqual(x11Runtime, runtime)
  assert.equal(x11Session, 'x11')
  assert.equal(x11Display, '')

  await assert.rejects(
    execFileAsync(probe, [executable], {
      cwd: repositoryDirectory,
      env: { ...environment, XDG_SESSION_TYPE: 'x11' }
    }),
    (error) => {
      assert.match(error.stderr, /Wayland launch requires XDG_SESSION_TYPE=wayland/u)
      return true
    }
  )

  await chmod(runtime, 0o755)
  await assert.rejects(
    execFileAsync(probe, [executable], {
      cwd: repositoryDirectory,
      env: environment
    }),
    (error) => {
      assert.match(error.stderr, /XDG_RUNTIME_DIR must be owned by the current user with mode 0700/u)
      return true
    }
  )
  await chmod(runtime, 0o700)
})

test('Linux launch probe requires the bundled Node server and renderer', async () => {
  const probe = await read('scripts/release/launch-probe.sh')
  assert.match(probe, /node-linux/u)
  assert.match(probe, /--type=renderer/u)
  assert.match(probe, /packaged launch ready/u)
})

test('release candidates preserve direct accessibility, visual, and recovery evidence', async () => {
  const workflow = await read('.github/workflows/release-candidate.yml')
  assert.match(workflow, /sudo apt-get install -y --no-install-recommends xvfb/u)
  assert.match(
    workflow,
    /xvfb-run -a pnpm --filter @agent-workspace\/desktop test:a11y/u
  )
  assert.match(
    workflow,
    /xvfb-run -a pnpm --filter @agent-workspace\/desktop test:visual/u
  )
  assert.match(
    workflow,
    /xvfb-run -a pnpm --filter @agent-workspace\/desktop exec playwright test e2e\/persistence-recovery\.spec\.mjs\n\s+--workers=1\n\s+--timeout=30000\n\s+--grep='corrupt database enters private recovery UI without mutating the source'/u
  )
  assert.equal(workflow.match(/AGENT_WORKSPACE_EVIDENCE_DIR:/gu)?.length, 3)
  assert.equal(workflow.match(/PLAYWRIGHT_HTML_OUTPUT_DIR:/gu)?.length, 3)
  assert.equal(workflow.match(/PLAYWRIGHT_JSON_OUTPUT_FILE:/gu)?.length, 3)
  assert.equal(workflow.match(/--reporter=line,html,json/gu)?.length, 3)
  assert.match(
    workflow,
    /name: Run corrupt-database recovery validation under Xvfb\n\s+id: recovery-validation\n\s+continue-on-error: true/u
  )
  assert.match(
    workflow,
    /AGENT_WORKSPACE_EVIDENCE_DIR: \$\{\{ github\.workspace \}\}\/release-validation\/recovery\/evidence/u
  )
  assert.match(
    workflow,
    /PLAYWRIGHT_HTML_OUTPUT_DIR: \$\{\{ github\.workspace \}\}\/release-validation\/recovery\/report/u
  )
  assert.match(
    workflow,
    /PLAYWRIGHT_JSON_OUTPUT_FILE: \$\{\{ github\.workspace \}\}\/release-validation\/recovery\/test-results\/results\.json/u
  )
  assert.match(
    workflow,
    /--output=\$\{\{ github\.workspace \}\}\/release-validation\/recovery\/test-results/u
  )
  assert.doesNotMatch(workflow, /screenshot=\$\(find/u)
  assert.doesNotMatch(workflow, /cp "\$screenshot"/u)
  assert.match(
    workflow,
    /name: Verify accessibility, visual, and recovery validation evidence\n\s+id: ui-evidence-validation\n\s+if: always\(\)\n\s+continue-on-error: true/u
  )
  const expectedPaths = [
    'accessibility/evidence/01-initial-workspace.png',
    'accessibility/evidence/01-screen-reader-control.png',
    'accessibility/evidence/02-settings.png',
    'accessibility/evidence/03-notification-attention.png',
    'accessibility/evidence/04-zoom-200.png',
    'accessibility/evidence/05-zoom-400.png',
    'accessibility/evidence/06-forced-colors.png',
    'accessibility/report/index.html',
    'accessibility/test-results/results.json',
    'visual/evidence/command-palette-dark.png',
    'visual/evidence/notification-attention-light.png',
    'visual/evidence/notification-center-light.png',
    'visual/evidence/service-failure-dark.png',
    'visual/evidence/settings-light.png',
    'visual/evidence/workspace-dark.png',
    'visual/evidence/workspace-empty-replacement-dark.png',
    'visual/evidence/workspace-four-pane-dark.png',
    'visual/evidence/workspace-fractional-scale-dark.png',
    'visual/evidence/workspace-hover-focus-dark.png',
    'visual/evidence/workspace-light.png',
    'visual/evidence/workspace-sidebar-collapsed-dark.png',
    'visual/report/index.html',
    'visual/test-results/results.json',
    'recovery/evidence/corrupt-database-recovery-linux.png',
    'recovery/report/index.html',
    'recovery/test-results/results.json'
  ]
  for (const path of expectedPaths) {
    assert.ok(workflow.includes(`release-validation/${path}`))
  }
  assert.match(workflow, /metadata\.size === 0/u)
  assert.match(
    workflow,
    /if \(missingFiles\.length > 0\) \{\n\s+throw new Error\(`Missing or empty release UI validation evidence:/u
  )
  assert.match(
    workflow,
    /name: Upload accessibility, visual, and recovery validation evidence\n\s+if: always\(\)/u
  )
  assert.match(
    workflow,
    /name: Upload accessibility, visual, and recovery validation evidence[\s\S]*?path: release-validation\n\s+if-no-files-found: error/u
  )
  assert.match(
    workflow,
    /if: steps\.accessibility-validation\.outcome == 'failure' \|\| steps\.visual-validation\.outcome == 'failure' \|\| steps\.recovery-validation\.outcome == 'failure' \|\| steps\.ui-evidence-validation\.outcome == 'failure'/u
  )
  const verificationIndex = workflow.indexOf(
    'name: Verify accessibility, visual, and recovery validation evidence'
  )
  const uploadIndex = workflow.indexOf(
    'name: Upload accessibility, visual, and recovery validation evidence'
  )
  const enforcementIndex = workflow.indexOf(
    'name: Enforce accessibility, visual, and recovery validation results'
  )
  assert.ok(workflow.indexOf('id: recovery-validation') > workflow.indexOf('id: visual-validation'))
  assert.ok(verificationIndex > workflow.indexOf('id: recovery-validation'))
  assert.ok(uploadIndex > verificationIndex)
  assert.ok(enforcementIndex > uploadIndex)

  const verificationScript = workflow.match(
    /node --input-type=module <<'EOF'\n(?<script>[\s\S]*?)\n\s+EOF/u
  )?.groups?.script
  assert.ok(verificationScript)
  const emptyDirectory = await mkdtemp(resolve(tmpdir(), 'missing-release-ui-evidence-'))
  try {
    await assert.rejects(
      execFileAsync(process.execPath, ['--input-type=module', '--eval', verificationScript], {
        cwd: emptyDirectory
      }),
      /Missing or empty release UI validation evidence:/u
    )
  } finally {
    await rm(emptyDirectory, { recursive: true })
  }

  const missingRecoveryDirectory = await mkdtemp(
    resolve(tmpdir(), 'missing-release-recovery-evidence-')
  )
  try {
    for (const path of expectedPaths.filter(
      (path) => path !== 'recovery/evidence/corrupt-database-recovery-linux.png'
    )) {
      const file = resolve(missingRecoveryDirectory, 'release-validation', path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, 'evidence')
    }
    await assert.rejects(
      execFileAsync(process.execPath, ['--input-type=module', '--eval', verificationScript], {
        cwd: missingRecoveryDirectory
      }),
      /release-validation\/recovery\/evidence\/corrupt-database-recovery-linux\.png/u
    )
  } finally {
    await rm(missingRecoveryDirectory, { recursive: true })
  }
})
