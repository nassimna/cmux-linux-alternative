#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 EXECUTABLE [ARGUMENT ...]" >&2
  exit 64
fi
executable=$(realpath "$1")
shift
[[ -x $executable ]] || { echo "executable is missing: $executable" >&2; exit 1; }

wayland_runtime=''
if [[ -n ${WAYLAND_DISPLAY:-} ]]; then
  if [[ ${XDG_SESSION_TYPE:-} != wayland || -z ${XDG_RUNTIME_DIR:-} ]]; then
    echo 'Wayland launch requires XDG_SESSION_TYPE=wayland and XDG_RUNTIME_DIR' >&2
    exit 1
  fi
  if [[ ! $WAYLAND_DISPLAY =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo 'WAYLAND_DISPLAY must be a socket name without path separators' >&2
    exit 1
  fi
  if [[ -L $XDG_RUNTIME_DIR ]] || ! wayland_runtime=$(realpath -e "$XDG_RUNTIME_DIR") || [[ ! -d $wayland_runtime ]]; then
    echo 'Wayland XDG_RUNTIME_DIR must be an existing non-symlink directory' >&2
    exit 1
  fi
  read -r runtime_owner runtime_mode < <(stat -c '%u %a' "$wayland_runtime")
  if [[ $runtime_owner != "$(id -u)" || $runtime_mode != 700 ]]; then
    echo 'Wayland XDG_RUNTIME_DIR must be owned by the current user with mode 0700' >&2
    exit 1
  fi
  if [[ ! -S $wayland_runtime/$WAYLAND_DISPLAY ]]; then
    echo 'Wayland display socket is missing' >&2
    exit 1
  fi
fi

if [[ -z ${DISPLAY:-} && -z $wayland_runtime && -z ${AGENT_WORKSPACE_UNDER_XVFB:-} ]]; then
  exec env AGENT_WORKSPACE_UNDER_XVFB=1 xvfb-run -a "$0" "$executable" "$@"
fi

scratch=$(mktemp -d)
export HOME="$scratch/home"
export XDG_CONFIG_HOME="$scratch/config"
export XDG_CACHE_HOME="$scratch/cache"
export XDG_DATA_HOME="$scratch/data"
if [[ -n $wayland_runtime ]]; then
  export XDG_RUNTIME_DIR="$wayland_runtime"
else
  unset WAYLAND_DISPLAY
  export XDG_SESSION_TYPE=x11
  export XDG_RUNTIME_DIR="$scratch/runtime"
fi
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
if [[ -z $wayland_runtime ]]; then
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
fi
log="$scratch/application.log"
pid=''
cleanup() {
  if [[ -n $pid ]]; then
    kill -TERM "-$pid" 2>/dev/null || true
    for _ in {1..20}; do kill -0 "-$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [[ ${PROBE_PASSED:-0} != 1 ]]; then cat "$log" >&2 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

setsid "$executable" --no-sandbox --in-process-gpu "$@" >"$log" 2>&1 &
pid=$!

for _ in {1..60}; do
  kill -0 "$pid" 2>/dev/null || { echo 'packaged application exited before readiness' >&2; exit 1; }
  tree=$(ps -eo pid=,ppid=,args=)
  matches=$(awk -v root="$pid" '
    { pid[NR]=$1; parent[NR]=$2; args[NR]=$0 }
    END {
      descendant[root]=1
      for (pass=1; pass<=NR; pass++)
        for (row=1; row<=NR; row++) if (descendant[parent[row]]) descendant[pid[row]]=1
      for (row=1; row<=NR; row++) if (descendant[pid[row]]) {
        if (args[row] ~ /resources\/node-linux\/server\/dist\/bin\.mjs/) print "service " pid[row]
        if (args[row] ~ /--type=renderer/) print "renderer " pid[row]
      }
    }' <<<"$tree")
  service=$(awk '$1 == "service" { print $2 }' <<<"$matches")
  renderer=$(awk '$1 == "renderer" { print $2 }' <<<"$matches")
  if [[ -n $service && -n $renderer ]]; then
    PROBE_PASSED=1
    echo "packaged launch ready: main=$pid service=${service%%$'\n'*} renderer=${renderer%%$'\n'*}"
    exit 0
  fi
  sleep 0.5
done
echo 'timed out waiting for service and renderer readiness' >&2
exit 1
