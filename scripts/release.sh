#!/usr/bin/env bash
# Re-exec a private copy before parsing the release workflow. This prevents an
# editor or another process changing this file mid-run from creating a torn
# script (Bash reads shell scripts incrementally).
if [[ "${PI_USAGE_BARS_RELEASE_SNAPSHOT:-}" != "1" ]]; then
  SNAPSHOT=$(mktemp "${TMPDIR:-/tmp}/pi-usage-bars-release.XXXXXX")
  cp "$0" "$SNAPSHOT"
  if ! cmp -s "$0" "$SNAPSHOT"; then
    rm -f "$SNAPSHOT"
    echo "Release script changed while its execution snapshot was being created; retry the command." >&2
    exit 1
  fi
  chmod 700 "$SNAPSHOT"
  PI_USAGE_BARS_RELEASE_SNAPSHOT=1 \
    PI_USAGE_BARS_RELEASE_SNAPSHOT_FILE="$SNAPSHOT" \
    exec "$SNAPSHOT" "$@"
fi

set -euo pipefail

BUN_VERSION="1.3.14"
NPM_REGISTRY="https://registry.npmjs.org"
YES=false
PHASE="prepare"
TARGET=""
BUN_TMP=""

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <version> [prepare|stage|finalize] [--yes]

Examples:
  scripts/release.sh 0.4.1            # default: version, test, commit, and push
  scripts/release.sh 0.4.1 stage      # submit to npm's staged-publishing queue
  scripts/release.sh 0.4.1 finalize   # tag after browser 2FA approval is live

The default deliberately stops before npm submission. `stage` never publishes
live; it submits for review. Approve the staged package in npm's browser UI
with 2FA, then run `finalize` to verify the live registry and create the tag.
Neither command starts browser login or waits for browser approval.
EOF
}

for arg in "$@"; do
  case "$arg" in
    prepare|stage|finalize) PHASE="$arg" ;;
    --yes|-y) YES=true ;;
    --help|-h) usage; exit 0 ;;
    *)
      if [[ -z "$TARGET" ]]; then TARGET="$arg"
      else echo "Unexpected argument: $arg" >&2; usage >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$TARGET" || ! "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "A stable semantic version such as 0.4.1 is required." >&2
  usage >&2
  exit 2
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Run this inside the pi-usage-bars Git repository." >&2
  exit 1
}
cd "$ROOT"

PACKAGE=$(node -p "require('./package.json').name")
[[ "$PACKAGE" == "@hk_net/pi-usage-bars" ]] || {
  echo "Unexpected package name: $PACKAGE" >&2
  exit 1
}
TAG="v$TARGET"

cleanup() {
  [[ -z "$BUN_TMP" ]] || rm -rf "$BUN_TMP"
  [[ -z "${PI_USAGE_BARS_RELEASE_SNAPSHOT_FILE:-}" ]] || rm -f "$PI_USAGE_BARS_RELEASE_SNAPSHOT_FILE"
}
trap cleanup EXIT

confirm() {
  local prompt=$1
  if $YES; then return 0; fi
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

ensure_main() {
  local branch
  branch=$(git branch --show-current)
  [[ "$branch" == "main" ]] || {
    echo "Release must run on main (currently: ${branch:-detached HEAD})." >&2
    exit 1
  }
}

ensure_clean() {
  [[ -z "$(git status --porcelain)" ]] || {
    echo "Working tree is not clean:" >&2
    git status --short >&2
    exit 1
  }
}

fetch_and_measure() {
  git fetch --prune origin
  git rev-parse --verify '@{upstream}' >/dev/null
  read -r AHEAD BEHIND < <(git rev-list --left-right --count HEAD...'@{upstream}')
}

ensure_synced() {
  fetch_and_measure
  if (( AHEAD != 0 || BEHIND != 0 )); then
    echo "main is not synchronized with @{upstream} (ahead=$AHEAD, behind=$BEHIND)." >&2
    exit 1
  fi
}

setup_bun() {
  if [[ -n "$BUN_TMP" ]]; then return; fi

  local os arch bun_package tarball
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) echo "Unsupported OS for temporary Bun setup: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *) echo "Unsupported architecture for temporary Bun setup: $(uname -m)" >&2; exit 1 ;;
  esac

  bun_package="@oven/bun-${os}-${arch}"
  BUN_TMP=$(mktemp -d)
  tarball=$(npm pack "$bun_package@$BUN_VERSION" --pack-destination "$BUN_TMP" --silent | tail -n 1)
  tar -xzf "$BUN_TMP/$tarball" -C "$BUN_TMP"
  export PATH="$BUN_TMP/package/bin:$PATH"
  bun --version
}

run_checks() {
  npm ci --no-audit
  setup_bun
  npm run check

  # Show every finding and its dependency path. Development-only findings are
  # reported but do not block publication; the production gate below does.
  printf '\n=== Full dependency audit (informational; includes development dependencies) ===\n'
  local full_audit_status=0
  npm audit || full_audit_status=$?
  if (( full_audit_status != 0 )); then
    echo "Full audit reported findings. Review the details above; enforcing the production gate next."
  else
    echo "Full audit: no known vulnerabilities."
  fi

  printf '\n=== Production dependency audit (blocks high/critical findings) ===\n'
  npm audit --omit=dev --audit-level=high
  echo "Production dependency audit passed."
  npm run verify:tarball
  npm pack --dry-run
}

registry_has_target() {
  [[ "$(npm view "$PACKAGE@$TARGET" version --registry="$NPM_REGISTRY" 2>/dev/null || true)" == "$TARGET" ]]
}

