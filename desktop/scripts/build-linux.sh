#!/usr/bin/env bash
# Build the Linux bundles (.deb + .AppImage) inside a container.
# Tauri on Linux links against webkit2gtk/libayatana-appindicator, which only exist
# on Linux — so a macOS host has to cross-build through Docker.
#
# The container image is built on first run and cached afterwards.
#
# Pass --amd64 to cross-build for x86_64 on an arm64 host. That path produces the
# .deb only: AppImage packaging shells out to linuxdeploy, which cannot execute
# under QEMU emulation (it self-mounts via FUSE), so an x86_64 AppImage needs a
# real x86_64 Linux host.
set -euo pipefail

cd "$(dirname "$0")/.."

DOCKERFILE="scripts/linux.dockerfile"

if [ "${1:-}" = "--amd64" ]; then
  ARCH_SUFFIX="amd64"
  PLATFORM="--platform=linux/amd64"
  BUNDLES="deb"
else
  ARCH_SUFFIX="native"
  PLATFORM=""
  BUNDLES="deb,appimage"
fi
IMAGE="tauri-linux-$ARCH_SUFFIX"
OUT_DIR="src-tauri/target-linux/$ARCH_SUFFIX"

command -v docker >/dev/null || { echo "[Desktop] Docker is required to build for Linux"; exit 1; }
docker info >/dev/null 2>&1 || { echo "[Desktop] Docker daemon is not running"; exit 1; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[Desktop] Building $IMAGE image (first run only, takes a few minutes)"
  docker build $PLATFORM -f "$DOCKERFILE" -t "$IMAGE" scripts/
fi

# Cargo caches live in named volumes so repeat builds don't refetch every crate.
# Intermediate objects stay in a volume (they are Linux ELF and would clash with the
# host's macOS target dir), but the finished bundles are copied out to the host.
docker run --rm $PLATFORM \
  -v "$PWD:/app" \
  -v "9remote-cargo-$ARCH_SUFFIX:/usr/local/cargo/registry" \
  -v "9remote-linux-$ARCH_SUFFIX:/build" \
  -e CARGO_TARGET_DIR=/build \
  -w /app "$IMAGE" \
  sh -c "cargo tauri build --bundles $BUNDLES \
    && mkdir -p /app/$OUT_DIR \
    && cp -r /build/release/bundle/* /app/$OUT_DIR/"

echo "[Desktop] Bundles in desktop/$OUT_DIR/"

# Gather into desktop/release/ so all platforms land in one place
bash scripts/collect-artifacts.sh
