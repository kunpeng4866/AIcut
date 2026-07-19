//! tests/integration_test.rs — AIcut Phase 4 子任务 C 集成验证
//!
//! 覆盖场景：
//!   1. render 基本路径（视频 clip + coloradjust + 关键帧）
//!   2. 滤镜降级路径（mask 在沙盒无独立滤镜 → 被跳过，不 panic）
//!   3. get_preset_list 返回非空预置列表
//!   4. get_version 返回含版本号字符串
//!
//! 纯公开 API 调用，不引入新依赖；JSON 直接以字面量构造（规避字段可见性/反序列化细节）。

use aicut_engine::{get_preset_list, get_version, render};

/// 构造一个最小工程 JSON：1 个视频 clip + 1 个 coloradjust 滤镜 + 1 个 opacity 关键帧
fn basic_project_json() -> String {
    r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30, "sample_rate": 48000 },
        "assets": [
            { "id": "a1", "type": "video", "path": "input.mp4", "duration": 5.0, "width": 1920, "height": 1080, "codec": "h264" }
        ],
        "tracks": [
            {
                "id": "v1", "type": "video", "order": 0,
                "clips": [
                    {
                        "id": "c1",
                        "assetId": "a1",
                        "src_range": { "start": 0.0, "end": 5.0 },
                        "timelineIn": 0.0,
                        "timelineOut": 5.0,
                        "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 0.0, "opacity": 1.0 },
                        "volume": 1.0, "speed": 1.0,
                        "effects": [],
                        "masks": [],
                        "filters": [
                            { "kind": "coloradjust", "params": { "brightness": 0.0, "contrast": 1.0, "saturation": 1.0, "gamma": 1.0 }, "enabled": true }
                        ],
                        "keyframes": {
                            "transform.opacity": { "keyframes": [ { "time": 0.0, "value": 1.0, "easing": "Linear" }, { "time": 5.0, "value": 0.5, "easing": "EaseOut" } ] }
                        }
                    }
                ]
            }
        ]
    }"#
    .to_string()
}

/// 构造含 mask 滤镜的工程 JSON（mask 在沙盒无独立滤镜，应被降级跳过）
fn mask_project_json() -> String {
    r#"{
        "version": "1.0",
        "canvas": { "width": 1280, "height": 720, "fps": 30, "sample_rate": 48000 },
        "assets": [
            { "id": "a1", "type": "video", "path": "input.mp4", "duration": 3.0, "width": 1280, "height": 720, "codec": "h264" }
        ],
        "tracks": [
            {
                "id": "v1", "type": "video", "order": 0,
                "clips": [
                    {
                        "id": "c1",
                        "assetId": "a1",
                        "src_range": { "start": 0.0, "end": 3.0 },
                        "timelineIn": 0.0,
                        "timelineOut": 3.0,
                        "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 0.0, "opacity": 1.0 },
                        "volume": 1.0, "speed": 1.0,
                        "effects": [],
                        "masks": [],
                        "filters": [
                            { "kind": "mask", "params": { "feather": 0.0, "invert": 0.0 }, "enabled": true }
                        ],
                        "keyframes": {}
                    }
                ]
            }
        ]
    }"#
    .to_string()
}

#[test]
fn test_render_basic_path() {
    let json = basic_project_json();
    let cmd = render(&json).expect("render 不应返回 Err");

    // 1) 命令非空
    assert!(!cmd.is_empty(), "render 返回的 FFmpeg 命令不应为空");

    // 2) 基本结构存在
    assert!(cmd.starts_with("ffmpeg -y"), "命令应以 ffmpeg -y 开头");
    assert!(cmd.contains("-filter_complex"), "命令应含 -filter_complex");
    assert!(cmd.contains("output.mp4"), "命令应含输出文件 output.mp4");

    // 3) coloradjust 滤镜已映射为 ffmpeg 滤镜串。
    //    本沙盒 ffmpeg 可用 eq → 产出 "eq=..."；若 eq 不可用则降级为 "brightness=0:contrast=1"。
    //    两者均含 brightness/contrast 键，断言其二选一即可稳定覆盖两种环境。
    assert!(
        cmd.contains("eq=") || cmd.contains("brightness="),
        "coloradjust 应映射为 eq=... 或降级 brightness=...，实际命令: {}",
        cmd
    );
}

