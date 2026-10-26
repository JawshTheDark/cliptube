#!/usr/bin/env bash
# Checks live streaming end to end, with the real MediaMTX, in a private Docker sandbox on a host reachable
# over SSH: OurTube built from this working tree, MediaMTX with live/mediamtx.yml, a test stream sent with
# ffmpeg, the HLS read back through OurTube, and the recording saved as a draft video. Nothing is published.
#
#   scripts/live-sandbox.sh user@docker-host          # build this working tree, run the checks, clean up
#   scripts/live-sandbox.sh user@docker-host --keep   # leave the sandbox running for a look around, in a
#                                                     # browser too: ssh -N -L 3320:127.0.0.1:3320 user@docker-host
#                                                     # and open http://localhost:3320
#
# Needs Docker with Compose on the host. Exit code: 0 when every check passed.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${1:?usage: scripts/live-sandbox.sh <ssh-host> [--keep]}
KEEP=${2:-}
SSH="ssh -o BatchMode=yes $HOST"
PEEK=""
if [ "$KEEP" = "--keep" ]; then PEEK="--profile peek"; fi

echo "==> $HOST: copying the working tree"
$SSH 'rm -rf ~/cliptube-live-sandbox && mkdir -p ~/cliptube-live-sandbox/src'
git ls-files --cached --others --exclude-standard | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done |
  tar -cf - -T - | $SSH 'tar -xf - -C ~/cliptube-live-sandbox/src'

set +e
$SSH "PEEK='$PEEK';"'set -e
  cd ~/cliptube-live-sandbox
  cp src/sandbox/live-compose.yml docker-compose.yml
  mkdir -p data/live
  echo "==> building cliptube:sandbox-live"
  docker build -q -t cliptube:sandbox-live src >/dev/null
  docker compose pull -q cliptube-live >/dev/null 2>&1 || true
  docker compose --profile peek down -v --remove-orphans >/dev/null 2>&1 || true
  echo "==> starting OurTube and MediaMTX"
  docker compose $PEEK up -d >/dev/null 2>&1
  echo "==> running the checks"
  set +e
  docker compose exec -T cliptube node --input-type=module - < src/sandbox/live-check.mjs
  status=$?
  mkdir -p logs
  for s in cliptube cliptube-live; do docker compose logs --no-color "$s" > "logs/$s.log" 2>&1; done
  if [ "$status" -ne 0 ]; then
    echo "==> warnings and errors (full logs in ~/cliptube-live-sandbox/logs)"
    grep -h -i -E "error|warn|fail|refus|denied" logs/cliptube.log logs/cliptube-live.log | tail -n 60
  fi
  exit $status'
STATUS=$?
set -e

if [ "$KEEP" = "--keep" ]; then
  echo "==> left running. In a browser: ssh -N -L 3320:127.0.0.1:3320 $HOST, then open http://localhost:3320"
  echo "    clean up with: ssh $HOST 'cd ~/cliptube-live-sandbox && docker compose --profile peek down -v'"
else
  echo "==> cleaning up"
  $SSH 'cd ~/cliptube-live-sandbox && docker compose --profile peek down -v --remove-orphans >/dev/null 2>&1; docker image rm cliptube:sandbox-live >/dev/null 2>&1; rm -rf ~/cliptube-live-sandbox-logs && mv logs ~/cliptube-live-sandbox-logs; cd ~ && rm -rf ~/cliptube-live-sandbox' || true
  echo "==> logs kept in ~/cliptube-live-sandbox-logs on $HOST"
fi
exit $STATUS
