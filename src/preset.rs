//! src/preset.rs — 滤镜预置风格包
//! 电影感 / 日系 / 复古 / 清爽 / 黑白

/// 预置中的一个滤镜条目
pub struct PresetEntry {
    pub kind: &'static str,
    pub params: &'static [(&'static str, f64)],
}

/// 风格包
pub struct PresetPack {
    pub name: &'static str,
    pub display: &'static str,
    pub filters: &'static [PresetEntry],
}

/// 内置滤镜预置
pub const FILTER_PRESETS: &[PresetPack] = &[
    PresetPack {
        name: "cinematic", display: "电影感",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("brightness", -0.05), ("contrast", 1.2), ("saturation", 0.9)] },
            PresetEntry { kind: "fade", params: &[("type", 0.0), ("duration", 0.4)] },
        ],
    },
    PresetPack {
        name: "japanese", display: "日系",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("brightness", 0.08), ("contrast", 0.9), ("saturation", 1.1)] },
        ],
    },
    PresetPack {
        name: "vintage", display: "复古",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("brightness", 0.02), ("contrast", 0.95), ("saturation", 0.8), ("gamma", 1.1)] },
        ],
    },
    PresetPack {
        name: "fresh", display: "清爽",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("brightness", 0.05), ("contrast", 1.05), ("saturation", 1.15)] },
        ],
    },
    PresetPack {
        name: "mono", display: "黑白",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("saturation", 0.0), ("contrast", 1.1)] },
        ],
    },
];

pub fn preset_names() -> Vec<String> { FILTER_PRESETS.iter().map(|p| p.name.to_string()).collect() }
pub fn preset_displays() -> Vec<String> { FILTER_PRESETS.iter().map(|p| p.display.to_string()).collect() }
pub fn find_preset(name: &str) -> Option<&'static PresetPack> { FILTER_PRESETS.iter().find(|p| p.name == name) }
