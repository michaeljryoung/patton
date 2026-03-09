#!/usr/bin/env bash
set -euo pipefail

# Patton Release Script (manual fallback)
#
# The primary release mechanism is GitHub Actions (release.yml),
# which runs automatically on every push to main.
#
# This script is a manual fallback for local releases:
#   npm run release              # auto-detect bump type
#   npm run release -- patch     # force patch
#   npm run release -- minor     # force minor
#   npm run release -- major     # force major

BUMP_TYPE="${1:-auto}"

if [[ ! "$BUMP_TYPE" =~ ^(auto|patch|minor|major)$ ]]; then
  echo "Usage: npm run release [-- patch|minor|major]"
  echo "  No argument = auto-detect from change size"
  exit 1
fi

# Check for required tools
for cmd in gh npm git shasum; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not found in PATH"
    exit 1
  fi
done

# Must be on main branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: Must be on 'main' branch (currently on '$BRANCH')"
  exit 1
fi

# Must have clean working directory
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: Working directory is not clean. Commit or stash changes first."
  exit 1
fi

# Get last release tag (source of truth for version)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [[ -z "$LAST_TAG" ]]; then
  LAST_VERSION=$(node -p "require('./package.json').version")
  echo "No previous tag — using package.json version: $LAST_VERSION"
else
  LAST_VERSION="${LAST_TAG#v}"
  echo "Last tag: $LAST_TAG ($LAST_VERSION)"
fi

# Auto-detect bump type
if [[ "$BUMP_TYPE" == "auto" ]]; then
  if [[ -z "$LAST_TAG" ]]; then
    BUMP_TYPE="patch"
  else
    TOTAL=$(git diff --numstat "$LAST_TAG"..HEAD | awk '{s+=$1+$2} END {print s+0}')
    echo "Lines changed since $LAST_TAG: $TOTAL"
    if [[ "$TOTAL" -gt 500 ]]; then
      BUMP_TYPE="minor"
    else
      BUMP_TYPE="patch"
    fi
  fi
  echo "Auto-detected: $BUMP_TYPE"
fi

# Compute new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$LAST_VERSION"
case "$BUMP_TYPE" in
  major) NEW_VERSION="$((MAJOR+1)).0.0" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR+1)).0" ;;
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH+1))" ;;
esac

echo "Version: $LAST_VERSION -> $NEW_VERSION ($BUMP_TYPE)"

# Temporarily set version in package.json for the build
cp package.json package.json.bak
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version

# Build
echo "Building..."
if ! npm run package; then
  mv package.json.bak package.json
  echo "Build failed."
  exit 1
fi

echo "Creating DMG..."
if ! npm run make; then
  mv package.json.bak package.json
  echo "DMG creation failed."
  exit 1
fi

# Restore package.json (version lives in tags, not in source)
mv package.json.bak package.json

# Find the DMG
DMG_PATH=$(find out/make -name "*.dmg" -type f | head -1)
if [[ -z "$DMG_PATH" ]]; then
  echo "Error: No DMG found in out/make/"
  exit 1
fi

DMG_SHA256=$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')
DMG_NAME=$(basename "$DMG_PATH")
echo "DMG: $DMG_NAME"
echo "SHA-256: $DMG_SHA256"

# Create tag + push (no commit to main)
TAG="v$NEW_VERSION"
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"

# Create GitHub release
echo "Creating GitHub release..."
gh release create "$TAG" \
  "$DMG_PATH" \
  --title "Patton $TAG" \
  --notes "## Patton $TAG

### Checksums
| File | SHA-256 |
|------|---------|
| $DMG_NAME | \`$DMG_SHA256\` |"

echo ""
echo "Release $TAG published!"
echo "  https://github.com/michaeljryoung/patton/releases/tag/$TAG"
