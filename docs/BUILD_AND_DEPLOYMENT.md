# Vellum Native 本地编译、跨平台打包与服务端生产部署指南

> **适用工程版本**：`vellum-native v0.1.0`（Rust Edition 2024）  
> **关联架构文档**：[[Rust + Axum + GPUI 高性能架构白皮书]] · [[Ropey 零拷贝文本树原理]] · [[CRDT 多端协同与增量同步设计]]

本文档提供 **Vellum Native** 工程中两个核心可执行程序的完整本地编译、跨平台打包与生产环境部署方案：

1. **`vellum`（包名 `vellum-gpui`）**：纯 Rust + Zed GPUI 原生 GPU 加速本地所见即所得（WYSIWYG）桌面客户端（零 WebView、零 Chromium、零 Electron）。内置本地 `127.0.0.1:4120` 守护线程，单二进制开箱即用。
2. **`vellum-server`（包名 `vellum-server`）**：基于 Axum 0.8 + Tokio 的高性能独立无头（Headless）后端服务。可在无图形界面的 Linux 云服务器或 Docker 容器中独立编译和运行，完全不依赖任何 GUI / Vulkan / Wayland 库。

---

## 1. 工程目录与构建产物结构

```text
vellum-native/
├── Cargo.toml                        # Workspace 根配置 (Edition 2024, Thin LTO, strip symbols)
├── README.md                         # 项目总览与快速上手说明
├── docs/
│   ├── BUILD_AND_DEPLOYMENT.md       # 本文档：本地编译、桌面打包与服务端生产部署手册
│   └── ARCHITECTURE_AND_API.md       # 内核架构原理与 Axum RESTful API 完整接口规范
├── scripts/
│   └── install-linux-deps.sh         # Linux (Debian/Ubuntu/Fedora/Arch) 桌面端依赖一键安装脚本
├── deploy/
│   ├── Dockerfile                    # vellum-server 多阶段最小化容器构建文件（内置中文字体）
│   ├── docker-compose.yml            # vellum-server 生产级容器编排与持久化卷配置
│   └── vellum-server.service         # Linux systemd 生产守护进程单元文件
└── crates/
    ├── vellum-core/                  # 核心文档引擎库 (Ropey + SIMD AST + 双链图 + 看板 + krilla PDF)
    ├── vellum-server/                # Axum 0.8 后端服务 (产出二进制：target/release/vellum-server)
    └── vellum-gpui/                  # GPUI 0.2.2 桌面应用 (产出二进制：target/release/vellum)
```

| Cargo 包名 (`-p`) | 可执行二进制名 | 图形界面依赖 | 典型部署形态 |
| :--- | :--- | :---: | :--- |
| `vellum-core` | 库（`rlib`） | 无 | 被桌面端与服务端静态链接复用 |
| `vellum-gpui` | `vellum`（Windows 为 `vellum.exe`） | Metal / Vulkan / DirectX 12 | 个人电脑原生桌面安装（macOS / Linux / Windows） |
| `vellum-server` | `vellum-server` | **完全无 GUI 依赖** | 无头 Linux 云服务器、Docker 容器、私有化 NAS 节点 |

---

## 2. 编译前置环境准备

### 2.1 Rust 工具链要求（必须 >= 1.85.0）

本项目启用了 **Rust Edition 2024**，编译器版本需为 `1.85.0` 或以上：

```bash
# 若尚未安装 Rust，使用官方 rustup 安装：
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# 升级至最新 stable 工具链并验证版本：
rustup update stable
rustc -V    # 确认输出 >= 1.85.0
cargo -V
```

### 2.2 各操作系统编译依赖

#### A. Linux 桌面环境（编译 `vellum-gpui` 桌面客户端）
`gpui 0.2.2` 在 Linux 上通过 **Vulkan (Blade)** 进行 GPU 硬件光栅化渲染，原生支持 **Wayland** 与 **X11** 窗口协议；本项目中的文件选择框库 `rfd` 已专门配置为纯 Rust 的 `xdg-portal` 后端（规避了 `libgtk-3-dev` 头文件依赖与 GTK 主事件循环死锁）。

直接执行项目内置的一键安装脚本（自动识别 `apt` / `dnf` / `pacman`）：
```bash
chmod +x scripts/install-linux-deps.sh
./scripts/install-linux-deps.sh
```

