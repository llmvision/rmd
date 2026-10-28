use gpui::{Rgba, px, Pixels, rgb, rgba};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageWidthPreset {
    Narrow,
    Standard,
    Wide,
}

impl PageWidthPreset {
    pub fn max_width_px(self) -> Pixels {
        match self {
            Self::Narrow => px(680.0),
            Self::Standard => px(860.0),
            Self::Wide => px(1120.0),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Narrow => "窄版 680px",
            Self::Standard => "标准 860px",
            Self::Wide => "宽屏 1120px",
        }
    }

    pub fn next(self) -> Self {
        match self {
            Self::Narrow => Self::Standard,
            Self::Standard => Self::Wide,
            Self::Wide => Self::Narrow,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct VellumTheme {
    pub is_dark: bool,
    pub canvas_bg: Rgba,
    pub sidebar_bg: Rgba,
    pub surface_elevated: Rgba,
    pub code_bg: Rgba,
    pub border_hairline: Rgba,
    pub text_primary: Rgba,
    pub text_secondary: Rgba,
    pub text_muted: Rgba,
    pub syntax_delimiter: Rgba,
    pub accent_primary: Rgba,
    pub selection_bg: Rgba,
    pub body_font_px: f32,
    pub width_preset: PageWidthPreset,
}

impl VellumTheme {
    pub fn light() -> Self {
        Self {
            is_dark: false,
            canvas_bg: rgb(0xfafafa),
            sidebar_bg: rgb(0xf4f4f5),
            surface_elevated: rgb(0xffffff),
            code_bg: rgb(0xf4f4f5),
            border_hairline: rgb(0xe4e4e7),
            text_primary: rgb(0x18181b),
            text_secondary: rgb(0x3f3f46),
            text_muted: rgb(0x71717a),
            syntax_delimiter: rgb(0xa1a1aa),
            accent_primary: rgb(0x2563eb),
            selection_bg: rgba(0x2563eb26),
            body_font_px: 16.0,
            width_preset: PageWidthPreset::Standard,
        }
    }

    pub fn dark() -> Self {
        Self {
            is_dark: true,
            canvas_bg: rgb(0x0b0f17),
            sidebar_bg: rgb(0x111622),
            surface_elevated: rgb(0x161d2b),
            code_bg: rgb(0x131926),
            border_hairline: rgb(0x1f2937),
            text_primary: rgb(0xf4f4f5),
            text_secondary: rgb(0xd4d4d8),
            text_muted: rgb(0x9ca3af),
            syntax_delimiter: rgb(0x6b7280),
            accent_primary: rgb(0x3b82f6),
            selection_bg: rgba(0x3b82f633),
            body_font_px: 16.0,
            width_preset: PageWidthPreset::Standard,
        }
    }
}
