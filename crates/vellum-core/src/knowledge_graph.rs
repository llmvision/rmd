use crate::rope_doc::RopeDocument;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ops::Range;

/// Kind of reference between Markdown documents in the Knowledge Network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    /// Standard bidirectional WikiLink: `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`
    WikiLink,
    /// Embedded block/section transclusion: `![[Target]]` or `![[Target#Heading]]`
    EmbedTransclusion,
}

/// Parsed outgoing document reference extracted from a `RopeDocument`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingLink {
    pub kind: ReferenceKind,
    pub target_title: String,
    pub heading_anchor: Option<String>,
    pub display_alias: Option<String>,
    pub byte_range: Range<usize>,
    pub line_number: usize,
    pub context_snippet: String,
}

/// Incoming backlink pointing to a target document from another document in the workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacklinkEntry {
    pub source_doc_id: String,
    pub source_title: String,
    pub kind: ReferenceKind,
    pub heading_anchor: Option<String>,
    pub line_number: usize,
    pub byte_range: Range<usize>,
    pub context_snippet: String,
}

/// Plain-text occurrence of a document's title that has not yet been wrapped in `[[...]]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlinkedMention {
    pub source_doc_id: String,
    pub source_title: String,
    pub line_number: usize,
    pub byte_range: Range<usize>,
    pub context_snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub resolved: bool,
    pub word_count: usize,
    pub in_degree: usize,
    pub out_degree: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source_id: String,
    pub target_id: String,
    pub kind: ReferenceKind,
    pub heading_anchor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeGraphSnapshot {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub resolved_doc_count: usize,
    pub unresolved_node_count: usize,
    pub total_connections: usize,
}

/// Low-memory incremental Knowledge Network index across all local `RopeDocument` files.
///
/// Tracks `[[Page]]`, `[[Page#Section|Alias]]`, and `![[Page#Section]]` references,
/// ignoring occurrences inside fenced code blocks (` ``` `) or inline code spans (`` ` ``).
#[derive(Debug, Default, Clone)]
pub struct KnowledgeGraphIndex {
    doc_titles: HashMap<String, (String, usize)>,
    title_to_id: HashMap<String, String>,
    outgoing_by_doc: HashMap<String, Vec<OutgoingLink>>,
}

