use crate::state::{ServerState, SnapshotRecord};
use axum::{
    Json, Router,
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::{compression::CompressionLayer, cors::CorsLayer, services::ServeDir};
use uuid::Uuid;
use vellum_core::{
    BacklinkEntry, BlockDescriptor, DocumentMetrics, FormalPdfOptions, KanbanBoardModel,
    KnowledgeGraphIndex, KnowledgeGraphSnapshot, OutgoingLink, OutlineEntry, RopeDocument,
    SearchMatch,
};

#[derive(Debug, Serialize)]
pub struct DocumentListItem {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub metrics: DocumentMetrics,
}

#[derive(Debug, Deserialize)]
pub struct SliceQuery {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub include_raw: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct BlockWindowItem {
    pub index: usize,
    pub descriptor: BlockDescriptor,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct DocumentWindowResponse {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub metrics: DocumentMetrics,
    pub outline: Vec<OutlineEntry>,
    pub raw_markdown: Option<String>,
    pub block_window: Vec<BlockWindowItem>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertDocumentReq {
    pub title: Option<String>,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct RopeDeltaReq {
    pub start_byte: usize,
    pub end_byte: usize,
    pub inserted: String,
    pub allow_input_rules: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SearchReq {
    pub query: String,
    pub case_sensitive: Option<bool>,
    pub whole_word: Option<bool>,
    pub use_regex: Option<bool>,
}

pub fn build_router(state: Arc<ServerState>) -> Router {
    let assets_dir = state.workspace_dir.join("assets");

    let api_v1 = Router::new()
        .route("/health", get(health_check))
        .route("/documents", get(list_documents).post(create_document))
        .route(
            "/documents/{id}",
            get(get_document_window)
                .put(put_document)
                .delete(delete_document),
        )
        .route("/documents/{id}/rope-delta", patch(patch_rope_delta))
        .route("/documents/{id}/search", post(search_document))
        .route(
            "/documents/{id}/snapshots",
            get(list_snapshots).post(create_snapshot),
        )
        .route("/documents/{id}/links", get(get_document_links))
        .route(
            "/documents/{id}/kanban",
            get(get_document_kanban).patch(patch_kanban_task_state),
        )
        .route("/documents/{id}/export-pdf", post(export_document_formal_pdf))
        .route("/documents/{id}/refactor-title", post(refactor_document_title))
        .route("/graph", get(get_knowledge_graph))
        .route("/assets", post(upload_asset))
        .route("/sync/status", get(sync_status));

    Router::new()
        .nest("/api/v1", api_v1)
        .nest_service("/assets", ServeDir::new(assets_dir))
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "engine": "vellum-core (ropey + pulldown-cmark simd)",
        "framework": "axum 0.8"
    }))
}

async fn list_documents(State(state): State<Arc<ServerState>>) -> Json<Vec<DocumentListItem>> {
    let mut items = Vec::with_capacity(state.documents.len());
    for entry in state.documents.iter() {
        let doc = entry.value().read().await;
        items.push(DocumentListItem {
            id: doc.id.clone(),
            title: doc.title.clone(),
            revision: doc.revision,
            metrics: doc.metrics(),
        });
    }
    Json(items)
}

async fn create_document(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<UpsertDocumentReq>,
) -> Result<(StatusCode, Json<DocumentListItem>), (StatusCode, String)> {
    let id = Uuid::new_v4().to_string();
    let title = req.title.unwrap_or_else(|| "未命名文档".to_string());
    state
        .atomic_persist_markdown(&id, &req.content)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let doc = RopeDocument::from_markdown_str(&id, &title, &req.content);
    state.graph.write().await.upsert_document(&doc);
    let item = DocumentListItem {
        id: id.clone(),
        title,
        revision: doc.revision,
        metrics: doc.metrics(),
    };
    state.documents.insert(id, Arc::new(RwLock::new(doc)));
    Ok((StatusCode::CREATED, Json(item)))
}

async fn get_document_window(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Query(query): Query<SliceQuery>,
) -> Result<Json<DocumentWindowResponse>, StatusCode> {
    let handle = state.documents.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let doc = handle.read().await;

    let total = doc.blocks().len();
    let start = query.offset.unwrap_or(0).min(total);
    let limit = query.limit.unwrap_or(120).min(500);
    let end = (start + limit).min(total);

    let mut window = Vec::with_capacity(end.saturating_sub(start));
    for ix in start..end {
        if let Some(text) = doc.slice_block_str(ix) {
            window.push(BlockWindowItem {
                index: ix,
                descriptor: doc.blocks()[ix].clone(),
                text,
            });
        }
    }

    let raw_markdown = if query.include_raw.unwrap_or(true) {
        Some(doc.to_lossless_markdown())
    } else {
        None
    };

    Ok(Json(DocumentWindowResponse {
        id: doc.id.clone(),
        title: doc.title.clone(),
        revision: doc.revision,
        metrics: doc.metrics(),
        outline: doc.outline(),
        raw_markdown,
        block_window: window,
    }))
}

async fn put_document(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(req): Json<UpsertDocumentReq>,
) -> Result<Json<DocumentListItem>, (StatusCode, String)> {
    let title = req.title.unwrap_or_else(|| id.clone());
    state
        .atomic_persist_markdown(&id, &req.content)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let doc = RopeDocument::from_markdown_str(&id, &title, &req.content);
    state.graph.write().await.upsert_document(&doc);
    let item = DocumentListItem {
        id: id.clone(),
        title,
        revision: doc.revision,
        metrics: doc.metrics(),
    };
    state.documents.insert(id, Arc::new(RwLock::new(doc)));
    Ok(Json(item))
}

async fn patch_rope_delta(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(req): Json<RopeDeltaReq>,
) -> Result<Json<DocumentMetrics>, (StatusCode, String)> {
    let handle = state
        .documents
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Document not found".into()))?;

    let (lossless, metrics) = {
        let mut doc = handle.write().await;
        doc.edit_byte_range(
            req.start_byte..req.end_byte,
            &req.inserted,
            req.allow_input_rules.unwrap_or(false),
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        (doc.to_lossless_markdown(), doc.metrics())
    };

    state
        .atomic_persist_markdown(&id, &lossless)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(metrics))
}

async fn search_document(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(req): Json<SearchReq>,
) -> Result<Json<Vec<SearchMatch>>, (StatusCode, String)> {
    let handle = state
        .documents
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Document not found".into()))?;
    let doc = handle.read().await;
    let matches = doc
        .search(
            &req.query,
            req.case_sensitive.unwrap_or(false),
            req.whole_word.unwrap_or(false),
            req.use_regex.unwrap_or(false),
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(matches))
}

async fn delete_document(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> StatusCode {
    state.documents.remove(&id);
    state.graph.write().await.remove_document(&id);
    let _ = tokio::fs::remove_file(state.workspace_dir.join(format!("{}.md", id))).await;
    StatusCode::NO_CONTENT
}

async fn list_snapshots(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> Json<Vec<SnapshotRecord>> {
    Json(
        state
            .snapshots
            .get(&id)
            .map(|list| list.clone())
            .unwrap_or_default(),
    )
}

async fn create_snapshot(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<SnapshotRecord>), StatusCode> {
    let handle = state.documents.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let doc = handle.read().await;

    let snap = SnapshotRecord {
        snapshot_id: Uuid::new_v4().to_string(),
        created_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        label: format!("本地快照 #{}", doc.revision),
        revision: doc.revision,
        metrics: doc.metrics(),
        content: doc.to_lossless_markdown(),
    };
    state.snapshots.entry(id).or_default().insert(0, snap.clone());
    Ok((StatusCode::CREATED, Json(snap)))
}

async fn upload_asset(
    State(state): State<Arc<ServerState>>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let filename = field.file_name().unwrap_or("image.png").to_string();
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let data = field
            .bytes()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

        let hash = &blake3::hash(&data).to_hex()[..16];
        let stored_name = format!("{}.{}", hash, ext);
        let rel = format!("assets/{}", stored_name);

        tokio::fs::write(state.workspace_dir.join(&rel), &data)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        return Ok((
            StatusCode::CREATED,
            Json(serde_json::json!({
                "markdown_syntax": format!("![{}]({})", filename, rel),
                "relative_path": rel,
                "bytes": data.len()
            })),
        ));
    }
    Err((StatusCode::BAD_REQUEST, "Empty multipart upload".into()))
}

#[derive(Debug, Serialize)]
pub struct DocumentLinksResponse {
    pub doc_id: String,
    pub outgoing: Vec<OutgoingLink>,
    pub backlinks: Vec<BacklinkEntry>,
}

#[derive(Debug, Deserialize)]
pub struct RefactorTitleReq {
    pub new_title: String,
}

async fn get_knowledge_graph(
    State(state): State<Arc<ServerState>>,
) -> Json<KnowledgeGraphSnapshot> {
    let snap = state.graph.read().await.snapshot();
    Json(snap)
}

async fn get_document_links(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> Json<DocumentLinksResponse> {
    let graph = state.graph.read().await;
    Json(DocumentLinksResponse {
        outgoing: graph.outgoing_links(&id),
        backlinks: graph.backlinks_for(&id),
        doc_id: id,
    })
}

async fn refactor_document_title(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(req): Json<RefactorTitleReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let handle = state
        .documents
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Document not found".into()))?;
    let old_title = {
        let mut target_doc = handle.write().await;
        let prev = target_doc.title.clone();
        target_doc.title = req.new_title.trim().to_string();
        state.graph.write().await.upsert_document(&target_doc);
        prev
    };

    let mut rewritten_docs = 0usize;
    let mut rewritten_links = 0usize;

    let all_ids: Vec<String> = state.documents.iter().map(|e| e.key().clone()).collect();
    for other_id in all_ids {
        if let Some(other_handle) = state.documents.get(&other_id) {
            let current_md = other_handle.read().await.to_lossless_markdown();
            let other_title = other_handle.read().await.title.clone();
            let (updated_md, cnt) =
                KnowledgeGraphIndex::rewrite_links_on_rename(&current_md, &old_title, &req.new_title);
            if cnt > 0 {
                rewritten_docs += 1;
                rewritten_links += cnt;
                state
                    .atomic_persist_markdown(&other_id, &updated_md)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let next_doc = RopeDocument::from_markdown_str(&other_id, &other_title, &updated_md);
                state.graph.write().await.upsert_document(&next_doc);
                *other_handle.write().await = next_doc;
            }
        }
    }

    Ok(Json(serde_json::json!({
        "old_title": old_title,
        "new_title": req.new_title,
        "rewritten_documents": rewritten_docs,
        "rewritten_links": rewritten_links
    })))
}

#[derive(Debug, Deserialize)]
struct KanbanToggleReq {
    state_byte_offset: usize,
    completed: bool,
}

async fn get_document_kanban(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> Result<Json<KanbanBoardModel>, (StatusCode, String)> {
    let handle = state
        .documents
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Document not found".into()))?;
    let doc = handle.read().await;
    Ok(Json(doc.extract_kanban_board()))
}

async fn patch_kanban_task_state(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(req): Json<KanbanToggleReq>,
) -> Result<Json<KanbanBoardModel>, (StatusCode, String)> {
    let handle = state
        .documents
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Document not found".into()))?;

    let (board, full_md) = {
        let mut doc = handle.write().await;
        doc.set_kanban_task_completed(req.state_byte_offset, req.completed)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        (doc.extract_kanban_board(), doc.to_lossless_markdown())
    };

    state
        .atomic_persist_markdown(&id, &full_md)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(board))
}

async fn export_document_formal_pdf(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(opts): Json<Option<FormalPdfOptions>>,
) -> Result<
    (
        StatusCode,
        [(axum::http::header::HeaderName, &'static str); 1],
        Vec<u8>,
    ),
    (StatusCode, String),
> {
    let handle = state
        .documents
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "Document not found".into()))?;
    let doc = handle.read().await;
    let options = opts.unwrap_or_default();
    let pdf_bytes = doc
        .export_formal_pdf(&options, None)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/pdf")],
        pdf_bytes,
    ))
}

async fn sync_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "architecture": "local_first",
        "phase2_sync_protocol": "yrs_crdt_reserved",
        "realtime_backup_ready": true
    }))
}
