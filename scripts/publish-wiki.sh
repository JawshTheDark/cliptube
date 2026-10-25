#!/usr/bin/env bash
# Copies the wiki pages in docs/wiki, and the screenshots in docs/images, to the GitHub wiki of this repository.
#
#   scripts/publish-wiki.sh [owner/repo]
#
# The pages link to each other as Page.md so they also work when browsing docs/wiki on GitHub; the wiki copy
# drops the .md. The Wiki tab must be on (repository Settings, Features, Wikis), and GitHub only accepts pushes
# once the wiki has a first page, so create any page on github.com before the first run. docs/wiki is the
# source: pages edited on github.com are replaced. WIKI_URL overrides where the wiki is pushed (for testing).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=${1:-$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')}
WIKI=${WIKI_URL:-https://github.com/$REPO.wiki.git}
COMMIT=$(git rev-parse --short HEAD)
NAME=$(git config user.name || true)
EMAIL=$(git config user.email || true)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! git clone -q "$WIKI" "$TMP/wiki" 2>/dev/null; then
  echo "Could not clone $WIKI." >&2
  echo "Turn on the wiki (Settings, Features, Wikis), create its first page on github.com, then run this again." >&2
  exit 1
fi

find "$TMP/wiki" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp docs/wiki/*.md "$TMP/wiki/"
mkdir -p "$TMP/wiki/images"
cp docs/images/* "$TMP/wiki/images/"
# Page.md -> Page, and ../images/ -> images/ (in Markdown links and in <img src>).
perl -pi -e 's/\]\(([A-Za-z0-9_-]+)\.md((?:#[^)]*)?)\)/]($1$2)/g; s#(\]\(|src=")\.\./images/#$1images/#g' "$TMP/wiki/"*.md

git -C "$TMP/wiki" -c core.autocrlf=false add -A
if git -C "$TMP/wiki" diff --cached --quiet; then
  echo "The wiki is already up to date."
  exit 0
fi
git -C "$TMP/wiki" -c user.name="${NAME:-ClipTube}" -c user.email="${EMAIL:-wiki@localhost}" \
  commit -q -m "Update from docs/wiki at $COMMIT"
git -C "$TMP/wiki" push -q
echo "Published docs/wiki to $WIKI"
