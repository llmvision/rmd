use anyhow::Result;
use std::{net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("vellum_server=info,tower_http=info")
        .init();

    let workspace = std::env::var("VELLUM_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./workspace-docs"));

    let host = std::env::var("VELLUM_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("VELLUM_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4120);

    let addr: SocketAddr = format!("{}:{}", host, port).parse()?;
    vellum_server::run_axum_server(workspace, addr).await
}