#[test]
fn test_render_mask_degrade_path() {
    let json = mask_project_json();
    // 关键不变量：含 mask 滤镜不应 panic 且返回 Ok
    let cmd = render(&json).expect("含 mask 的工程不应 panic / 返回 Err");

    assert!(!cmd.is_empty(), "含 mask 的工程命令不应为空");

    // 本沙盒 ffmpeg 不含独立 "mask" 滤镜（已验证），degrade_filter("mask") 返回 None → 被跳过。
    // 因此最终命令不应出现 "mask=" 滤镜 token。
    assert!(
        !cmd.contains("mask="),
        "mask 滤镜在沙盒不可用时应被降级跳过，不应出现 mask=，实际命令: {}",
        cmd
    );

    // 即便 mask 被跳过，基础合成链路（scale + overlay）仍应存在，命令结构有效
    assert!(cmd.contains("scale="), "即便 mask 被跳过，scale 合成链路应存在");
    assert!(cmd.contains("overlay="), "即便 mask 被跳过，overlay 合成链路应存在");
}

#[test]
fn test_get_preset_list() {
    let presets = get_preset_list();
    assert!(!presets.is_empty(), "get_preset_list 应返回非空列表");
    assert!(
        presets.contains(&"cinematic".to_string()),
        "预置列表应包含内置 cinematic，实际: {:?}",
        presets
    );
    assert!(presets.len() >= 5, "应至少含 5 个内置预置，实际: {:?}", presets);
}

#[test]
fn test_get_version() {
    let v = get_version();
    assert!(!v.is_empty(), "get_version 应返回非空字符串");
    assert!(v.contains("aicut-engine"), "版本串应包含引擎名，实际: {}", v);
    assert!(
        v.chars().any(|c| c.is_ascii_digit()),
        "版本串应包含版本号数字，实际: {}",
        v
    );
}

/// 构造含变速的工程 JSON
fn speed_project_json() -> String {
    r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30, "sample_rate": 48000 },
        "assets": [
            { "id": "a1", "type": "video", "path": "input.mp4", "duration": 5.0, "width": 1920, "height": 1080, "codec": "h264" }
        ],
        "tracks": [
            {
                "id": "v1", "type": "video", "order": 0,
                "clips": [
                    {
                        "id": "c1",
                        "assetId": "a1",
                        "src_range": { "start": 0.0, "end": 5.0 },
                        "timelineIn": 0.0,
                        "timelineOut": 5.0,
                        "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 0.0, "opacity": 1.0 },
                        "volume": 1.0, "speed": 2.0,
                        "effects": [],
                        "masks": [],
                        "filters": [],
                        "keyframes": {}
                    }
                ]
            }
        ]
    }"#
    .to_string()
}

#[test]
fn test_render_speed() {
    let json = speed_project_json();
    let cmd = render(&json).expect("变速工程不应 panic");
    assert!(cmd.contains("setpts="), "2x 变速应含 setpts，实际: {}", cmd);
}

/// 构造含音频轨道的工程 JSON
fn audio_project_json() -> String {
    r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30, "sample_rate": 48000 },
        "assets": [
            { "id": "v1", "type": "video", "path": "video.mp4", "duration": 10.0, "width": 1920, "height": 1080, "codec": "h264" },
            { "id": "a1", "type": "audio", "path": "music.mp3", "duration": 8.0 }
        ],
        "tracks": [
            {
                "id": "vt1", "type": "video", "order": 0,
                "clips": [
                    {
                        "id": "vc1",
                        "assetId": "v1",
                        "src_range": { "start": 0.0, "end": 10.0 },
                        "timelineIn": 0.0,
                        "timelineOut": 10.0,
                        "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 0.0, "opacity": 1.0 },
                        "volume": 1.0, "speed": 1.0,
                        "effects": [],
                        "masks": [],
                        "filters": [],
                        "keyframes": {}
                    }
                ]
            },
            {
                "id": "at1", "type": "audio", "order": 1,
                "clips": [
                    {
                        "id": "ac1",
                        "assetId": "a1",
                        "src_range": { "start": 0.0, "end": 8.0 },
                        "timelineIn": 0.0,
                        "timelineOut": 8.0,
                        "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 0.0, "opacity": 1.0 },
                        "volume": 0.8, "speed": 1.0,
                        "effects": [],
                        "masks": [],
                        "filters": [],
                        "keyframes": {}
                    }
                ]
            }
        ]
    }"#
    .to_string()
}

#[test]
fn test_render_audio_track() {
    let json = audio_project_json();
    let cmd = render(&json).expect("音频工程不应 panic");
    assert!(cmd.contains(":a]"), "应含音频输入流标记 :a]，实际: {}", cmd);
    assert!(cmd.contains("volume="), "应含 volume 滤镜，实际: {}", cmd);
    assert!(!cmd.contains("[aout]"), "单音频轨不应产生 amix/aout 标签");
}

