#!/usr/bin/env bash
# Tag and push the next NOVA version: v0.1.2, v0.1.3 ... v0.1.99, then v0.2.0, v0.2.1 ...
# Pushing the tag starts the Release workflow (image on ghcr.io, agents zip).
#   scripts/release.sh --dry             only print the next version
#   scripts/release.sh --confirm vX.Y.Z  tag and push after explicit approval
set -euo pipefail
cd "$(dirname "$0")/.."

latest=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)
latest=${latest:-v0.1.0}
IFS=. read -r major minor patch <<<"${latest#v}"
if [ "$patch" -ge 99 ]; then
  minor=$((minor + 1))
  patch=0
else
  patch=$((patch + 1))
fi
next="v${major}.${minor}.${patch}"
echo "latest ${latest} -> next ${next}"
notes="docs/release-notes/${next}.md"
case "${1:-}" in
  --dry) exit 0 ;;
  --confirm)
    [ "${2:-}" = "$next" ] || { echo "To push, explicitly confirm the exact next version: scripts/release.sh --confirm ${next}" >&2; exit 1; }
    ;;
  *) echo "No push performed. Use --dry, or --confirm ${next} after approval." >&2; exit 2 ;;
esac

[ -z "$(git status --porcelain)" ] || { echo "Working tree is not clean." >&2; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "Release from main only." >&2; exit 1; }
[ -z "$(git tag --list "$next")" ] || { echo "Tag ${next} already exists." >&2; exit 1; }
[ -s "$notes" ] || { echo "Release notes ontbreken: $notes" >&2; exit 1; }
git push origin main
git tag "$next"
git push origin "$next"
echo "Pushed ${next}."
