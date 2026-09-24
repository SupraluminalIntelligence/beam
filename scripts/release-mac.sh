#!/bin/sh
# Build, sign, (notarize when the "beam" notary profile exists), publish both architectures, write the update feed.
# Run from apps/desktop via `pnpm release` after bumping the version in package.json.
set -e
VERSION=$(node -p "require('./package.json').version")
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
GH_TOKEN=$(gh auth token) npx electron-builder --mac --arm64 --x64 --publish always $NOTARIZE
node ../../scripts/mac-feed.mjs "$VERSION"
gh release upload "v$VERSION" --repo SupraluminalIntelligence/beam-releases --clobber release/latest-mac.yml
node ../../scripts/verify-mac-release.mjs "$VERSION"
gh release edit "v$VERSION" --repo SupraluminalIntelligence/beam-releases --draft=false --latest
echo "released v$VERSION"