/// 构造含旋转的工程 JSON
fn rotation_project_json() -> String {
    r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30, "sample_rate": 48000 },
        "assets": [
            { "id": "a1", "type": "video", "path": "input.mp4", "duration": 3.0, "width": 1920, "height": 1080, "codec": "h264" }
        ],
        "tracks": [
            {
                "id": "v1", "type": "video", "order": 0,
                "clips": [
                    {
                        "id": "c1",
                        "assetId": "a1",
                        "src_range": { "start": 0.0, "end": 3.0 },
                        "timelineIn": 0.0,
                        "timelineOut": 3.0,
                        "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 90.0, "opacity": 1.0 },
                        "volume": 1.0, "speed": 1.0,
                        "effects": [],
                        "masks": [],
                        "filters": [],
                        "keyframes": {}
                    }
                ]
            }
        ]
    }"#
    .to_string()
}

#[test]
fn test_render_rotation() {
    let json = rotation_project_json();
    let cmd = render(&json).expect("旋转工程不应 panic");
    assert!(cmd.contains("rotate="), "90度旋转应含 rotate，实际: {}", cmd);
}

/// 构造含过渡的双片段工程 JSON（同轨重叠 = xfade）
fn transition_project_json() -> String {
    r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30, "sample_rate": 48000 },
        "assets": [
            { "id": "a1", "type": "video", "path": "clip1.mp4", "duration": 5.0, "width": 1920, "height": 1080, "codec": "h264" },
            { "id": "a2", "type": "video", "path": "clip2.mp4", "duration": 5.0, "width": 1920, "height": 1080, "codec": "h264" }
        ],
        "tracks": [
            {
                "id": "v1", "type": "video", "order": 0,
                "clips": [
                    {
                        "id": "c1",
                        "assetId": "a1",
                        "src_range": { "start": 0.0, "end": 5.0 },
                        "timelineIn": 0.0,
                        "timelineOut": 4.0,
                        "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 0.0, "opacity": 1.0 },
                        "volume": 1.0, "speed": 1.0,
                        "effects": [], "masks": [],
                        "filters": [ { "kind": "transition", "params": { "duration": 0.5 }, "enabled": true } ],
                        "keyframes": {}
                    },
                    {
                        "id": "c2",
                        "assetId": "a2",
                        "src_range": { "start": 0.0, "end": 5.0 },
                        "timelineIn": 3.0,
                        "timelineOut": 8.0,
                        "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 0.0, "opacity": 1.0 },
                        "volume": 1.0, "speed": 1.0,
                        "effects": [], "masks": [],
                        "filters": [],
                        "keyframes": {}
                    }
                ]
            }
        ]
    }"#
    .to_string()
}

#[test]
fn test_render_xfade_transition() {
    let json = transition_project_json();
    let cmd = render(&json).expect("过渡工程不应 panic");
    assert!(cmd.contains("xfade="), "同轨重叠过渡应含 xfade，实际: {}", cmd);
    // xfade 应含 fps 参数
    assert!(cmd.contains("fps="), "xfade 应含 fps 参数，实际: {}", cmd);
}

// ════════════════════ P0 edge case 测试 ════════════════════

#[test]
fn test_render_empty_project() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080},"assets":[],"tracks":[]}"#;
    let cmd = render(&json.to_string()).expect("空工程不应 panic");
    assert!(cmd.contains("ffmpeg"), "空工程也应有基本 ffmpeg 命令结构");
}

#[test]
fn test_render_multi_track_overlay() {
    let json = r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30 },
        "assets": [
            { "id": "bg", "type": "video", "path": "bg.mp4", "duration": 10.0, "width": 1920, "height": 1080, "codec": "h264" },
            { "id": "pip", "type": "video", "path": "pip.mp4", "duration": 5.0, "width": 640, "height": 480, "codec": "h264" }
        ],
        "tracks": [
            { "id": "t1", "type": "video", "order": 0, "clips": [
                { "id": "c1", "assetId": "bg", "src_range": { "start": 0.0, "end": 10.0 }, "timelineIn": 0.0, "timelineOut": 10.0,
                  "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0 }, "volume": 1.0, "speed": 1.0,
                  "effects": [], "masks": [], "filters": [], "keyframes": {} }
            ]},
            { "id": "t2", "type": "video", "order": 1, "clips": [
                { "id": "c2", "assetId": "pip", "src_range": { "start": 0.0, "end": 5.0 }, "timelineIn": 2.0, "timelineOut": 7.0,
                  "transform": { "x": 0.8, "y": 0.8, "scale_x": 0.3, "scale_y": 0.3 }, "volume": 1.0, "speed": 1.0,
                  "effects": [], "masks": [], "filters": [], "keyframes": {} }
            ]}
        ]
    }"#;
    let cmd = render(&json.to_string()).expect("多轨工程不应 panic");
    assert!(cmd.contains("overlay="), "多轨应含 overlay, 实际: {}", cmd);
    // PIP 轨应缩小
    assert!(cmd.contains("scale=576:324"), "PIP 应缩小到 30%, 实际: {}", cmd);
}

