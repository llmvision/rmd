//! `vellum-server`: High-performance Axum RESTful API backend for local persistence,
//! large-file block-slice streaming, local asset storage, crash-recovery snapshots,
//! and Phase 2 multi-device CRDT synchronization.

pub mod routes;
pub mod state;

use crate::routes::build_router;
use crate::state::ServerState;
use anyhow::Result;
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::fs;

/// Spawns the Axum RESTful API server (used both by the standalone `vellum-server` binary
/// and embedded inside `vellum-gpui` on a background Tokio thread).
pub async fn run_axum_server(workspace_dir: PathBuf, bind_addr: SocketAddr) -> Result<()> {
    fs::create_dir_all(workspace_dir.join("assets")).await?;
    fs::create_dir_all(workspace_dir.join(".snapshots")).await?;

    let state = Arc::new(ServerState::load_from_disk(workspace_dir).await?);
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!("Vellum Axum RESTful service listening on http://{}", bind_addr);
    axum::serve(listener, app).await?;
    Ok(())
}
