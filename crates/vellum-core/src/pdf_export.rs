//! Pure-Rust Formal Document Vector PDF Typesetting Engine (`crates/vellum-core/src/pdf_export.rs`).
//!
//! Built on `krilla` (Typst's PDF 1.7 / PDF-A vector & OpenType/TTC CJK font-subsetting engine) —
//! zero WebView, zero Chromium, zero external binaries.
//!
//! Formal layout capabilities:
//! - Three formal document presets: `TechnicalSpec` (技术规范白皮书), `OfficialReport` (正式公文报告),
//!   and `AcademicPaper` (学术单栏论文)
//! - Classic formal double-rule header (上粗下细双文头线) + Document Control Metadata Table
//! - Automatic hierarchical Table of Contents (TOC) & multi-level section numbering (`1`, `1.1`, `1.1.1`)
//! - Widow/orphan protection for headings (`keep_with_next`)
//! - Three-line / grid formal GFM tables (`三线表` / `正式网格表`), shaded code blocks, and callouts
//! - Two-pass pagination for exact running headers & `"第 X 页 / 共 Y 页"` page footers

use crate::incremental_ast::BlockKind;
use crate::rope_doc::RopeDocument;
use crate::table_model::GfmTableModel;
use anyhow::{Result, anyhow};
use krilla::Document;
use krilla::color::rgb;
use krilla::geom::{PathBuilder, Point};
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, FillRule};
use krilla::text::{Font, TextDirection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormalPdfPreset {
    /// 技术白皮书与工程架构规范（深石板蓝文头线、受控元信息表、网格表、自动章节编号）
    TechnicalSpec,
    /// 企事业正式报告与公文版式（朱红双文头线、居中主标题、正文首行缩进、正式三线表）
    OfficialReport,
    /// 学术论文与研究手稿（居中题名摘要区、紧凑行距、编号公式、学术三线表）
    AcademicPaper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperSize {
    /// ISO A4 (210 × 297 mm = 595.28 × 841.89 pt)
    A4,
    /// North American Letter (215.9 × 279.4 mm = 612.0 × 792.0 pt)
    Letter,
}

impl PaperSize {
    pub fn dimensions_pt(self) -> (f32, f32) {
        match self {
            Self::A4 => (595.28, 841.89),
            Self::Letter => (612.0, 792.0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormalPdfOptions {
    pub preset: FormalPdfPreset,
    pub paper_size: PaperSize,
    /// Page margin in millimeters (25.4 mm = standard 1-inch formal document margin)
    pub margin_mm: f32,
    pub include_cover_meta: bool,
    pub include_toc: bool,
    pub auto_number_headings: bool,
    pub include_header_footer: bool,
    pub document_code: Option<String>,
    pub organization: Option<String>,
}

impl Default for FormalPdfOptions {
    fn default() -> Self {
        Self {
            preset: FormalPdfPreset::TechnicalSpec,
            paper_size: PaperSize::A4,
            margin_mm: 25.4,
            include_cover_meta: true,
            include_toc: true,
            auto_number_headings: true,
            include_header_footer: true,
            document_code: None,
            organization: Some("Vellum Native Local Workspace".to_string()),
        }
    }
}

#[derive(Clone, Copy)]
struct RgbTriplet(u8, u8, u8);

enum DrawCmd {
    FillRect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        color: RgbTriplet,
    },
    Text {
        x: f32,
        y: f32,
        size: f32,
        color: RgbTriplet,
        use_mono: bool,
        text: String,
    },
}

struct PaginatedLayout {
    pages: Vec<Vec<DrawCmd>>,
}

pub struct FontBundle {
    pub body: Font,
    pub mono: Font,
}

/// Discovers an installed CJK-capable OpenType/TrueType/TTC system font across Linux, macOS, and Windows.
pub fn load_system_cjk_fonts(custom_font_path: Option<&Path>) -> Result<FontBundle> {
    if let Some(custom) = custom_font_path {
        let bytes = std::fs::read(custom)?;
        let f = Font::new(bytes.into(), 0)
            .ok_or_else(|| anyhow!("Failed to parse custom font: {}", custom.display()))?;
        return Ok(FontBundle {
            body: f.clone(),
            mono: f,
        });
    }

    let body_candidates = [
        // macOS system CJK fonts
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        // Linux Noto / WenQuanYi / Unifont CJK fonts
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/opentype/unifont/unifont.otf",
        // Windows DirectWrite CJK fonts
        r"C:\Windows\Fonts\simsun.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
    ];

    let mut body_font: Option<Font> = None;
    let mut mono_font: Option<Font> = None;

    for candidate in body_candidates {
        let p = Path::new(candidate);
        if p.exists() {
            if let Ok(bytes) = std::fs::read(p) {
                if candidate.ends_with("wqy-zenhei.ttc") {
                    mono_font = Font::new(bytes.clone().into(), 2);
                }
                if let Some(f0) = Font::new(bytes.into(), 0) {
                    body_font = Some(f0);
                    break;
                }
            }
        }
    }

    let body = body_font.ok_or_else(|| {
        anyhow!("No system CJK TrueType/OpenType font found (install fonts-noto-cjk or wqy-zenhei)")
    })?;
    let mono = mono_font.unwrap_or_else(|| body.clone());

    Ok(FontBundle { body, mono })
}

/// Estimates visual width in PDF points for mixed CJK (full-width ~1.0em) and ASCII (~0.54em) glyphs.
fn estimate_text_width_pt(text: &str, font_size: f32, is_mono: bool) -> f32 {
    let mut units = 0.0f32;
    for ch in text.chars() {
        if ch.is_ascii() {
            units += if is_mono { 0.60 } else { 0.53 };
        } else {
            units += 1.0;
        }
    }
    units * font_size
}

/// Wraps mixed Chinese + English prose cleanly within `max_width_pt` without splitting ASCII words mid-token.
fn wrap_mixed_line(text: &str, font_size: f32, max_width_pt: f32, is_mono: bool) -> Vec<String> {
    if text.trim().is_empty() {
        return vec![String::new()];
    }

    let mut lines = Vec::new();
    let mut current = String::new();
    let mut cur_w = 0.0f32;

    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_ascii_alphanumeric() && !is_mono {
            let mut word = String::from(ch);
            while let Some(&nxt) = chars.peek() {
                if nxt.is_ascii_alphanumeric() || nxt == '_' || nxt == '-' || nxt == '.' {
                    word.push(nxt);
                    chars.next();
                } else {
                    break;
                }
            }
            let word_w = estimate_text_width_pt(&word, font_size, false);
            if cur_w + word_w > max_width_pt && !current.is_empty() {
                lines.push(current.trim_end().to_string());
                current = word;
                cur_w = word_w;
            } else {
                current.push_str(&word);
                cur_w += word_w;
            }
        } else {
            let ch_w = if ch.is_ascii() {
                if is_mono { 0.60 } else { 0.53 }
            } else {
                1.0
            } * font_size;

            if cur_w + ch_w > max_width_pt && !current.is_empty() {
                lines.push(current.trim_end().to_string());
                current = String::new();
                cur_w = 0.0;
                if ch == ' ' {
                    continue;
                }
            }
            current.push(ch);
            cur_w += ch_w;
        }
    }

    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn strip_inline_markdown_for_formal_pdf(raw: &str) -> String {
    let mut s = raw.to_string();
    // Convert `[[Target#Sec|Alias]]` -> `Alias` and `[[Target]]` -> `Target`
    while let Some(start) = s.find("[[") {
        let is_embed = start > 0 && s.as_bytes()[start - 1] == b'!';
        let prefix_start = if is_embed { start - 1 } else { start };
        if let Some(rel_end) = s[start + 2..].find("]]") {
            let inner = &s[start + 2..start + 2 + rel_end];
            let replacement = if let Some((_, alias)) = inner.split_once('|') {
                alias.trim().to_string()
            } else {
                inner.replace('#', " § ").trim().to_string()
            };
            s.replace_range(prefix_start..start + 4 + rel_end, &replacement);
        } else {
            break;
        }
    }

    s.replace("***", "")
        .replace("**", "")
        .replace("~~", "")
        .replace("==", "")
        .replace('`', "")
        .replace("<kbd>", "[")
        .replace("</kbd>", "]")
}

fn parse_frontmatter_pairs(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if t == "---" || t == "..." || t.is_empty() {
            continue;
        }
        if let Some((k, v)) = t.split_once(':') {
            out.push((k.trim().to_string(), v.trim().trim_matches('"').to_string()));
        }
    }
    out
}

impl RopeDocument {
    /// Renders the `RopeDocument` directly into a formal, paginated PDF 1.7 byte buffer.
    pub fn export_formal_pdf(
        &self,
        options: &FormalPdfOptions,
        custom_font_path: Option<&Path>,
    ) -> Result<Vec<u8>> {
        let fonts = load_system_cjk_fonts(custom_font_path)?;
        let (page_w, page_h) = options.paper_size.dimensions_pt();
        let margin = (options.margin_mm * 72.0 / 25.4).clamp(36.0, 108.0);
        let content_w = page_w - margin * 2.0;
        let top_y = margin + if options.include_header_footer { 18.0 } else { 0.0 };
        let bottom_limit = page_h - margin - if options.include_header_footer { 22.0 } else { 0.0 };

        let accent = match options.preset {
            FormalPdfPreset::TechnicalSpec => RgbTriplet(30, 58, 138),   // Deep Lapis #1E3A8A
            FormalPdfPreset::OfficialReport => RgbTriplet(153, 27, 27),  // Official Crimson #991B1B
            FormalPdfPreset::AcademicPaper => RgbTriplet(24, 24, 27),    // Scholarly Ink #18181B
        };
        let ink_primary = RgbTriplet(24, 24, 27);
        let ink_secondary = RgbTriplet(63, 63, 70);
        let ink_muted = RgbTriplet(113, 113, 122);
        let rule_light = RgbTriplet(212, 212, 216);
        let surface_subtle = RgbTriplet(246, 247, 249);

        let metrics = self.metrics();
        let mut frontmatter_meta: Vec<(String, String)> = Vec::new();
        if let Some(first_blk) = self.blocks().first() {
            if matches!(first_blk.kind, BlockKind::FrontMatter) {
                if let Some(raw_fm) = self.slice_block_str(0) {
                    frontmatter_meta = parse_frontmatter_pairs(&raw_fm);
                }
            }
        }

        // Pre-scan headings for hierarchical numbering (`1`, `1.1`, `1.1.1`) and TOC
        let mut h_counters = [0usize; 6];
        let mut numbered_headings: Vec<(usize, u8, String)> = Vec::new();
        let mut seen_primary_h1 = false;

        for (ix, blk) in self.blocks().iter().enumerate() {
            if let BlockKind::Heading { level, .. } = blk.kind {
                if let Some(raw_h) = self.slice_block_str(ix) {
                    let clean_title = strip_inline_markdown_for_formal_pdf(
                        raw_h.lines().next().unwrap_or("").trim_start_matches('#').trim(),
                    );
                    if level == 1 && !seen_primary_h1 && clean_title == self.title {
                        seen_primary_h1 = true;
                        continue;
                    }
                    let lvl_idx = (level as usize).clamp(1, 6) - 1;
                    let norm_idx = if lvl_idx > 0 { lvl_idx - 1 } else { 0 };
                    h_counters[norm_idx] += 1;
                    for trailing in &mut h_counters[(norm_idx + 1)..] {
                        *trailing = 0;
                    }
                    let prefix = if options.auto_number_headings {
                        let active_slice: Vec<String> = h_counters[..=norm_idx]
                            .iter()
                            .map(|n| n.max(&1).to_string())
                            .collect();
                        format!("{}  {}", active_slice.join("."), clean_title)
                    } else {
                        clean_title
                    };
                    numbered_headings.push((ix, level, prefix));
                }
            }
        }

        let mut layout = PaginatedLayout {
            pages: vec![Vec::new()],
        };
        let mut cur_y = top_y;

        let ensure_space = |needed_h: f32, cur_y: &mut f32, layout: &mut PaginatedLayout| {
            if *cur_y + needed_h > bottom_limit {
                layout.pages.push(Vec::new());
                *cur_y = top_y;
            }
        };

        // 1. Formal Cover Header & Double-Rule Divider
        if options.include_cover_meta {
            let org_kicker = options
                .organization
                .as_deref()
                .unwrap_or("VELLUM FORMAL DOCUMENT SPECIFICATION");
            layout.pages[0].push(DrawCmd::Text {
                x: margin,
                y: cur_y + 9.0,
                size: 8.5,
                color: accent,
                use_mono: false,
                text: org_kicker.to_string(),
            });
            cur_y += 18.0;

            let title_size = 20.0f32;
            let wrapped_title = wrap_mixed_line(&self.title, title_size, content_w, false);
            for tline in wrapped_title {
                let tx = if options.preset == FormalPdfPreset::TechnicalSpec {
                    margin
                } else {
                    let tw = estimate_text_width_pt(&tline, title_size, false);
                    margin + ((content_w - tw) * 0.5).max(0.0)
                };
                layout.pages[0].push(DrawCmd::Text {
                    x: tx,
                    y: cur_y + title_size,
                    size: title_size,
                    color: ink_primary,
                    use_mono: false,
                    text: tline,
                });
                cur_y += title_size * 1.38;
            }
            cur_y += 6.0;

            // Classic Formal Double Rule (上粗 1.6pt + 下细 0.6pt)
            layout.pages[0].push(DrawCmd::FillRect {
                x: margin,
                y: cur_y,
                w: content_w,
                h: 1.6,
                color: accent,
            });
            layout.pages[0].push(DrawCmd::FillRect {
                x: margin,
                y: cur_y + 3.4,
                w: content_w,
                h: 0.6,
                color: accent,
            });
            cur_y += 12.0;

            // Document Control Metadata Grid
            let doc_code = options
                .document_code
                .clone()
                .unwrap_or_else(|| format!("DOC-{}", self.id.to_uppercase()));
            let version_val = frontmatter_meta
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("version"))
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| format!("Rev.{}", self.revision));

            let meta_summary = format!(
                "文档编号：{}    版本：{}    字数：{} 字    校验指纹：{}",
                doc_code, version_val, metrics.word_count, metrics.blake3_checksum
            );
            layout.pages[0].push(DrawCmd::FillRect {
                x: margin,
                y: cur_y,
                w: content_w,
                h: 22.0,
                color: surface_subtle,
            });
            layout.pages[0].push(DrawCmd::Text {
                x: margin + 8.0,
                y: cur_y + 14.5,
                size: 8.5,
                color: ink_secondary,
                use_mono: false,
                text: meta_summary,
            });
            cur_y += 32.0;
        }

        // 2. Formal Hierarchical Table of Contents (TOC)
        if options.include_toc && numbered_headings.len() >= 2 {
            ensure_space(48.0, &mut cur_y, &mut layout);
            let pg = layout.pages.len() - 1;
            layout.pages[pg].push(DrawCmd::Text {
                x: margin,
                y: cur_y + 12.0,
                size: 12.0,
                color: ink_primary,
                use_mono: false,
                text: "目  录".to_string(),
            });
            cur_y += 20.0;

            for (_, lvl, label) in &numbered_headings {
                ensure_space(16.0, &mut cur_y, &mut layout);
                let indent = ((*lvl as f32) - 2.0).max(0.0) * 12.0;
                let pg_idx = layout.pages.len() - 1;
                layout.pages[pg_idx].push(DrawCmd::Text {
                    x: margin + indent,
                    y: cur_y + 10.0,
                    size: 9.5,
                    color: ink_secondary,
                    use_mono: false,
                    text: label.clone(),
                });
                cur_y += 15.5;
            }

            let pg_end = layout.pages.len() - 1;
            layout.pages[pg_end].push(DrawCmd::FillRect {
                x: margin,
                y: cur_y + 4.0,
                w: content_w,
                h: 0.6,
                color: rule_light,
            });
            cur_y += 18.0;
        }

        // 3. Paginate Document Body Blocks
        let mut skipped_title_h1 = false;
        for (blk_ix, blk) in self.blocks().iter().enumerate() {
            if matches!(blk.kind, BlockKind::FrontMatter) {
                continue;
            }
            let Some(raw_blk) = self.slice_block_str(blk_ix) else {
                continue;
            };
            let trimmed_blk = raw_blk.trim();
            if trimmed_blk.is_empty() {
                continue;
            }

            match &blk.kind {
                BlockKind::Heading { level, .. } => {
                    let clean_h = strip_inline_markdown_for_formal_pdf(
                        trimmed_blk.lines().next().unwrap_or("").trim_start_matches('#').trim(),
                    );
                    if *level == 1 && !skipped_title_h1 && clean_h == self.title && options.include_cover_meta {
                        skipped_title_h1 = true;
                        continue;
                    }

                    let display_h = numbered_headings
                        .iter()
                        .find(|(ix, _, _)| *ix == blk_ix)
                        .map(|(_, _, s)| s.clone())
                        .unwrap_or(clean_h);

                    let h_size = match level {
                        1 => 15.5,
                        2 => 13.0,
                        3 => 11.2,
                        _ => 10.5,
                    };
                    // Widow/orphan protection: keep heading together with at least 42pt of following prose
                    ensure_space(h_size * 2.0 + 42.0, &mut cur_y, &mut layout);
                    cur_y += if *level <= 2 { 10.0 } else { 6.0 };

                    for line in wrap_mixed_line(&display_h, h_size, content_w, false) {
                        let pg = layout.pages.len() - 1;
                        layout.pages[pg].push(DrawCmd::Text {
                            x: margin,
                            y: cur_y + h_size,
                            size: h_size,
                            color: ink_primary,
                            use_mono: false,
                            text: line,
                        });
                        cur_y += h_size * 1.42;
                    }

                    if *level <= 2 {
                        let pg = layout.pages.len() - 1;
                        layout.pages[pg].push(DrawCmd::FillRect {
                            x: margin,
                            y: cur_y - 1.0,
                            w: content_w,
                            h: 0.6,
                            color: rule_light,
                        });
                        cur_y += 6.0;
                    } else {
                        cur_y += 3.0;
                    }
                }

                BlockKind::Table { .. } => {
                    if let Some(tbl) = GfmTableModel::parse(trimmed_blk) {
                        let col_count = tbl.headers.len().max(1);
                        let col_w = content_w / (col_count as f32);
                        let row_h = 20.0f32;
                        ensure_space(row_h * 2.5, &mut cur_y, &mut layout);
                        cur_y += 4.0;

                        let pg = layout.pages.len() - 1;
                        // Top heavy formal three-line rule (`1.2pt`)
                        layout.pages[pg].push(DrawCmd::FillRect {
                            x: margin,
                            y: cur_y,
                            w: content_w,
                            h: 1.2,
                            color: ink_primary,
                        });
                        if options.preset == FormalPdfPreset::TechnicalSpec {
                            layout.pages[pg].push(DrawCmd::FillRect {
                                x: margin,
                                y: cur_y + 1.2,
                                w: content_w,
                                h: row_h,
                                color: surface_subtle,
                            });
                        }
                        for (c_ix, header) in tbl.headers.iter().enumerate() {
                            let clean_cell = strip_inline_markdown_for_formal_pdf(header);
                            layout.pages[pg].push(DrawCmd::Text {
                                x: margin + (c_ix as f32) * col_w + 5.0,
                                y: cur_y + 14.0,
                                size: 9.0,
                                color: ink_primary,
                                use_mono: false,
                                text: clean_cell,
                            });
                        }
                        cur_y += row_h + 1.2;

                        // Header bottom mid rule (`0.7pt`)
                        layout.pages[pg].push(DrawCmd::FillRect {
                            x: margin,
                            y: cur_y,
                            w: content_w,
                            h: 0.7,
                            color: ink_secondary,
                        });
                        cur_y += 1.0;

                        for row in &tbl.rows {
                            ensure_space(row_h + 4.0, &mut cur_y, &mut layout);
                            let r_pg = layout.pages.len() - 1;
                            for (c_ix, cell) in row.iter().take(col_count).enumerate() {
                                let clean_cell = strip_inline_markdown_for_formal_pdf(cell);
                                layout.pages[r_pg].push(DrawCmd::Text {
                                    x: margin + (c_ix as f32) * col_w + 5.0,
                                    y: cur_y + 13.5,
                                    size: 8.8,
                                    color: ink_secondary,
                                    use_mono: false,
                                    text: clean_cell,
                                });
                            }
                            cur_y += row_h;
                            if options.preset == FormalPdfPreset::TechnicalSpec {
                                layout.pages[r_pg].push(DrawCmd::FillRect {
                                    x: margin,
                                    y: cur_y,
                                    w: content_w,
                                    h: 0.4,
                                    color: rule_light,
                                });
                            }
                        }

                        // Bottom heavy formal three-line rule (`1.2pt`)
                        let end_pg = layout.pages.len() - 1;
                        layout.pages[end_pg].push(DrawCmd::FillRect {
                            x: margin,
                            y: cur_y,
                            w: content_w,
                            h: 1.2,
                            color: ink_primary,
                        });
                        cur_y += 12.0;
                    }
                }

                BlockKind::CodeBlock { .. } | BlockKind::MermaidBlock => {
                    let mut code_lines: Vec<&str> = trimmed_blk.lines().collect();
                    if code_lines.first().map(|l| l.trim_start().starts_with("```") || l.trim_start().starts_with("~~~")).unwrap_or(false) {
                        code_lines.remove(0);
                    }
                    if code_lines.last().map(|l| l.trim_start().starts_with("```") || l.trim_start().starts_with("~~~")).unwrap_or(false) {
                        code_lines.pop();
                    }

                    let line_h = 13.0f32;
                    let box_h = (code_lines.len() as f32) * line_h + 14.0;
                    ensure_space(box_h.min(140.0), &mut cur_y, &mut layout);

                    for raw_cl in code_lines {
                        ensure_space(line_h + 4.0, &mut cur_y, &mut layout);
                        let pg = layout.pages.len() - 1;
                        layout.pages[pg].push(DrawCmd::FillRect {
                            x: margin,
                            y: cur_y,
                            w: content_w,
                            h: line_h + 1.0,
                            color: surface_subtle,
                        });
                        let wrapped_code = wrap_mixed_line(raw_cl, 8.5, content_w - 16.0, true);
                        for sub in wrapped_code {
                            ensure_space(line_h + 2.0, &mut cur_y, &mut layout);
                            let c_pg = layout.pages.len() - 1;
                            layout.pages[c_pg].push(DrawCmd::Text {
                                x: margin + 8.0,
                                y: cur_y + 10.0,
                                size: 8.5,
                                color: ink_primary,
                                use_mono: true,
                                text: sub,
                            });
                            cur_y += line_h;
                        }
                    }
                    cur_y += 10.0;
                }

                BlockKind::ThematicBreak => {
                    ensure_space(16.0, &mut cur_y, &mut layout);
                    let pg = layout.pages.len() - 1;
                    layout.pages[pg].push(DrawCmd::FillRect {
                        x: margin,
                        y: cur_y + 6.0,
                        w: content_w,
                        h: 0.75,
                        color: rule_light,
                    });
                    cur_y += 14.0;
                }

                _ => {
                    let body_size = 10.2f32;
                    let line_step = 16.8f32;
                    for raw_line in trimmed_blk.lines() {
                        let clean_line = strip_inline_markdown_for_formal_pdf(
                            raw_line.trim_start_matches('>').trim(),
                        );
                        if clean_line.is_empty() {
                            continue;
                        }
                        let normalized = clean_line
                            .replacen("- [x] ", "[✓] ", 1)
                            .replacen("- [X] ", "[✓] ", 1)
                            .replacen("- [ ] ", "[ ] ", 1);

                        let with_indent = if options.preset == FormalPdfPreset::OfficialReport
                            && matches!(blk.kind, BlockKind::Paragraph)
                        {
                            format!("　　{}", normalized)
                        } else {
                            normalized
                        };

                        for wline in wrap_mixed_line(&with_indent, body_size, content_w, false) {
                            ensure_space(line_step, &mut cur_y, &mut layout);
                            let pg = layout.pages.len() - 1;
                            layout.pages[pg].push(DrawCmd::Text {
                                x: margin,
                                y: cur_y + body_size,
                                size: body_size,
                                color: ink_secondary,
                                use_mono: false,
                                text: wline,
                            });
                            cur_y += line_step;
                        }
                    }
                    cur_y += 6.0;
                }
            }
        }

        // 4. Render Pass: Emit PDF 1.7 Vector Pages + Running Header & Exact `第 X 页 / 共 Y 页` Footer
        let total_pages = layout.pages.len().max(1);
        let mut document = Document::new();

        for (page_idx, cmds) in layout.pages.into_iter().enumerate() {
            let page_settings = PageSettings::from_wh(page_w, page_h)
                .ok_or_else(|| anyhow!("Invalid PDF page dimensions"))?;
            let mut page = document.start_page_with(page_settings);
            let mut surface = page.surface();

            // Running Header & Footer (skip running header on page 1 if cover block is shown)
            if options.include_header_footer {
                if page_idx > 0 || !options.include_cover_meta {
                    set_solid_fill(&mut surface, ink_muted);
                    surface.draw_text(
                        Point::from_xy(margin, margin - 6.0),
                        fonts.body.clone(),
                        8.0,
                        &self.title,
                        false,
                        TextDirection::Auto,
                    );
                    draw_filled_rect(
                        &mut surface,
                        margin,
                        margin - 2.0,
                        content_w,
                        0.5,
                        rule_light,
                    );
                }

                let footer_label = match options.preset {
                    FormalPdfPreset::OfficialReport => format!("— {} —", page_idx + 1),
                    _ => format!("第 {} 页 / 共 {} 页", page_idx + 1, total_pages),
                };
                let fw = estimate_text_width_pt(&footer_label, 8.5, false);
                draw_filled_rect(
                    &mut surface,
                    margin,
                    page_h - margin - 10.0,
                    content_w,
                    0.5,
                    rule_light,
                );
                set_solid_fill(&mut surface, ink_muted);
                surface.draw_text(
                    Point::from_xy(margin + (content_w - fw) * 0.5, page_h - margin + 2.0),
                    fonts.body.clone(),
                    8.5,
                    &footer_label,
                    false,
                    TextDirection::Auto,
                );
            }

            // Execute page drawing commands
            for cmd in cmds {
                match cmd {
                    DrawCmd::FillRect { x, y, w, h, color } => {
                        draw_filled_rect(&mut surface, x, y, w, h, color);
                    }
                    DrawCmd::Text {
                        x,
                        y,
                        size,
                        color,
                        use_mono,
                        text,
                    } => {
                        set_solid_fill(&mut surface, color);
                        let f = if use_mono {
                            fonts.mono.clone()
                        } else {
                            fonts.body.clone()
                        };
                        surface.draw_text(
                            Point::from_xy(x, y),
                            f,
                            size,
                            &text,
                            false,
                            TextDirection::Auto,
                        );
                    }
                }
            }

            surface.finish();
            page.finish();
        }

        let pdf_bytes = document
            .finish()
            .map_err(|e| anyhow!("Krilla PDF serialization error: {:?}", e))?;
        Ok(pdf_bytes)
    }
}

fn set_solid_fill(surface: &mut krilla::surface::Surface<'_>, c: RgbTriplet) {
    surface.set_fill(Some(Fill {
        paint: rgb::Color::new(c.0, c.1, c.2).into(),
        rule: FillRule::NonZero,
        opacity: NormalizedF32::ONE,
    }));
}

fn draw_filled_rect(
    surface: &mut krilla::surface::Surface<'_>,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    c: RgbTriplet,
) {
    let mut pb = PathBuilder::new();
    pb.move_to(x, y);
    pb.line_to(x + w, y);
    pb.line_to(x + w, y + h);
    pb.line_to(x, y + h);
    pb.close();
    if let Some(path) = pb.finish() {
        set_solid_fill(surface, c);
        surface.draw_path(&path);
    }
}