若使用其他发行版，手动对照安装以下开发包：
- **Ubuntu / Debian**：
  ```bash
  sudo apt-get update && sudo apt-get install -y \
      build-essential pkg-config libssl-dev \
      libvulkan1 libvulkan-dev mesa-vulkan-drivers vulkan-tools \
      libfontconfig1-dev libfreetype6-dev \
      libxkbcommon-dev libxkbcommon-x11-dev \
      libwayland-dev libx11-xcb-dev libxcursor-dev libxi-dev \
      libxcb1-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev \
      xdg-desktop-portal fonts-noto-cjk fonts-wqy-zenhei
  ```
- **Fedora / RHEL / Rocky Linux**：
  ```bash
  sudo dnf install -y gcc gcc-c++ make pkg-config openssl-devel \
      fontconfig-devel freetype-devel libxkbcommon-devel libxkbcommon-x11-devel \
      wayland-devel libXcursor-devel libXi-devel libxcb-devel \
      vulkan-loader vulkan-loader-devel mesa-vulkan-drivers vulkan-tools \
      xdg-desktop-portal google-noto-sans-cjk-ttc-fonts
  ```
- **Arch Linux**：
  ```bash
  sudo pacman -S --needed base-devel pkgconf openssl fontconfig freetype2 \
      libxkbcommon libxkbcommon-x11 wayland libxcursor libxi libxcb \
      vulkan-icd-loader vulkan-headers mesa vulkan-tools \
      xdg-desktop-portal noto-fonts-cjk
  ```

#### B. Linux 无头服务器（仅编译 `vellum-server` 后端）
在云服务器（阿里云 ECS、腾讯云 CVM、AWS EC2 等无桌面 Linux 主机）上编译 `vellum-server` 时，**完全不需要安装 Wayland / X11 / Vulkan 库**：
```bash
# Ubuntu / Debian 无头服务器最小依赖：
sudo apt-get update && sudo apt-get install -y \
    build-essential pkg-config libssl-dev fonts-wqy-zenhei
```
> [!NOTE]
> 安装 `fonts-wqy-zenhei`（或 `fonts-noto-cjk`）是为了让服务端 `POST /api/v1/documents/{id}/export-pdf` 接口在调用纯 Rust `krilla` 引擎生成正式公文/白皮书矢量 PDF 时，能够扫描并子集化内嵌中文字形。

#### C. macOS（Apple Silicon M1–M4 / Intel）
macOS 原生自带 **Metal** 图形框架与 **CoreText** 字体引擎（以及系统宋体 `Songti.ttc`、苹方 `PingFang.ttc`），仅需安装 Xcode 命令行工具：
```bash
xcode-select --install
```

#### D. Windows 10 / 11（x86_64 / ARM64）
Windows 原生使用 **DirectX 12** 与 **DirectWrite**（自带宋体 `simsun.ttc` 与微软雅黑 `msyh.ttc`）：
1. 安装 **Visual Studio 2022 Build Tools**，勾选工作负载 **「使用 C++ 的桌面开发」** 及 **Windows 10/11 SDK**。
2. 安装 `rustup-init.exe`（默认选择 `x86_64-pc-windows-msvc` 工具链）。

### 2.3 增量编译链接加速（强烈推荐）
`gpui` 首次全量编译涉及较多图形着色器与系统绑定，在 Linux 下配置 `mold`（或 `lld`）可将二次编译链接耗时从十余秒缩短至 1～2 秒：
```bash
# Ubuntu 22.04+ / Debian 12+ 安装 mold：
sudo apt-get install -y mold clang

# 写入 ~/.cargo/config.toml：
mkdir -p ~/.cargo
cat << 'EOF' >> ~/.cargo/config.toml
[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold"]
EOF
```

---

## 3. 编译与本地验证步骤

根 `Cargo.toml` 已针对 `[profile.release]` 配置了生产级编译参数（`opt-level = 3`、`lto = "thin"`、`codegen-units = 1`、`panic = "abort"`、`strip = "symbols"`）。

