use gpui::{FontStyle, FontWeight, HighlightStyle, Rgba, rgba};
use lru::LruCache;
use std::{num::NonZeroUsize, ops::Range};
use syntect::{
    easy::HighlightLines,
    highlighting::{FontStyle as SynFontStyle, ThemeSet},
    parsing::SyntaxSet,
    util::LinesWithEndings,
};

/// Bounded LRU syntax highlighter (`PRD CD-01` & `Section 7.2` Lazy Heavy Components).
///
/// Caches `gpui::HighlightStyle` byte spans keyed by `(is_dark, blake3_u64_hash)` so scrolling
/// a 100,000-word file with hundreds of code blocks never allocates or re-tokenizes on frame paint.
pub struct BoundedCodeHighlighter {
    syntax_set: SyntaxSet,
    theme_set: ThemeSet,
    cache: LruCache<(bool, u64), Vec<(Range<usize>, HighlightStyle)>>,
}

impl BoundedCodeHighlighter {
    pub fn new() -> Self {
        Self {
            syntax_set: SyntaxSet::load_defaults_newlines(),
            theme_set: ThemeSet::load_defaults(),
            cache: LruCache::new(NonZeroUsize::new(256).expect("non-zero capacity")),
        }
    }

    pub fn highlight_code(
        &mut self,
        lang: &str,
        code: &str,
        is_dark: bool,
    ) -> Vec<(Range<usize>, HighlightStyle)> {
        let mut hasher = blake3::Hasher::new();
        hasher.update(lang.as_bytes());
        hasher.update(code.as_bytes());
        let hash_bytes = hasher.finalize();
        let key_hash = u64::from_le_bytes(hash_bytes.as_bytes()[..8].try_into().unwrap_or([0; 8]));

        if let Some(cached) = self.cache.get(&(is_dark, key_hash)) {
            return cached.clone();
        }

        let syntax = self
            .syntax_set
            .find_syntax_by_token(lang)
            .unwrap_or_else(|| self.syntax_set.find_syntax_plain_text());
        let theme_name = if is_dark {
            "base16-ocean.dark"
        } else {
            "InspiredGitHub"
        };
        let syn_theme = &self.theme_set.themes[theme_name];
        let mut h = HighlightLines::new(syntax, syn_theme);

        let mut spans = Vec::new();
        let mut cursor = 0usize;

        for line in LinesWithEndings::from(code) {
            if let Ok(ranges) = h.highlight_line(line, &self.syntax_set) {
                for (style, token_str) in ranges {
                    let len = token_str.len();
                    if len > 0 {
                        let fg = Rgba {
                            r: style.foreground.r as f32 / 255.0,
                            g: style.foreground.g as f32 / 255.0,
                            b: style.foreground.b as f32 / 255.0,
                            a: 1.0,
                        };
                        let mut hl = HighlightStyle {
                            color: Some(fg.into()),
                            ..Default::default()
                        };
                        if style.font_style.contains(SynFontStyle::BOLD) {
                            hl.font_weight = Some(FontWeight::SEMIBOLD);
                        }
                        if style.font_style.contains(SynFontStyle::ITALIC) {
                            hl.font_style = Some(FontStyle::Italic);
                        }
                        spans.push((cursor..(cursor + len), hl));
                        cursor += len;
                    }
                }
            } else {
                cursor += line.len();
            }
        }

        let _ = rgba(0x00000000);
        self.cache.put((is_dark, key_hash), spans.clone());
        spans
    }
}
