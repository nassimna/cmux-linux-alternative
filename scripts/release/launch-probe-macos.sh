#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 EXECUTABLE [ARGUMENT ...]" >&2
  exit 64
fi
executable_directory=$(cd "$(dirname "$1")" && pwd -P)
executable="$executable_directory/$(basename "$1")"
shift
[[ -x $executable ]] || { echo "executable is missing: $executable" >&2; exit 1; }

scratch=$(mktemp -d)
export HOME="$scratch/home"
export TMPDIR="$scratch/tmp"
mkdir -p "$HOME/Library/Application Support" "$HOME/Library/Caches" "$HOME/Library/Logs" "$TMPDIR"
log="$scratch/application.log"
pid=''

descendants() {
  ps -axo pid=,ppid= | awk -v root="$1" '
    { pid[NR]=$1; parent[NR]=$2 }
    END {
      descendant[root]=1
      for (pass=1; pass<=NR; pass++)
        for (row=1; row<=NR; row++) if (descendant[parent[row]]) descendant[pid[row]]=1
      for (row=1; row<=NR; row++) if (descendant[pid[row]] && pid[row] != root) print pid[row]
    }'
}

cleanup() {
  if [[ -n $pid ]]; then
    descendants "$pid" | sort -rn | xargs kill -TERM 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    descendants "$pid" | sort -rn | xargs kill -KILL 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [[ ${PROBE_PASSED:-0} != 1 ]]; then cat "$log" >&2 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

"$executable" --disable-gpu "$@" >"$log" 2>&1 &
pid=$!

for _ in {1..60}; do
  kill -0 "$pid" 2>/dev/null || { echo 'packaged application exited before readiness' >&2; exit 1; }
  tree=$(ps -axo pid=,ppid=,command=)
  matches=$(awk -v root="$pid" '
    { pid[NR]=$1; parent[NR]=$2; command[NR]=$0 }
    END {
      descendant[root]=1
      for (pass=1; pass<=NR; pass++)
        for (row=1; row<=NR; row++) if (descendant[parent[row]]) descendant[pid[row]]=1
      for (row=1; row<=NR; row++) if (descendant[pid[row]]) {
        if (command[row] ~ /Contents\/Resources\/node-linux\/server\/dist\/bin\.mjs/) print "service " pid[row]
        if (command[row] ~ /--type=renderer/) print "renderer " pid[row]
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