### 3.1 第一步：运行 `vellum-core` 核心单测与性能基准验证
无需启动图形窗口，即可验证零拷贝往返保真、两段式输入规则撤销、十万字 Fenwick 视口虚拟化、双链重命名重构、看板单字节翻转与正式版式矢量 PDF 导出：
```bash
cargo test -p vellum-core -- --nocapture
```

### 3.2 第二步：编译程序一 —— 原生桌面客户端 `vellum-gpui`
```bash
cargo build --release -p vellum-gpui
```
- 编译完成后产物位于：`./target/release/vellum`（Windows 为 `.\target\release\vellum.exe`）。
- 本地启动验证：
  ```bash
  # 启动默认工作区（自动在 ./workspace-docs 创建本地笔记库并拉起内嵌 127.0.0.1:4120 服务）：
  ./target/release/vellum

  # 直接流式加载指定本地超大 Markdown 文件（64 KiB 分块流式构建 Rope）：
  ./target/release/vellum ./docs/ARCHITECTURE_AND_API.md
  ```

### 3.3 第三步：编译程序二 —— 独立 Axum 后端服务 `vellum-server`
```bash
cargo build --release -p vellum-server
```
- 编译完成后产物位于：`./target/release/vellum-server`。
- 本地启动与接口验证：
  ```bash
  VELLUM_HOST=127.0.0.1 \
  VELLUM_PORT=4120 \
  VELLUM_WORKSPACE=./workspace-docs \
  ./target/release/vellum-server
  ```
  另开一个终端窗口测试健康检查与正式 PDF 导出接口：
  ```bash
  # 1. 检查内核状态
  curl -s http://127.0.0.1:4120/api/v1/health | jq .

  # 2. 查看工作区文档列表
  curl -s http://127.0.0.1:4120/api/v1/documents | jq .

  # 3. 将指定文档导出为正式技术规范版式 PDF
  curl -X POST http://127.0.0.1:4120/api/v1/documents/build-and-deployment/export-pdf \
    -H "Content-Type: application/json" \
    -d '{"preset":"technical_spec","paper_size":"a4","margin_mm":25.4,"include_cover_meta":true,"include_toc":true,"auto_number_headings":true,"include_header_footer":true}' \
    --output formal-guide.pdf
  ```

---

## 4. 桌面客户端（`vellum`）跨平台打包与本地安装

### 4.1 Linux 系统级安装与 `.desktop` 文件关联
```bash
# 1. 安装可执行文件到 /usr/local/bin
sudo install -Dm755 ./target/release/vellum /usr/local/bin/vellum

# 2. 注册 XDG 桌面启动器与 Markdown 文件关联
mkdir -p ~/.local/share/applications
cat << 'EOF' > ~/.local/share/applications/dev.vellum.markdown.desktop
[Desktop Entry]
Version=1.0
Type=Application
Name=Vellum Native
GenericName=Markdown Editor
Comment=High-performance local-first WYSIWYG Markdown Editor (Rust + GPUI)
Exec=/usr/local/bin/vellum %F
Terminal=false
Categories=Office;TextEditor;Utility;Development;
MimeType=text/markdown;text/x-markdown;text/plain;
StartupWMClass=dev.vellum.markdown
Keywords=Markdown;WYSIWYG;KnowledgeGraph;Kanban;
EOF

update-desktop-database ~/.local/share/applications || true
```

### 4.2 macOS 封装标准 `Vellum.app` 应用包
在 macOS 上可将编译好的 `vellum` 封装为原生 `.app` Bundle 并放入 `/Applications`：
```bash
APP_DIR="target/release/bundle/Vellum.app"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp ./target/release/vellum "$APP_DIR/Contents/MacOS/vellum"

cat << 'EOF' > "$APP_DIR/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>vellum</string>
    <key>CFBundleIdentifier</key>
    <string>dev.vellum.markdown</string>
    <key>CFBundleName</key>
    <string>Vellum</string>
    <key>CFBundleDisplayName</key>
    <string>Vellum Native</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

# 本地自签名后移入应用程序目录：
codesign --force --deep --sign - "$APP_DIR"
cp -R "$APP_DIR" /Applications/
```