impl KnowledgeGraphIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn normalize_key(title: &str) -> String {
        title.trim().to_lowercase()
    }

    /// Incrementally updates outgoing links for a single `RopeDocument` in sub-millisecond time.
    pub fn upsert_document(&mut self, doc: &RopeDocument) {
        let metrics = doc.metrics();
        let norm_title = Self::normalize_key(&doc.title);
        self.title_to_id.insert(norm_title, doc.id.clone());
        self.doc_titles
            .insert(doc.id.clone(), (doc.title.clone(), metrics.word_count));

        let full_text = doc.to_lossless_markdown();
        let extracted = extract_wikilinks_from_markdown(&full_text);
        self.outgoing_by_doc.insert(doc.id.clone(), extracted);
    }

    pub fn remove_document(&mut self, doc_id: &str) {
        if let Some((title, _)) = self.doc_titles.remove(doc_id) {
            self.title_to_id.remove(&Self::normalize_key(&title));
        }
        self.outgoing_by_doc.remove(doc_id);
    }

    pub fn outgoing_links(&self, doc_id: &str) -> Vec<OutgoingLink> {
        self.outgoing_by_doc
            .get(doc_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Queries all incoming backlinks referencing `target_doc_id` (by title or ID).
    pub fn backlinks_for(&self, target_doc_id: &str) -> Vec<BacklinkEntry> {
        let Some((target_title, _)) = self.doc_titles.get(target_doc_id) else {
            return Vec::new();
        };
        let norm_target = Self::normalize_key(target_title);
        let norm_id = Self::normalize_key(target_doc_id);

        let mut results = Vec::new();
        for (src_id, links) in &self.outgoing_by_doc {
            if src_id == target_doc_id {
                continue;
            }
            let src_title = self
                .doc_titles
                .get(src_id)
                .map(|(t, _)| t.clone())
                .unwrap_or_else(|| src_id.clone());

            for link in links {
                let candidate = Self::normalize_key(&link.target_title);
                if candidate == norm_target || candidate == norm_id {
                    results.push(BacklinkEntry {
                        source_doc_id: src_id.clone(),
                        source_title: src_title.clone(),
                        kind: link.kind,
                        heading_anchor: link.heading_anchor.clone(),
                        line_number: link.line_number,
                        byte_range: link.byte_range.clone(),
                        context_snippet: link.context_snippet.clone(),
                    });
                }
            }
        }
        results
    }

    /// Builds the full global graph topology (including unresolved `[[Phantom]]` nodes).
    pub fn snapshot(&self) -> KnowledgeGraphSnapshot {
        let mut nodes_map: HashMap<String, GraphNode> = HashMap::new();
        for (id, (title, words)) in &self.doc_titles {
            nodes_map.insert(
                id.clone(),
                GraphNode {
                    id: id.clone(),
                    title: title.clone(),
                    resolved: true,
                    word_count: *words,
                    in_degree: 0,
                    out_degree: 0,
                },
            );
        }

        let mut edges = Vec::new();
        let mut unresolved_count = 0usize;

        for (src_id, links) in &self.outgoing_by_doc {
            let mut seen_targets = HashSet::new();
            for link in links {
                let norm = Self::normalize_key(&link.target_title);
                let target_id = if let Some(existing_id) = self.title_to_id.get(&norm) {
                    existing_id.clone()
                } else if nodes_map.contains_key(&norm) {
                    norm.clone()
                } else {
                    let phantom_id = format!("unresolved:{}", norm);
                    if !nodes_map.contains_key(&phantom_id) {
                        unresolved_count += 1;
                        nodes_map.insert(
                            phantom_id.clone(),
                            GraphNode {
                                id: phantom_id.clone(),
                                title: link.target_title.clone(),
                                resolved: false,
                                word_count: 0,
                                in_degree: 0,
                                out_degree: 0,
                            },
                        );
                    }
                    phantom_id
                };

                if seen_targets.insert((target_id.clone(), link.kind == ReferenceKind::EmbedTransclusion)) {
                    if let Some(src_node) = nodes_map.get_mut(src_id) {
                        src_node.out_degree += 1;
                    }
                    if let Some(dst_node) = nodes_map.get_mut(&target_id) {
                        dst_node.in_degree += 1;
                    }
                    edges.push(GraphEdge {
                        source_id: src_id.clone(),
                        target_id,
                        kind: link.kind,
                        heading_anchor: link.heading_anchor.clone(),
                    });
                }
            }
        }

        let mut nodes: Vec<GraphNode> = nodes_map.into_values().collect();
        nodes.sort_by(|a, b| b.in_degree.cmp(&a.in_degree).then_with(|| a.title.cmp(&b.title)));

        KnowledgeGraphSnapshot {
            resolved_doc_count: self.doc_titles.len(),
            unresolved_node_count: unresolved_count,
            total_connections: edges.len(),
            nodes,
            edges,
        }
    }

    /// Rewrites `[[old_title]]`, `[[old_title#sec]]`, and `![[old_title|alias]]` inside a Markdown string
    /// when a document is renamed, preserving section anchors and display aliases.
    pub fn rewrite_links_on_rename(markdown: &str, old_title: &str, new_title: &str) -> (String, usize) {
        let old_norm = Self::normalize_key(old_title);
        let mut out = String::with_capacity(markdown.len() + 32);
        let mut last = 0usize;
        let mut count = 0usize;
        let bytes = markdown.as_bytes();
        let mut i = 0usize;

        while i + 3 < bytes.len() {
            if bytes[i] == b'[' && bytes[i + 1] == b'[' {
                if let Some(rel_close) = markdown[i + 2..].find("]]") {
                    let inner = &markdown[i + 2..i + 2 + rel_close];
                    if !inner.contains('\n') {
                        let (target_and_hash, alias_part) = match inner.split_once('|') {
                            Some((l, r)) => (l, Some(r)),
                            None => (inner, None),
                        };
                        let (page_part, hash_part) = match target_and_hash.split_once('#') {
                            Some((p, h)) => (p, Some(h)),
                            None => (target_and_hash, None),
                        };

                        if Self::normalize_key(page_part) == old_norm {
                            out.push_str(&markdown[last..i + 2]);
                            out.push_str(new_title.trim());
                            if let Some(h) = hash_part {
                                out.push('#');
                                out.push_str(h);
                            }
                            if let Some(a) = alias_part {
                                out.push('|');
                                out.push_str(a);
                            }
                            out.push_str("]]");
                            i = i + 4 + rel_close;
                            last = i;
                            count += 1;
                            continue;
                        }
                    }
                }
            }
            i += 1;
        }
        out.push_str(&markdown[last..]);
        (out, count)
    }
}

/// Scans Markdown lines (skipping fenced code blocks) to extract `[[...]]` and `![[...]]` links.
pub fn extract_wikilinks_from_markdown(markdown: &str) -> Vec<OutgoingLink> {
    let mut links = Vec::new();
    let mut in_fence = false;
    let mut byte_cursor = 0usize;

    for (line_idx, raw_line) in markdown.split_inclusive('\n').enumerate() {
        let trimmed = raw_line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            byte_cursor += raw_line.len();
            continue;
        }
        if in_fence {
            byte_cursor += raw_line.len();
            continue;
        }

        let line_clean = raw_line.trim_end_matches(&['\r', '\n'][..]);
        let bytes = line_clean.as_bytes();
        let mut col = 0usize;
        let mut in_inline_code = false;

        while col < bytes.len() {
            if bytes[col] == b'`' {
                in_inline_code = !in_inline_code;
                col += 1;
                continue;
            }
            if in_inline_code {
                col += 1;
                continue;
            }

            let is_embed = col + 4 < bytes.len()
                && bytes[col] == b'!'
                && bytes[col + 1] == b'['
                && bytes[col + 2] == b'[';
            let is_wiki = !is_embed
                && col + 3 < bytes.len()
                && bytes[col] == b'['
                && bytes[col + 1] == b'[';

            if is_embed || is_wiki {
                let inner_offset = if is_embed { col + 3 } else { col + 2 };
                if let Some(close_rel) = line_clean[inner_offset..].find("]]") {
                    let inner = line_clean[inner_offset..inner_offset + close_rel].trim();
                    let full_end_col = inner_offset + close_rel + 2;

                    if !inner.is_empty() {
                        let (left, alias) = match inner.split_once('|') {
                            Some((l, r)) => (l.trim(), Some(r.trim().to_string())),
                            None => (inner, None),
                        };
                        let (target_page, heading) = match left.split_once('#') {
                            Some((p, h)) => (p.trim().to_string(), Some(h.trim().to_string())),
                            None => (left.trim().to_string(), None),
                        };

                        if !target_page.is_empty() {
                            links.push(OutgoingLink {
                                kind: if is_embed {
                                    ReferenceKind::EmbedTransclusion
                                } else {
                                    ReferenceKind::WikiLink
                                },
                                target_title: target_page,
                                heading_anchor: heading,
                                display_alias: alias,
                                byte_range: (byte_cursor + col)..(byte_cursor + full_end_col),
                                line_number: line_idx + 1,
                                context_snippet: line_clean.trim().to_string(),
                            });
                        }
                    }
                    col = full_end_col;
                    continue;
                }
            }
            col += 1;
        }

        byte_cursor += raw_line.len();
    }

    links
}
