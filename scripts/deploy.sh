#!/usr/bin/env bash
# Deploys the committed code (git HEAD) to one or more Docker hosts over SSH.
#
#   scripts/deploy.sh jawsh@192.168.1.97 ircso
#
# For each host: backs up the database, tags the running image for rollback, copies the code,
# rebuilds and restarts the container, and waits for the health check.
# Expects the app in ~/cliptube on the host with the docker-compose.yml from this repo.
#
# Roll back on a host with:
#   docker tag cliptube:rollback cliptube:latest && docker compose up -d --no-build
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
  echo "usage: scripts/deploy.sh <ssh-host> [<ssh-host> ...]" >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "warning: you have uncommitted changes; only committed code (HEAD) is deployed" >&2
fi

VERSION=$(node -p "require('./package.json').version")
COMMIT=$(git rev-parse --short HEAD)
STAMP=$(date -u +%Y%m%d-%H%M%S)

for HOST in "$@"; do
  echo "==> $HOST: deploying v$VERSION ($COMMIT)"

  ssh -o BatchMode=yes "$HOST" "set -e
    cd ~/cliptube
    mkdir -p data/backups
    if docker ps --format '{{.Names}}' | grep -qx cliptube; then
      docker exec cliptube node -e \"const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/cliptube.db').exec(\\\"VACUUM INTO '/data/backups/pre-deploy-$STAMP.db'\\\")\"
      echo '    database backed up to data/backups/pre-deploy-$STAMP.db'
      docker tag cliptube:latest cliptube:rollback
      echo '    previous image tagged cliptube:rollback'
    fi
    ls -1t data/backups/pre-deploy-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f"

  git archive --format=tar HEAD | ssh -o BatchMode=yes "$HOST" 'tar -x -C ~/cliptube'

  ssh -o BatchMode=yes "$HOST" "set -e
    cd ~/cliptube
    docker compose up -d --build 2>&1 | grep -E 'Container cliptube|ERROR|error' || true
    for i in \$(seq 1 60); do
      s=\$(docker inspect -f '{{.State.Health.Status}}' cliptube 2>/dev/null || echo missing)
      [ \"\$s\" = healthy ] && break
      sleep 2
    done
    echo \"    container: \$(docker ps --filter name=cliptube --format '{{.Status}}')\"
    docker exec cliptube node -e \"fetch('http://127.0.0.1:3000/api/site').then(r=>r.json()).then(j=>console.log('    site:', j.site_name, '| network:', (j.network&&j.network.role)||'off'))\"
    docker logs --since 2m cliptube 2>&1 | grep -E '\\[db\\]|Error|error' | tail -5 | sed 's/^/    log: /' || true"
  echo "==> $HOST: done"
done