> **构建 macOS 通用二进制（Universal Binary，同时支持 Apple Silicon 与 Intel）**：
> ```bash
> rustup target add aarch64-apple-darwin x86_64-apple-darwin
> cargo build --release -p vellum-gpui --target aarch64-apple-darwin
> cargo build --release -p vellum-gpui --target x86_64-apple-darwin
> lipo -create \
>   target/aarch64-apple-darwin/release/vellum \
>   target/x86_64-apple-darwin/release/vellum \
>   -output target/release/vellum-universal
> ```

### 4.3 Windows 独立便携包分发
`target\release\vellum.exe` 已通过 MSVC 静态/系统运行时链接 DirectX 12 与 DirectWrite，可直接将单文件 `vellum.exe` 放入任意目录（如 `C:\Program Files\Vellum\vellum.exe`）创建桌面快捷方式运行，无需附带 Chromium / WebView2 运行时。

---

## 5. 服务端（`vellum-server`）生产部署方案

当您需要构建团队共享知识图谱服务端、私有云实时备份节点或远程无头 PDF 排版服务时，可独立部署 `vellum-server`。

### 5.1 方案一：Docker / Docker Compose 容器化部署（推荐）

工程 `deploy/` 目录已内置 `Dockerfile` 与 `docker-compose.yml`：
- 构建阶段基于 `rust:1.85-bookworm` 仅编译 `-p vellum-server`；
- 运行阶段基于极简 `debian:bookworm-slim`，仅包含二进制本体、CA 证书与 `fonts-wqy-zenhei` 矢量中文字库，运行时内存常驻仅约 **12～25 MB**。

#### 使用 Docker Compose 一键启动：
```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

#### 或使用原生 `docker` 命令构建并启动：
```bash
docker build -f deploy/Dockerfile -t vellum-server:0.1.0 .

docker run -d \
  --name vellum-server \
  --restart unless-stopped \
  -p 127.0.0.1:4120:4120 \
  -e VELLUM_HOST=0.0.0.0 \
  -e VELLUM_PORT=4120 \
  -e VELLUM_WORKSPACE=/data/workspace-docs \
  -e RUST_LOG=vellum_server=info,tower_http=info \
  -v /srv/vellum/workspace-docs:/data/workspace-docs \
  vellum-server:0.1.0
```

### 5.2 方案二：Linux 原生 `systemd` 守护进程部署

1. **创建专用低权限系统账户与持久化目录**：
   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin vellum || true
   sudo install -Dm755 ./target/release/vellum-server /usr/local/bin/vellum-server
   sudo mkdir -p /var/lib/vellum/workspace-docs /opt/vellum
   sudo chown -R vellum:vellum /var/lib/vellum /opt/vellum
   ```
2. **安装并启用 `systemd` 服务单元**：
   ```bash
   sudo cp deploy/vellum-server.service /etc/systemd/system/vellum-server.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now vellum-server
   sudo systemctl status vellum-server
   ```
3. **查看实时结构化日志**：
   ```bash
   sudo journalctl -u vellum-server -f
   ```

### 5.3 配置 HTTPS 反向代理（Caddy / Nginx）

生产环境强烈建议将 `vellum-server` 绑定在回环地址（`VELLUM_HOST=127.0.0.1`），由前置 Caddy 或 Nginx 负责 TLS 1.3 加密终止与大附件上传限流。

#### Caddy 配置示例（`/etc/caddy/Caddyfile`，自动申请 Let's Encrypt 证书）：
```caddyfile
vellum.your-domain.com {
    encode zstd gzip
    request_body {
        max_size 50MB
    }
    reverse_proxy 127.0.0.1:4120
}
```

#### Nginx 配置示例（`/etc/nginx/conf.d/vellum.conf`）：
```nginx
server {
    listen 443 ssl http2;
    server_name vellum.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/vellum.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vellum.your-domain.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass         http://127.0.0.1:4120;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # 为 Phase 2 Yrs CRDT WebSocket 实时协同预留 Upgrade 头：
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
    }
}
```

---

## 6. 环境变量与运维排障手册

### 6.1 环境变量完整清单

