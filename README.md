# Vellum Native — 基于 Rust + GPUI + Axum 的高性能本地所见即所得 Markdown 编辑器

参考《Markdown 所见即所得（WYSIWYG）编辑器 PRD V1.0》构建的本地优先原生桌面编辑器与同步就绪后端工程。全面支持 **Linux (Wayland / X11 + Vulkan)**、**macOS (Metal)** 与 **Windows (DirectX)** 原生编译运行。

## 1. Workspace Crates 架构

```text
.
├── Cargo.toml                      # Rust Workspace 根配置 (Edition 2024, LTO Thin)
├── scripts/
│   └── install-linux-deps.sh       # Linux (Ubuntu/Debian/Fedora/Arch) 一键依赖安装脚本
└── crates/
    ├── vellum-core/                # 低内存文档内核 (ropey::Rope + pulldown-cmark SIMD + Fenwick 高度树 + KnowledgeGraph 双链图索引 + Kanban 单字节状态修改器 + krilla 正式文档矢量 PDF 排版引擎)
    ├── vellum-server/              # Axum 0.8 高性能 RESTful API 服务（含 /api/v1/graph、/kanban、/export-pdf 与双链重命名重构接口）
    └── vellum-gpui/                # Zed GPUI 0.2 纯原生 GPU 加速桌面客户端（零 WebView/DOM，含即时渲染画布、原生拖拽 KanbanBoardView、知识图谱与一键正式 PDF 导出）
```

## 2. Linux 下编译与运行指南

**完全支持 Linux 原生编译与运行！**  
`gpui 0.2.2` 在 Linux 上通过 **Vulkan (Blade)** 进行 GPU 硬件加速渲染，同时原生支持 **Wayland** 与 **X11** 窗口协议；本项目已将文件对话框库 `rfd` 配置为纯 Rust 的 `xdg-portal` 后端（避免 `libgtk-3-dev` 编译冲突与 GTK 主线程死锁），并为窗口设置了标准 Wayland `app_id`（`dev.vellum.markdown`）。

### 第一步：安装系统开发头文件与 Vulkan 驱动

直接运行项目自带的一键脚本（自动识别 Ubuntu/Debian `apt`、Fedora `dnf`、Arch `pacman`）：
```bash
chmod +x scripts/install-linux-deps.sh
./scripts/install-linux-deps.sh
```

<details>
<summary>手动安装参考（Ubuntu / Debian 示例）</summary>

```bash
sudo apt-get update && sudo apt-get install -y \
    build-essential pkg-config libssl-dev \
    libvulkan1 libvulkan-dev mesa-vulkan-drivers vulkan-tools \
    libfontconfig1-dev libfreetype6-dev \
    libxkbcommon-dev libxkbcommon-x11-dev \
    libwayland-dev libx11-xcb-dev libxcursor-dev libxi-dev \
    libxcb1-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev \
    xdg-desktop-portal fonts-noto-cjk
```
</details>

### 第二步：编译并运行

1. **运行内核单元测试（无需图形界面，无头 Linux 服务器亦可运行）**：
   ```bash
   cargo test -p vellum-core
   ```
2. **启动 GPUI 原生桌面编辑器（需桌面图形环境 Wayland 或 X11 + Vulkan）**：
   ```bash
   cargo run --release -p vellum-gpui
   # 或直接流式打开超大本地 Markdown 文件：
   cargo run --release -p vellum-gpui -- ./docs/large-100k.md
   ```
3. **在无头 Linux 服务器上独立运行 Axum 后端 API 服务**：
   ```bash
   VELLUM_PORT=4120 VELLUM_WORKSPACE=./workspace-docs cargo run --release -p vellum-server
   ```

### Linux 常见问题排查
- **WSL2 / 虚拟机中运行**：请确保安装了 `mesa-vulkan-drivers`（WSL2 下支持 `dzn` DirectX12-over-Vulkan 或 `llvmpipe` 软光栅回退），可通过 `vulkaninfo --summary` 验证 Vulkan 设备是否就绪。
- **中文输入法（Fcitx5 / IBus）**：Wayland 下推荐使用原生 `text-input-v3` 协议（GNOME / KDE Plasma / Hyprland 均内置支持）；X11 下确保环境变量 `XMODIFIERS=@im=fcitx`（或 `ibus`）已设置。
- **编译链接速度优化（可选）**：Linux 下安装 `mold` 或 `lld` 后，大型 Rust GUI 增量编译链接速度可提升 3–5 倍。
