use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Reserved Phase 2 Synchronization & Real-Time Backup Protocol (`PRD Section 6.8`).
///
/// Current Phase 1 operates strictly local-first for zero network latency and minimal RAM.
/// Phase 2 plugs a CRDT (`yrs` / Yjs state vector) adapter into `SyncTransport` without
/// changing `RopeDocument` or `vellum-gpui` rendering views.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStateVector {
    pub doc_id: String,
    pub replica_id: Uuid,
    pub local_revision: u64,
    pub blake3_checksum: String,
    pub encoded_yrs_state_vector: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockDeltaPatch {
    pub doc_id: String,
    pub base_revision: u64,
    pub start_byte: usize,
    pub end_byte: usize,
    pub replacement_utf8: String,
    pub timestamp_ms: u64,
}

pub trait SyncTransport: Send + Sync {
    fn compute_state_vector(&self, doc_id: &str) -> Option<SyncStateVector>;
    fn apply_remote_patch(&self, patch: BlockDeltaPatch) -> Result<u64, String>;
}
