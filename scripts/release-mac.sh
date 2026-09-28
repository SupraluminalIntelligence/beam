#!/bin/sh
# Build, sign, (notarize when the "beam" notary profile exists), publish both architectures, write the update feed.
# Run from apps/desktop via `pnpm release` after bumping the version in package.json.
set -e
VERSION=$(node -p "require('./package.json').version")
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit and merge release changes before building." >&2
  exit 1
fi
SOURCE_SHA=$(git rev-parse HEAD)
git fetch origin main
git merge-base --is-ancestor "$SOURCE_SHA" origin/main
if xcrun notarytool history --keychain-profile beam >/dev/null 2>&1; then
  echo "notary profile found: notarizing"
  export APPLE_KEYCHAIN_PROFILE=beam
  NOTARIZE="--config.mac.notarize=true"
else
  echo "no notary profile: signing only (run: xcrun notarytool store-credentials beam --apple-id <id> --team-id L4M75K683P)"
  NOTARIZE="--config.mac.notarize=false"
fi
# Create the draft once before parallel architecture uploads start.
if ! gh release view "v$VERSION" --repo SupraluminalIntelligence/beam-releases >/dev/null 2>&1; then
  gh release create "v$VERSION" --repo SupraluminalIntelligence/beam-releases --draft --title "Beam $VERSION" --notes ""
fi
if [ "$(gh release view "v$VERSION" --repo SupraluminalIntelligence/beam-releases --json isDraft --jq .isDraft)" != "true" ]; then
  echo "v$VERSION is already published. Bump the version; published releases are immutable." >&2
  exit 1
fi
GH_TOKEN=$(gh auth token) npx electron-builder --mac --arm64 --x64 --publish always $NOTARIZE
node ../../scripts/mac-feed.mjs "$VERSION"
gh release upload "v$VERSION" --repo SupraluminalIntelligence/beam-releases --clobber release/latest-mac.yml
node ../../scripts/verify-mac-release.mjs "$VERSION"
gh workflow run windows.yml --repo SupraluminalIntelligence/beam --ref main -f "release_version=$VERSION" -f "source_sha=$SOURCE_SHA"
echo "macOS assets verified in draft v$VERSION. Windows CI will test the upgrade, upload its assets, and publish the complete release."
