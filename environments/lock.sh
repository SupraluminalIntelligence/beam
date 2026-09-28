#!/usr/bin/env bash
# Re-solve an environment from base/environment.yml + <env>/environment.yml and write exact lockfiles
# for both architectures. Commit the result; the Dockerfile installs from the lock, not the yml.
#   ./lock.sh fea
set -euo pipefail
env=${1:?usage: ./lock.sh <environment>}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/$env/lock"
for arch in arm64 amd64; do
  docker run --rm --platform "linux/$arch" -v "$here:/src:ro" mambaorg/micromamba:2.9.0-ubuntu24.04 bash -c \
    "micromamba create -y -q -n lock -f /src/base/environment.yml -f /src/$env/environment.yml >/dev/null && micromamba env export -n lock --explicit --md5" \
    > "$here/$env/lock/linux-$arch.txt"
  echo "$env/lock/linux-$arch.txt: $(grep -c '^https' "$here/$env/lock/linux-$arch.txt") packages"
done
