#!/usr/bin/env bash
# Checks ClipTube against real fediverse software (GoToSocial, which speaks the Mastodon API, and PeerTube)
# in a private Docker sandbox on a host reachable over SSH. Nothing is exposed: the sandbox network is
# internal (no published ports, no internet), and Caddy issues the HTTPS certificates from its own local CA.
#
#   scripts/fediverse-sandbox.sh jawsh@192.168.1.97          # build this working tree, run the checks, clean up
#   scripts/fediverse-sandbox.sh jawsh@192.168.1.97 --keep   # leave the sandbox running for a look around
#
# Needs Docker with Compose on the host and about 3 GB of memory while it runs. The images it pulls stay
# cached on the host for the next run. Exit code: 0 when every check passed.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${1:?usage: scripts/fediverse-sandbox.sh <ssh-host> [--keep]}
KEEP=${2:-}
SSH="ssh -o BatchMode=yes $HOST"

echo "==> $HOST: copying the working tree"
$SSH 'rm -rf ~/cliptube-sandbox && mkdir -p ~/cliptube-sandbox/src'
git ls-files --cached --others --exclude-standard | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done |
  tar -cf - -T - | $SSH 'tar -xf - -C ~/cliptube-sandbox/src'

set +e
$SSH 'set -e
  cd ~/cliptube-sandbox
  cp src/sandbox/docker-compose.yml src/sandbox/Caddyfile src/sandbox/check.mjs .
  echo "==> building cliptube:sandbox"
  docker build -q -t cliptube:sandbox src >/dev/null
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  echo "==> starting Caddy, ClipTube, GoToSocial and PeerTube"
  docker compose up -d >/dev/null 2>&1
  # GoToSocial makes accounts with its own CLI, against the running server once it has set itself up.
  echo "==> creating the GoToSocial test account"
  for i in $(seq 1 90); do docker compose logs gotosocial 2>&1 | grep -q "delivery workers" && break; sleep 2; done
  gts() { docker compose exec -T gotosocial /gotosocial/gotosocial "$@"; }
  if ! gts admin account create --username mona --email mona@sandbox.test --password Sandbox-Mona-Pass-58217-Tuba >/tmp/gts-create.log 2>&1; then
    grep -v "level=INFO" /tmp/gts-create.log | tail -5
    exit 1
  fi
  gts admin account confirm --username mona >/dev/null 2>&1 || true
  echo "==> running the checks"
  set +e
  docker compose run --rm -T driver
  status=$?
  mkdir -p logs
  for s in cliptube gotosocial peertube caddy; do docker compose logs --no-color "$s" > "logs/$s.log" 2>&1; done
  if [ "$status" -ne 0 ]; then
    echo "==> warnings and errors from the servers (full logs in ~/cliptube-sandbox/logs)"
    grep -h -i -E "error|warn|fail|reject|invalid|refus" logs/cliptube.log logs/gotosocial.log logs/peertube.log | tail -n 80
  fi
  exit $status'
STATUS=$?
set -e

if [ "$KEEP" = "--keep" ]; then
  echo "==> left running; clean up with: ssh $HOST 'cd ~/cliptube-sandbox && docker compose down -v'"
else
  echo "==> cleaning up"
  $SSH 'cd ~/cliptube-sandbox && docker compose down -v --remove-orphans >/dev/null 2>&1; docker image rm cliptube:sandbox >/dev/null 2>&1; cd ~ && rm -rf ~/cliptube-sandbox/src' || true
fi
exit $STATUS