| 变量名 | 默认值 | 适用范围 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `VELLUM_WORKSPACE` | `./workspace-docs` | `vellum` / `vellum-server` | 本地 `.md` 原文、`assets/` 图片内容寻址存储目录 |
| `VELLUM_HOST` | `127.0.0.1` | `vellum-server` | 监听网卡地址；Docker 容器内或局域网直连时须设为 `0.0.0.0` |
| `VELLUM_PORT` | `4120` | `vellum-server` | Axum HTTP API 服务监听端口 |
| `RUST_LOG` | `vellum=info,vellum_server=info` | 两者通用 | `tracing` 日志过滤表达式（排障时可设为 `debug`） |

### 6.2 数据备份与防损坏机制
- **纯文本开放格式**：所有文档均以标准 UTF-8 `.md` 纯文本文件存储在 `VELLUM_WORKSPACE` 目录下，图片经 `BLAKE3` 哈希去重后存放在 `VELLUM_WORKSPACE/assets/`，完全无私有数据库锁定，可直接配合 `git`、`restic` 或 `rsync` 定时增量备份。
- **POSIX 原子落盘保护**：无论桌面端还是服务端保存文档，均严格先写入同目录隐藏临时文件 `.{id}.md.tmp`，刷盘成功后再调用原子 `rename` 覆盖目标 `.md`，即使断电或进程崩溃也绝不会产生半截损坏文件。

### 6.3 常见问题排查（FAQ）

1. **Linux 启动桌面端提示无法找到 Vulkan 设备（如在虚拟机或 WSL2 中）**
   - 运行 `vulkaninfo --summary` 检查驱动状态。
   - Ubuntu/Debian 请确认已安装 `mesa-vulkan-drivers`（WSL2 下会自动启用 DirectX12 桥接驱动 `dzn` 或软光栅回退 `llvmpipe`）。
2. **Linux 下 Fcitx5 / IBus 中文输入法候选框位置或不触发**
   - Wayland 会话（GNOME / KDE Plasma / Hyprland）原生通过 `text-input-v3` 协议支持中文组合输入；
   - X11 会话请确认环境变量已设置：`export XMODIFIERS=@im=fcitx`（或 `@im=ibus`）。
3. **Linux 桌面点击「打开本地文件 / 导出 PDF」未弹出系统文件框**
   - 本项目使用纯 Rust `xdg-portal` D-Bus 接口唤起系统原生文件选择器，请确保桌面环境已安装 `xdg-desktop-portal` 及其对应后端（如 `xdg-desktop-portal-gtk` 或 `xdg-desktop-portal-kde`）。
4. **最小化 Linux 容器导出 PDF 提示 `No system CJK TrueType/OpenType font found`**
   - 安装任意开源中文字体即可（例如 `apt-get install -y fonts-wqy-zenhei` 或 `fonts-noto-cjk`），无需重启编译。
5. **Linux 编译 `vellum-gpui` 遇到 `xattr-0.2.3: cannot find value ENOATTR in crate ::libc`**
   - **原因**：`gpui 0.2.2` 的间接依赖 `async-tar -> xattr 0.2.3` 引用了 `libc::ENOATTR`，而上游 `libc 0.2.190+` 在 Linux 平台正式移除了该已弃用常量（Linux 现统一使用 `ENODATA`）。
   - **解决**：根 `Cargo.toml` 现已默认锁定 `libc = "=0.2.189"`；若在旧版解压目录中编译，直接在工程根目录执行一行命令锁定 `Cargo.lock` 即可立即编过：
     ```bash
     cargo update -p libc --precise 0.2.189
     ```
6. **Linux 编译 `vellum-gpui` 遇到 `ashpd-0.11.1/src/desktop/secret.rs: x2.shutdown().await?` 参数不匹配 (`E0061` / `E0277`)**
   - **原因**：`gpui 0.2.2` 在 Linux 下基于 `smol / async-io` 运行时启用了 `ashpd/async-io`；若 `rfd` 同时开启了 `"tokio"` 特性，Cargo 特性合并会令 `ashpd 0.11` 同时激活互斥的 `tokio` 与 `async-io` 两个异步后端（导致 `async_net::unix::UnixStream` 被按 Tokio `AsyncWriteExt::shutdown()` 调用）。
   - **解决**：根 `Cargo.toml` 中的 `rfd` 必须使用 `"async-std"`（映射为 `ashpd/async-io`）而非 `"tokio"`：
     ```toml
     rfd = { version = "0.15", default-features = false, features = ["xdg-portal", "async-std"] }
     ```