#[test]
fn test_render_invalid_json() {
    let result = render("not valid json");
    assert!(result.is_err(), "无效 JSON 应返回 Err");
}

#[test]
fn test_render_multi_audio_amix() {
    let json = r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30, "sample_rate": 48000 },
        "assets": [
            { "id": "v1", "type": "video", "path": "v.mp4", "duration": 10.0, "width": 1920, "height": 1080, "codec": "h264" },
            { "id": "a1", "type": "audio", "path": "bgm.mp3", "duration": 5.0 },
            { "id": "a2", "type": "audio", "path": "voice.mp3", "duration": 3.0 }
        ],
        "tracks": [
            { "id": "vt1", "type": "video", "order": 0, "clips": [
                { "id": "vc1", "assetId": "v1", "src_range": { "start": 0.0, "end": 10.0 }, "timelineIn": 0.0, "timelineOut": 10.0,
                  "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0 }, "volume": 1.0, "speed": 1.0,
                  "effects": [], "masks": [], "filters": [], "keyframes": {} }
            ]},
            { "id": "at1", "type": "audio", "order": 1, "clips": [
                { "id": "ac1", "assetId": "a1", "src_range": { "start": 0.0, "end": 5.0 }, "timelineIn": 0.0, "timelineOut": 5.0,
                  "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0 }, "volume": 0.7, "speed": 1.0,
                  "effects": [], "masks": [], "filters": [], "keyframes": {} },
                { "id": "ac2", "assetId": "a2", "src_range": { "start": 0.0, "end": 3.0 }, "timelineIn": 0.0, "timelineOut": 3.0,
                  "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0 }, "volume": 0.5, "speed": 1.0,
                  "effects": [], "masks": [], "filters": [], "keyframes": {} }
            ]}
        ]
    }"#;
    let cmd = render(&json.to_string()).expect("多音频工程不应 panic");
    assert!(cmd.contains("amix="), "多音频应含 amix 混音，实际: {}", cmd);
}

#[test]
fn test_render_combined_filters() {
    let json = r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30 },
        "assets": [
            { "id": "a1", "type": "video", "path": "in.mp4", "duration": 5.0, "width": 1920, "height": 1080, "codec": "h264" }
        ],
        "tracks": [
            { "id": "v1", "type": "video", "order": 0, "clips": [
                { "id": "c1", "assetId": "a1", "src_range": { "start": 0.0, "end": 5.0 }, "timelineIn": 0.0, "timelineOut": 5.0,
                  "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0, "rotation": 45.0, "opacity": 0.8 },
                  "volume": 1.0, "speed": 2.0,
                  "effects": [], "masks": [],
                  "filters": [ { "kind": "coloradjust", "params": { "brightness": 0.1, "contrast": 1.2 }, "enabled": true } ],
                  "keyframes": { "transform.opacity": { "keyframes": [ {"time": 0.0, "value": 0.8, "easing": "Linear"}, {"time": 5.0, "value": 0.3, "easing": "EaseOut"} ] } }
                }
            ]}
        ]
    }"#;
    let cmd = render(&json.to_string()).expect("组合滤镜工程不应 panic");
    assert!(cmd.contains("rotate="), "应含 rotate");
    assert!(cmd.contains("setpts="), "应含 setpts（变速）");
    assert!(cmd.contains("eq=") || cmd.contains("brightness="), "应含调色滤镜");
    assert!(cmd.contains("colorchannelmixer=aa="), "应含透明度调整");
}

#[test]
fn test_render_flip() {
    let json = r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30 },
        "assets": [ { "id": "a1", "type": "video", "path": "in.mp4", "duration": 3.0, "width": 1920, "height": 1080, "codec": "h264" } ],
        "tracks": [ { "id": "v1", "type": "video", "order": 0, "clips": [
            { "id": "c1", "assetId": "a1", "src_range": { "start": 0.0, "end": 3.0 }, "timelineIn": 0.0, "timelineOut": 3.0,
              "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0 }, "volume": 1.0, "speed": 1.0,
              "effects": [], "masks": [], "filters": [ { "kind": "flip", "params": { "horizontal": 1.0, "vertical": 0.0 }, "enabled": true } ], "keyframes": {} }
        ] } ]
    }"#;
    let cmd = render(&json.to_string()).expect("翻转工程不应 panic");
    assert!(cmd.contains("hflip"), "水平翻转应含 hflip，实际: {}", cmd);
}

