#!/usr/bin/env bash
# Release NOVA: bump the version(s), build, commit, tag and push. Two independent streams:
#   nova     (default)  VERSION               tag vX.Y.Z          web, API, Docker image
#   windows             apps/windows/VERSION  tag windows-vX.Y.Z  Windows agent (signed installer)
#   both                one bump commit, both tags
#
#   scripts/release.sh [--dry] [nova|windows|both] [X.Y.Z|vX.Y.Z|next] ["commit message"]
#   scripts/release.sh --confirm <tag> [--confirm <tag>] [target] [version|next] ["message"]
#
# 'next' (default) = the stream's latest tag + 1; PATCH rolls into MINOR at 99 (0.1.99 -> 0.2.0).
# A stream without a tag yet releases its VERSION file as is (windows: windows-v0.1.0).
# Versions are unpadded semver (never 0.3.00: Cargo, npm and MSI reject padding). `both` only
# supports 'next'. Operator approval per version stays: every tag to push must be repeated
# with --confirm. An existing tag is never moved or pushed again. Pushing a tag starts the
# Release workflow (v*: ghcr.io image and compose assets; windows-v*: signed Windows installer).
# The stream's VERSION file is synced by scripts/version.mjs into its manifests BEFORE the
# build and the commit. Notes: docs/release-notes/<tag>.md must exist.
#   --skip-build   skip the sanity build (npm run build for nova, cargo check for windows)
set -euo pipefail
cd "$(dirname "$0")/.."

dry=0 skip_build=0 confirms=() positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry) dry=1 ;;
    --skip-build) skip_build=1 ;;
    --confirm) confirms+=("${2:-}"); shift ;;
    *) positional+=("$1") ;;
  esac
  shift
done
case "${positional[0]:-}" in
  nova|windows|both) target="${positional[0]}"; positional=("${positional[@]:1}") ;;
  *) target=nova ;;
esac
want="${positional[0]:-next}"
msg="${positional[1]:-}"
case "$target" in both) streams=(nova windows) ;; *) streams=("$target") ;; esac
if [ "$target" = both ] && [ "$want" != next ]; then
  echo "Target 'both' only supports 'next'." >&2; exit 1
fi

# Refresh tag history before selecting or validating a version for publication.
# Dry runs remain offline previews; the confirmed run always rechecks the remote.
if [ "$dry" != 1 ] && [ ${#confirms[@]} -gt 0 ]; then
  git fetch --tags --quiet origin
fi

declare -A version tag
for s in "${streams[@]}"; do
  prefix=$(node scripts/version.mjs prefix "$s")
  latest=$(git tag --list "${prefix}[0-9]*.[0-9]*.[0-9]*" | sort -V | tail -1)
  if [ "$want" = next ]; then
    if [ -n "$latest" ]; then
      v=$(node scripts/version.mjs next "$s" "$latest")
    else
      vf=VERSION; [ "$s" = windows ] && vf=apps/windows/VERSION
      v=$(tr -d '[:space:]' <"$vf" 2>/dev/null || true)
      v=${v:-0.1.0}
    fi
  else
    v="${want#v}"
    node scripts/version.mjs validate "$v"
    if [ -n "$latest" ]; then
      [ "$(printf '%s\n%s\n' "${latest#"$prefix"}" "$v" | sort -V | tail -1)" = "$v" ] && [ "${latest#"$prefix"}" != "$v" ] \
        || { echo "Version ${v} must be newer than ${latest}." >&2; exit 1; }
    fi
  fi
  version[$s]="$v"
  tag[$s]="${prefix}${v}"
  echo "${s}: latest ${latest:-none} -> next ${tag[$s]}"
done
[ -n "$msg" ] || msg="release: ${tag[*]}"

if [ "$dry" = 1 ]; then
  echo "Dry run: would sync VERSION files, build, commit '${msg}' and tag: ${tag[*]}."
  exit 0
fi
if [ ${#confirms[@]} -eq 0 ]; then
  echo "No push performed. Use --dry, or confirm after approval: $(for s in "${streams[@]}"; do printf -- '--confirm %s ' "${tag[$s]}"; done)" >&2
  exit 2
fi
for s in "${streams[@]}"; do
  ok=0
  for c in "${confirms[@]}"; do [ "$c" = "${tag[$s]}" ] && ok=1; done
  [ "$ok" = 1 ] || { echo "To release, explicitly confirm the exact tag: scripts/release.sh --confirm ${tag[$s]} ${target}" >&2; exit 1; }
done
[ ${#confirms[@]} -eq ${#streams[@]} ] || { echo "Confirm exactly the tags being released." >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || { echo "Working tree is not clean." >&2; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "Release from main only." >&2; exit 1; }
for s in "${streams[@]}"; do
  [ -z "$(git tag --list "${tag[$s]}")" ] || { echo "Tag ${tag[$s]} already exists." >&2; exit 1; }
  [ -s "docs/release-notes/${tag[$s]}.md" ] || { echo "Release notes ontbreken: docs/release-notes/${tag[$s]}.md" >&2; exit 1; }
done

# Write the versions first so the build and the tagged commit both carry them.
for s in "${streams[@]}"; do
  node scripts/version.mjs sync "$s" "${version[$s]}"
  node scripts/version.mjs check "$s"
  [ "$skip_build" = 1 ] && continue
  case "$s" in
    nova) NOVA_VERSION="${version[$s]}" npm run build ;;
    windows) (cd apps/windows && cargo check --locked -p nova-win-core -p nova-win-agent) ;;
  esac
done
# The tree was clean on entry, so everything pending is the version bump.
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$msg"
fi
git pull --rebase origin main
git push origin main
for s in "${streams[@]}"; do
  git tag -a "${tag[$s]}" -m "NOVA ${s} ${version[$s]}"
  git push origin "${tag[$s]}"
  echo "Pushed ${tag[$s]}."
done
[ -z "${tag[nova]:-}" ] || echo "The workflow publishes ghcr.io/hjongedijk/nova:${version[nova]}."
if command -v gh >/dev/null 2>&1; then
  for s in "${streams[@]}"; do
    echo "Waiting for the GitHub release ${tag[$s]} (Ctrl-C is safe; the workflow keeps running)..."
    for _ in $(seq 1 60); do
      gh release view "${tag[$s]}" >/dev/null 2>&1 && { echo "GitHub release ${tag[$s]} is published."; break; }
      sleep 20
    done
  done
fi
