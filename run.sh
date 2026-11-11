#!/usr/bin/env bash
# Run collect.sh on a server and print its JSON. Works from any directory.
#
# Usage:  run.sh <server-folder>        e.g.  run.sh nl_vps
#
# The connection details come from <server-folder>/server.sh, the same
# one-line `ssh ...` script you use to log in, so they live in one place.
#
# Extra SSH options added here:
#   BatchMode=yes          never wait for a password prompt (fail instead) — the
#                          widget runs in the background where nobody can type.
#   ConnectTimeout=10      give up after 10 s if the server is unreachable.
#   LogLevel=ERROR         hide SSH warnings; Übersicht treats any stderr output
#                          as a failed run.
#   ControlMaster/Path/Persist
#                          keep one SSH connection open for 10 minutes and reuse
#                          it, so each refresh skips the slow login handshake.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="${1:-}"
CONN="$DIR/$SERVER/server.sh"

if [ -z "$SERVER" ] || [ ! -f "$CONN" ]; then
  echo "usage: run.sh <server-folder>   (needs <server-folder>/server.sh)" >&2
  exit 1
fi

# server.sh holds one line like:  ssh -p 2222 user@host
# Split it into words and drop the leading "ssh".
read -r -a words < "$CONN"
if [ "${words[0]:-}" != "ssh" ]; then
  echo "$CONN must contain a single 'ssh ...' command" >&2
  exit 1
fi
args=()
for w in "${words[@]:1}"; do
  [ "$w" = "-A" ] && continue   # agent forwarding: not needed to collect stats
  args+=("$w")
done

ssh -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    -o ControlMaster=auto \
    -o ControlPath="$HOME/.ssh/cm-%C" \
    -o ControlPersist=10m \
    "${args[@]}" 'bash -s' < "$DIR/collect.sh"