#[test]
fn test_render_chromakey() {
    let json = r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30 },
        "assets": [ { "id": "a1", "type": "video", "path": "green.mp4", "duration": 3.0, "width": 1920, "height": 1080, "codec": "h264" } ],
        "tracks": [ { "id": "v1", "type": "video", "order": 0, "clips": [
            { "id": "c1", "assetId": "a1", "src_range": { "start": 0.0, "end": 3.0 }, "timelineIn": 0.0, "timelineOut": 3.0,
              "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0 }, "volume": 1.0, "speed": 1.0,
              "effects": [], "masks": [],
              "filters": [ { "kind": "chromakey", "params": { "similarity": 0.1, "blend": 0.0 }, "enabled": true } ],
              "keyframes": {} }
        ] } ]
    }"#;
    let cmd = render(&json.to_string()).expect("色度抠图不应 panic");
    assert!(cmd.contains("chromakey="), "应含 chromakey 滤镜，实际: {}", cmd);
}

#[test]
fn test_resolve_hw_encoder() {
    // 验证硬件编码器解析
    assert_eq!(aicut_engine::ffmpeg::resolve_encoder("nvenc", "h264"), "h264_nvenc");
    assert_eq!(aicut_engine::ffmpeg::resolve_encoder("nvenc", "h265"), "hevc_nvenc");
    assert_eq!(aicut_engine::ffmpeg::resolve_encoder("software", "h264"), "libx264");
    assert_eq!(aicut_engine::ffmpeg::resolve_encoder("", "h265"), "libx265");
    assert_eq!(aicut_engine::ffmpeg::resolve_encoder("unknown", "h264"), "libx264");
}

// ════════════════════ 大工程压测 ════════════════════

#[test]
fn test_render_large_project() {
    // 构造 50 个视频 clip + 30 个音频 clip 的大工程
    let mut assets_json = String::from("[");
    for i in 0..80 {
        if i > 0 { assets_json.push(','); }
        assets_json.push_str(&format!(
            r#"{{"id":"a{}","type":"{}","path":"f{}.mp4","duration":5.0,"width":1920,"height":1080,"codec":"h264"}}"#,
            i, if i < 50 { "video" } else { "audio" }, i
        ));
    }
    assets_json.push(']');

    let mut video_clips_json = String::new();
    for i in 0..50 {
        if i > 0 { video_clips_json.push(','); }
        video_clips_json.push_str(&format!(
            r#"{{"id":"vc{}","assetId":"a{}","src_range":{{"start":0.0,"end":5.0}},"timelineIn":{},"timelineOut":{},"transform":{{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0}},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[],"keyframes":{{}}}}"#,
            i, i, i as f64 * 5.0, (i + 1) as f64 * 5.0
        ));
    }

    let mut audio_clips_json = String::new();
    for i in 50..80 {
        if i > 50 { audio_clips_json.push(','); }
        audio_clips_json.push_str(&format!(
            r#"{{"id":"ac{}","assetId":"a{}","src_range":{{"start":0.0,"end":5.0}},"timelineIn":0.0,"timelineOut":5.0,"transform":{{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0}},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[],"keyframes":{{}}}}"#,
            i, i
        ));
    }

    let json = format!(
        r#"{{"version":"1.0","canvas":{{"width":1920,"height":1080,"fps":30,"sample_rate":48000}},"assets":{},"tracks":[{{"id":"vt","type":"video","order":0,"clips":[{}]}},{{"id":"at","type":"audio","order":1,"clips":[{}]}}]}}"#,
        assets_json, video_clips_json, audio_clips_json
    );

    let start = std::time::Instant::now();
    let cmd = render(&json).expect("大工程不应 panic");
    let elapsed = start.elapsed();

    // 性能断言：80 clips 应在 2s 内完成
    assert!(elapsed.as_millis() < 2000,
        "大工程渲染太慢: {}ms", elapsed.as_millis());
    assert!(!cmd.is_empty(), "大工程命令不应为空");
    assert!(cmd.contains("ffmpeg"), "大工程命令结构应完整");
    // 50 同轨 video clip → concat 链；30 audio clip → amix
    let filter_nodes = cmd.matches(';').count();
    assert!(filter_nodes >= 30, "80 clips 应有 ≥30 个滤镜节点，实际: {}", filter_nodes);
}
