#!/usr/bin/env bash
set -euo pipefail

echo "==> 检测 Linux 发行版并安装 GPUI (Wayland / X11 / Vulkan / Fontconfig) 编译依赖..."

if command -v apt-get >/dev/null 2>&1; then
    echo "[Debian / Ubuntu] 使用 apt 安装系统依赖..."
    sudo apt-get update
    sudo apt-get install -y \
        build-essential \
        pkg-config \
        libssl-dev \
        libvulkan1 \
        libvulkan-dev \
        mesa-vulkan-drivers \
        vulkan-tools \
        libfontconfig1-dev \
        libfreetype6-dev \
        libxkbcommon-dev \
        libxkbcommon-x11-dev \
        libwayland-dev \
        libx11-xcb-dev \
        libxcursor-dev \
        libxi-dev \
        libxcb1-dev \
        libxcb-render0-dev \
        libxcb-shape0-dev \
        libxcb-xfixes0-dev \
        xdg-desktop-portal \
        fonts-noto-cjk
elif command -v dnf >/dev/null 2>&1; then
    echo "[Fedora / RHEL] 使用 dnf 安装系统依赖..."
    sudo dnf install -y \
        gcc \
        gcc-c++ \
        make \
        pkg-config \
        openssl-devel \
        fontconfig-devel \
        freetype-devel \
        libxkbcommon-devel \
        libxkbcommon-x11-devel \
        wayland-devel \
        libXcursor-devel \
        libXi-devel \
        libxcb-devel \
        vulkan-loader \
        vulkan-loader-devel \
        mesa-vulkan-drivers \
        vulkan-tools \
        xdg-desktop-portal \
        google-noto-sans-cjk-ttc-fonts
elif command -v pacman >/dev/null 2>&1; then
    echo "[Arch Linux] 使用 pacman 安装系统依赖..."
    sudo pacman -S --needed --noconfirm \
        base-devel \
        pkgconf \
        openssl \
        fontconfig \
        freetype2 \
        libxkbcommon \
        libxkbcommon-x11 \
        wayland \
        libxcursor \
        libxi \
        libxcb \
        vulkan-icd-loader \
        vulkan-headers \
        mesa \
        vulkan-tools \
        xdg-desktop-portal \
        noto-fonts-cjk
else
    echo "未识别的包管理器，请手动安装 pkg-config, fontconfig, freetype2, libxkbcommon, libxkbcommon-x11, wayland, libxcb, vulkan-loader 开发库。"
    exit 1
fi

echo "==> 检查 Rust 工具链..."
if ! command -v cargo >/dev/null 2>&1; then
    echo "未检测到 cargo，正在通过 rustup 安装最新 stable 工具链..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
fi

rustc -V
cargo -V
echo "==> Linux 依赖配置完成！现在可执行：cargo run --release -p vellum-gpui"
