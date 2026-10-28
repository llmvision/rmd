use anyhow::Result;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio::{fs, sync::RwLock};
use vellum_core::{DocumentMetrics, KnowledgeGraphIndex, RopeDocument};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRecord {
    pub snapshot_id: String,
    pub created_at_ms: u64,
    pub label: String,
    pub revision: u64,
    pub metrics: DocumentMetrics,
    pub content: String,
}

pub struct ServerState {
    pub workspace_dir: PathBuf,
    pub documents: DashMap<String, Arc<RwLock<RopeDocument>>>,
    pub snapshots: DashMap<String, Vec<SnapshotRecord>>,
    pub graph: RwLock<KnowledgeGraphIndex>,
}

const BUILTIN_BUILD_GUIDE_MD: &str = include_str!("../../../docs/BUILD_AND_DEPLOYMENT.md");
const BUILTIN_ARCH_API_MD: &str = include_str!("../../../docs/ARCHITECTURE_AND_API.md");

impl ServerState {
    /// Streams existing `.md` files in `workspace_dir` into low-memory `RopeDocument` sessions
    /// and populates the workspace-wide `KnowledgeGraphIndex`.
    /// On a fresh empty workspace directory, seeds built-in engineering & deployment manuals.
    pub async fn load_from_disk(workspace_dir: PathBuf) -> Result<Self> {
        let documents = DashMap::new();
        let mut graph = KnowledgeGraphIndex::new();
        let mut dir_entries = fs::read_dir(&workspace_dir).await?;

        while let Some(entry) = dir_entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let id = stem.to_string();
                    let path_clone = path.clone();
                    let id_clone = id.clone();
                    if let Ok(Ok(doc)) = tokio::task::spawn_blocking(move || {
                        RopeDocument::open_streaming(id_clone, path_clone)
                    })
                    .await
                    {
                        graph.upsert_document(&doc);
                        documents.insert(id, Arc::new(RwLock::new(doc)));
                    }
                }
            }
        }

        if documents.is_empty() {
            let builtin_docs = [
                (
                    "build-and-deployment",
                    "本地编译与服务端部署完整指南",
                    BUILTIN_BUILD_GUIDE_MD,
                ),
                (
                    "architecture-and-api",
                    "核心架构与 Axum RESTful API 手册",
                    BUILTIN_ARCH_API_MD,
                ),
            ];
            for (id, title, raw_md) in builtin_docs {
                let dst = workspace_dir.join(format!("{}.md", id));
                if fs::write(&dst, raw_md.as_bytes()).await.is_ok() {
                    let mut doc = RopeDocument::from_markdown_str(id, title, raw_md);
                    doc.file_path = Some(dst);
                    graph.upsert_document(&doc);
                    documents.insert(id.to_string(), Arc::new(RwLock::new(doc)));
                }
            }
        }

        Ok(Self {
            workspace_dir,
            documents,
            snapshots: DashMap::new(),
            graph: RwLock::new(graph),
        })
    }

    /// Crash-safe POSIX atomic persistence: write to `.tmp` sibling then `fs::rename`.
    pub async fn atomic_persist_markdown(&self, id: &str, content: &str) -> Result<PathBuf> {
        let tmp_path = self.workspace_dir.join(format!(".{}.md.tmp", id));
        let dst_path = self.workspace_dir.join(format!("{}.md", id));
        fs::write(&tmp_path, content.as_bytes()).await?;
        fs::rename(&tmp_path, &dst_path).await?;
        Ok(dst_path)
    }
}