version_is_greater() {
  node - "$1" "$2" <<'NODE'
const current = process.argv[2].split(".").map(Number);
const target = process.argv[3].split(".").map(Number);
for (let i = 0; i < 3; i++) {
  if (target[i] > current[i]) process.exit(0);
  if (target[i] < current[i]) process.exit(1);
}
process.exit(1);
NODE
}

prepare() {
  ensure_main
  ensure_clean
  fetch_and_measure
  if (( AHEAD != 0 )); then
    echo "Local main has unpushed commits; inspect and push them before releasing." >&2
    exit 1
  fi
  if (( BEHIND != 0 )); then
    git pull --ff-only origin main
  fi
  ensure_clean

  local current
  current=$(node -p "require('./package.json').version")
  if [[ "$current" == "$TARGET" ]] && grep -Fq "## [$TARGET]" CHANGELOG.md; then
    echo "Release $TARGET is already prepared; run the publish phase."
    return
  fi
  [[ "$current" != "$TARGET" ]] || {
    echo "package.json is already $TARGET but CHANGELOG.md is not prepared." >&2
    exit 1
  }
  version_is_greater "$current" "$TARGET" || {
    echo "Target version $TARGET must be greater than current version $current." >&2
    exit 1
  }
  ! registry_has_target || {
    echo "$PACKAGE@$TARGET is already published." >&2
    exit 1
  }
  ! git show-ref --verify --quiet "refs/tags/$TAG" || {
    echo "Tag $TAG already exists." >&2
    exit 1
  }

  echo "Preparing $PACKAGE $current -> $TARGET"
  confirm "Continue with release preparation?" || { echo "Cancelled."; exit 1; }

  npm version "$TARGET" --no-git-tag-version
  TARGET="$TARGET" RELEASE_DATE="$(date -u +%Y-%m-%d)" python3 <<'PY'
import os
from pathlib import Path

path = Path("CHANGELOG.md")
text = path.read_text()
marker = "## Unreleased"
if text.count(marker) != 1:
    raise SystemExit("CHANGELOG.md must contain exactly one '## Unreleased' heading")
start = text.index(marker) + len(marker)
next_release = text.find("\n## [", start)
body = text[start:next_release if next_release != -1 else len(text)].strip()
if not body:
    raise SystemExit("The Unreleased changelog section is empty")
replacement = f"{marker}\n\n## [{os.environ['TARGET']}] - {os.environ['RELEASE_DATE']}"
path.write_text(text.replace(marker, replacement, 1))
PY

  run_checks
  git diff --check
  git diff -- package.json package-lock.json CHANGELOG.md
  git add package.json package-lock.json CHANGELOG.md
  git commit -m "release: $TAG"

  fetch_and_measure
  if (( BEHIND != 0 )); then
    echo "origin/main changed during preparation; rebase and rerun checks before pushing." >&2
    exit 1
  fi
  git push origin main
  echo "Prepared and pushed $TAG source."
}

verify_or_create_tag() {
  git fetch --prune origin --tags
  if git show-ref --verify --quiet "refs/tags/$TAG"; then
    local tagged
    tagged=$(git rev-list -n 1 "$TAG")
    [[ "$tagged" == "$(git rev-parse HEAD)" ]] || {
      echo "Existing tag $TAG does not point to HEAD." >&2
      exit 1
    }
    echo "Tag $TAG already points to HEAD."
    return
  fi
  git tag -a "$TAG" -m "Release $TAG"
  git push origin "$TAG"
}

verify_release_source() {
  local current
  current=$(node -p "require('./package.json').version")
  [[ "$current" == "$TARGET" ]] || {
    echo "package.json is $current, not requested version $TARGET." >&2
    exit 1
  }
  grep -Fq "## [$TARGET]" CHANGELOG.md || {
    echo "CHANGELOG.md has no $TARGET release heading." >&2
    exit 1
  }
}

stage_release() {
  ensure_main
  ensure_clean
  ensure_synced
  verify_release_source
  registry_has_target && {
    echo "$PACKAGE@$TARGET is already live; run finalize to verify and tag it." >&2
    exit 1
  }
  npm whoami --registry="$NPM_REGISTRY" >/dev/null 2>&1 || {
    echo "Not authenticated to npm. Run npm login --auth-type=web first." >&2
    exit 1
  }

  # npm stage publish runs prepublishOnly; provide the same temporary Bun
  # binary used by preparation so the hook can execute the Bun test suite.
  setup_bun
  npm stage publish --access public --provenance=false --registry="$NPM_REGISTRY"
  printf '\n%s@%s is staged, not live.\n' "$PACKAGE" "$TARGET"
  echo "Review and approve it with 2FA in npmjs.com → Staged Packages."
  echo "After it is live, run: scripts/release.sh $TARGET finalize"
}

finalize_release() {
  ensure_main
  ensure_clean
  ensure_synced
  verify_release_source
  registry_has_target || {
    echo "$PACKAGE@$TARGET is not live yet. Approve it in npmjs.com → Staged Packages, then retry finalize." >&2
    exit 1
  }

  npm view "$PACKAGE" version dist-tags.latest --registry="$NPM_REGISTRY"
  npm view "$PACKAGE@$TARGET" dist.integrity --registry="$NPM_REGISTRY"
  verify_or_create_tag
  echo "Released $PACKAGE@$TARGET and tagged $TAG."
}

case "$PHASE" in
  prepare) prepare ;;
  stage) stage_release ;;
  finalize) finalize_release ;;
esac
