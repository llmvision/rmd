# Vellum Native — 基于 Rust + GPUI + Axum 的高性能本地所见即所得 Markdown 编辑器

参考《Markdown 所见即所得（WYSIWYG）编辑器 PRD V1.0》构建的本地优先原生桌面编辑器与同步就绪后端工程。全面支持 **Linux (Wayland / X11 + Vulkan)**、**macOS (Metal)** 与 **Windows (DirectX 12)** 纯原生 GPU 编译运行（零 WebView、零 Electron、零 HTML DOM）。

---

## 1. 工程文档导航（源码内置完整手册）

- **[`docs/BUILD_AND_DEPLOYMENT.md`](docs/BUILD_AND_DEPLOYMENT.md)** —— **本地编译、跨平台打包与服务端生产部署完整指南**
  - 涵盖 Rust Edition 2024 环境配置、Linux/macOS/Windows 编译依赖、`vellum` 桌面端与 `vellum-server` 独立后端分别编译、`Vellum.app` / `.desktop` 封装、Docker Compose 容器化部署、`systemd` 守护进程与 Caddy/Nginx HTTPS 反向代理配置。
- **[`docs/ARCHITECTURE_AND_API.md`](docs/ARCHITECTURE_AND_API.md)** —— **核心架构原理与 Axum RESTful API 技术参考手册**
  - 涵盖 `ropey::Rope` 零拷贝缓冲、SIMD 增量块扫描、Fenwick 视口高度树、两段式输入规则撤销、`KnowledgeGraphIndex` 双向链接网络、原生拖拽看板单字节状态翻转、`krilla` 正式文档版式矢量 PDF 排版引擎及全部 `/api/v1/*` 接口契约。

---

## 2. Cargo Workspace 目录结构

```text
.
├── Cargo.toml                        # Rust Workspace 根配置 (Edition 2024, Thin LTO, strip symbols)
├── README.md                         # 项目总览与快速启动说明
├── docs/
│   ├── BUILD_AND_DEPLOYMENT.md       # 本地编译、跨平台打包与服务端部署完整手册
│   └── ARCHITECTURE_AND_API.md       # 内核架构原理与 RESTful API 完整技术规范
├── scripts/
│   └── install-linux-deps.sh         # Linux (Ubuntu/Debian/Fedora/Arch) 桌面编译依赖一键安装脚本
├── deploy/
│   ├── Dockerfile                    # vellum-server 多阶段最小化容器构建配置（含中文字体）
│   ├── docker-compose.yml            # vellum-server 容器编排与持久化卷配置
│   └── vellum-server.service         # Linux systemd 生产守护进程单元文件
└── crates/
    ├── vellum-core/                  # 低内存文档内核 (Ropey + SIMD AST + Fenwick 树 + 双链图 + 看板 + krilla 正式 PDF 引擎)
    ├── vellum-server/                # Axum 0.8 独立后端服务（产出二进制：vellum-server，无 GUI 依赖）
    └── vellum-gpui/                  # Zed GPUI 0.2.2 纯原生桌面客户端（产出二进制：vellum）
```

---

## 3. 三分钟快速编译与运行

### 3.1 环境准备（需 Rust >= 1.85.0）
```bash
rustup update stable

# 若在 Linux 桌面编译 vellum-gpui，先运行一键依赖脚本（macOS 仅需 xcode-select --install）：
chmod +x scripts/install-linux-deps.sh
./scripts/install-linux-deps.sh
```

### 3.2 运行内核单元测试
```bash
cargo test -p vellum-core
```

### 3.3 编译并启动两个核心程序

1. **程序一：GPUI 原生桌面客户端（`vellum-gpui` -> 二进制 `target/release/vellum`）**
   ```bash
   cargo build --release -p vellum-gpui
   ./target/release/vellum
   ```
2. **程序二：Axum 独立无头后端服务（`vellum-server` -> 二进制 `target/release/vellum-server`）**
   ```bash
   # 在无图形界面的 Linux 服务器上亦可直接编译运行，不会触发 gpui 编译：
   cargo build --release -p vellum-server
   VELLUM_HOST=0.0.0.0 VELLUM_PORT=4120 VELLUM_WORKSPACE=./workspace-docs ./target/release/vellum-server
   ```
3. **Docker Compose 一键部署服务端**
   ```bash
   docker compose -f deploy/docker-compose.yml up -d --build
   ```

详细跨平台打包（macOS `.app`、Linux `.desktop`、Windows `.exe`）、`systemd` 生产配置、HTTPS 反向代理及排障方案请参阅 [`docs/BUILD_AND_DEPLOYMENT.md`](docs/BUILD_AND_DEPLOYMENT.md)。
