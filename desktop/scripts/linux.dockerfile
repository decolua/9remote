FROM rust:1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    patchelf build-essential curl file libssl-dev libgtk-3-dev \
    desktop-file-utils fakeroot dpkg-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
# Install the CLI into the image: the host's node_modules holds macOS binaries.
# binstall fetches a prebuilt binary — compiling it here would be very slow under
# QEMU when cross-building the amd64 image on an arm64 host.
RUN curl -fsSL https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash \
    && cargo binstall -y --locked tauri-cli@^2
WORKDIR /app
