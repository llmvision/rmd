# Multi-stage build for headless `vellum-server` (Axum + Ropey + Krilla Formal PDF Engine)
FROM rust:1.85-bookworm AS builder

WORKDIR /src
COPY Cargo.toml README.md ./
COPY docs ./docs
COPY crates ./crates

# Build only `vellum-server` + `vellum-core` (no X11/Wayland/Vulkan GUI headers required on headless servers!)
RUN cargo build --release -p vellum-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /src/target/release/vellum-server /usr/local/bin/vellum-server

RUN mkdir -p /data/workspace-docs
ENV VELLUM_HOST=0.0.0.0
ENV VELLUM_PORT=4120
ENV VELLUM_WORKSPACE=/data/workspace-docs

EXPOSE 4120
VOLUME ["/data/workspace-docs"]

CMD ["vellum-server"]
