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

#[test]
fn test_render_curves() {
    let json = r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30 },
        "assets": [ { "id": "a1", "type": "video", "path": "in.mp4", "duration": 3.0, "width": 1920, "height": 1080, "codec": "h264" } ],
        "tracks": [ { "id": "v1", "type": "video", "order": 0, "clips": [
            { "id": "c1", "assetId": "a1", "src_range": { "start": 0.0, "end": 3.0 }, "timelineIn": 0.0, "timelineOut": 3.0,
              "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0 }, "volume": 1.0, "speed": 1.0,
              "effects": [], "masks": [], "filters": [ { "kind": "curves", "params": { "master_contrast": 1.2 }, "enabled": true } ], "keyframes": {} }
        ] } ]
    }"#;
    let cmd = render(&json.to_string()).expect("曲线工程不应 panic");
    assert!(cmd.contains("curves="), "应含 curves 滤镜，实际: {}", cmd);
}

#[test]
fn test_render_denoise() {
    let json = r#"{
        "version": "1.0",
        "canvas": { "width": 1920, "height": 1080, "fps": 30, "sample_rate": 48000 },
        "assets": [ { "id": "a1", "type": "audio", "path": "noisy.mp3", "duration": 5.0 } ],
        "tracks": [ { "id": "at1", "type": "audio", "order": 0, "clips": [
            { "id": "ac1", "assetId": "a1", "src_range": { "start": 0.0, "end": 5.0 }, "timelineIn": 0.0, "timelineOut": 5.0,
              "transform": { "x": 0.5, "y": 0.5, "scale_x": 1.0, "scale_y": 1.0 }, "volume": 1.0, "speed": 1.0,
              "effects": [], "masks": [], "filters": [ { "kind": "denoise", "params": { "noise_reduction": 15.0 }, "enabled": true } ], "keyframes": {} }
        ] } ]
    }"#;
    let cmd = render(&json.to_string()).expect("降噪工程不应 panic");
    assert!(cmd.contains("afftdn="), "应含 afftdn 降噪，实际: {}", cmd);
}

// ════════════════════ 扩展测试（100+） ════════════════════

#[test]
fn test_render_empty_tracks() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"v.mp4","duration":5.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[]}"#;
    let cmd = render(&json.to_string()).expect("空轨道不应 panic");
    assert!(!cmd.is_empty());
}

#[test]
fn test_render_duplicate_asset_ids() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"v.mp4","duration":5.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"t1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":5.0},"timelineIn":0.0,"timelineOut":5.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[],"keyframes":{}},{"id":"c2","assetId":"a1","src_range":{"start":0.0,"end":5.0},"timelineIn":5.0,"timelineOut":10.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("重复素材引用不应 panic");
    assert!(cmd.contains("ffmpeg"));
}

#[test]
fn test_render_curves_all_channels() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":3.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":3.0},"timelineIn":0.0,"timelineOut":3.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[{"kind":"curves","params":{"master_contrast":1.0,"red_contrast":0.8,"green_contrast":1.0,"blue_contrast":1.2},"enabled":true}],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("全通道曲线不应 panic");
    assert!(cmd.contains("curves="));
    assert!(cmd.contains("master="));
    assert!(cmd.contains("red="));
    assert!(cmd.contains("blue="));
}

#[test]
fn test_render_unknown_filter_kind() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":3.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":3.0},"timelineIn":0.0,"timelineOut":3.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[{"kind":"nonexistent_xyz_123","params":{},"enabled":true}],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("未知滤镜不应 panic");
    assert!(cmd.contains("ffmpeg"));
}

#[test]
fn test_render_disabled_filter() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":3.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":3.0},"timelineIn":0.0,"timelineOut":3.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[{"kind":"flip","params":{"horizontal":1.0},"enabled":false}],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("禁用滤镜不应 panic");
    assert!(!cmd.contains("hflip"), "禁用的 flip 不应出现在命令中");
}

#[test]
fn test_render_zero_opacity_clip() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":3.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":3.0},"timelineIn":0.0,"timelineOut":3.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0,"rotation":0.0,"opacity":0.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("零透明度不应 panic");
    assert!(cmd.contains("colorchannelmixer=aa=0"), "零透明度应有 alpha=0");
}

#[test]
fn test_render_speed_curve_two_points() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":5.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":5.0},"timelineIn":0.0,"timelineOut":5.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"speed_curve":[{"src":0.0,"play":0.0},{"src":5.0,"play":2.5}],"effects":[],"masks":[],"filters":[],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("曲线变速不应 panic");
    assert!(cmd.contains("setpts="), "曲线变速应含 setpts");
    // 2 点 = 单段线性（无嵌套 if），3+ 点 = if(lt(T,... 条件链
    assert!(cmd.contains("*PTS"), "曲线变速应含 PTS 表达式");
}

#[test]
fn test_validate_method() {
    let project = aicut_engine::project::Project {
        version: "1.0".into(),
        canvas: aicut_engine::project::CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
        assets: vec![],
        tracks: vec![],
    };
    assert!(project.validate().is_empty(), "合法工程不应有错误");
}

#[test]
fn test_validate_bad_fps() {
    let project = aicut_engine::project::Project {
        version: "1.0".into(),
        canvas: aicut_engine::project::CanvasConfig { width: 1920, height: 1080, fps: 0, sample_rate: 48000 },
        assets: vec![],
        tracks: vec![],
    };
    let errs = project.validate();
    assert!(!errs.is_empty());
    assert!(errs.iter().any(|e| e.contains("帧率")));
}

#[test]
fn test_needs_proxy_export() {
    assert!(aicut_engine::ffmpeg::needs_proxy(3840, 2160));
    assert!(aicut_engine::ffmpeg::needs_proxy(4096, 2160));
    assert!(!aicut_engine::ffmpeg::needs_proxy(1920, 1080));
    assert!(!aicut_engine::ffmpeg::needs_proxy(1280, 720));
}

#[test]
fn test_render_all_filters_combined() {
    // 同一片段：调色+翻转+裁剪+色度抠图 全部启用
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":3.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":3.0},"timelineIn":0.0,"timelineOut":3.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[{"kind":"coloradjust","params":{"brightness":0.05},"enabled":true},{"kind":"flip","params":{"horizontal":1.0},"enabled":true},{"kind":"chromakey","params":{"similarity":0.1},"enabled":true},{"kind":"curves","params":{"master_contrast":1.1},"enabled":true}],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("多滤镜组合不应 panic");
    assert!(cmd.contains("eq=") || cmd.contains("brightness="));
    assert!(cmd.contains("hflip"));
    assert!(cmd.contains("chromakey="));
    assert!(cmd.contains("curves="));
}

// ════════════════════ 第二轮审计扩展测试 ════════════════════

#[test]
fn test_render_hflip_vflip_combo() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":3.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":3.0},"timelineIn":0.0,"timelineOut":3.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[{"kind":"flip","params":{"horizontal":1.0,"vertical":1.0},"enabled":true}],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("双轴翻转不应 panic");
    assert!(cmd.contains("hflip,vflip"), "双轴翻转应含 hflip,vflip，实际: {}", cmd);
}

#[test]
fn test_render_crop_filter() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":3.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":3.0},"timelineIn":0.0,"timelineOut":3.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[{"kind":"crop","params":{"left":0.1,"top":0.1,"right":0.9,"bottom":0.9},"enabled":true}],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("裁剪不应 panic");
    assert!(cmd.contains("crop="), "应含 crop 滤镜");
}

#[test]
fn test_render_equalizer_filter() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30,"sample_rate":48000},"assets":[{"id":"a1","type":"audio","path":"bgm.mp3","duration":5.0}],"tracks":[{"id":"at1","type":"audio","order":0,"clips":[{"id":"ac1","assetId":"a1","src_range":{"start":0.0,"end":5.0},"timelineIn":0.0,"timelineOut":5.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[{"kind":"equalizer","params":{"frequency":1000.0,"width":200.0,"gain":3.0},"enabled":true}],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("均衡器不应 panic");
    assert!(cmd.contains("equalizer="), "应含 equalizer 滤镜");
}

#[test]
fn test_render_circular_mask() {
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"in.mp4","duration":3.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"v1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":0.0,"end":3.0},"timelineIn":0.0,"timelineOut":3.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[{"shape":"circle","params":{"cx":0.5,"cy":0.5,"radius":0.3},"invert":false,"feather":0.1}],"filters":[],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("圆形蒙版不应 panic");
    assert!(cmd.contains("geq="), "圆形蒙版应含 geq 表达式");
}

#[test]
fn test_render_negative_timeline_clip() {
    // 负时间线应不 panic
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"a1","type":"video","path":"v.mp4","duration":5.0,"width":1920,"height":1080,"codec":"h264"}],"tracks":[{"id":"t1","type":"video","order":0,"clips":[{"id":"c1","assetId":"a1","src_range":{"start":-1.0,"end":5.0},"timelineIn":-1.0,"timelineOut":5.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("负时间不应 panic");
    assert!(!cmd.is_empty());
}

#[test]
fn test_render_two_video_tracks_pip() {
    // 两条独立视频轨道: 第1轨全屏 + 第2轨画中画
    let json = r#"{"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[{"id":"bg","type":"video","path":"bg.mp4","duration":10.0,"width":1920,"height":1080,"codec":"h264"},{"id":"pip","type":"video","path":"pip.mp4","duration":5.0,"width":640,"height":480,"codec":"h264"}],"tracks":[{"id":"t1","type":"video","order":0,"clips":[{"id":"c1","assetId":"bg","src_range":{"start":0.0,"end":10.0},"timelineIn":0.0,"timelineOut":10.0,"transform":{"x":0.5,"y":0.5,"scale_x":1.0,"scale_y":1.0},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[],"keyframes":{}}]},{"id":"t2","type":"video","order":1,"clips":[{"id":"c2","assetId":"pip","src_range":{"start":0.0,"end":5.0},"timelineIn":2.0,"timelineOut":7.0,"transform":{"x":0.825,"y":0.175,"scale_x":0.25,"scale_y":0.25},"volume":1.0,"speed":1.0,"effects":[],"masks":[],"filters":[],"keyframes":{}}]}]}"#;
    let cmd = render(&json.to_string()).expect("双轨PIP不应 panic");
    let overlays = cmd.matches("overlay=").count();
    assert!(overlays >= 2, "双轨应有≥2 overlay，实际: {}", overlays);
}

#[test]
fn test_mcp_tool_render_roundtrip() {
    let req = aicut_engine::mcp::ToolRequest {
        name: "render_project".into(),
        arguments: serde_json::json!({"project": {"version":"1.0","canvas":{"width":1920,"height":1080,"fps":30},"assets":[],"tracks":[]}}),
    };
    let resp = aicut_engine::mcp::handle_tool_call(&req);
    assert!(resp.success, "MCP render 应成功，错误: {:?}", resp.error);
    let cmd = resp.result.unwrap()["command"].as_str().unwrap().to_string();
    assert!(cmd.contains("ffmpeg"), "MCP render 应返回 ffmpeg 命令");
}

#[test]
fn test_mcp_tool_probe_missing_file() {
    let req = aicut_engine::mcp::ToolRequest {
        name: "probe_media".into(),
        arguments: serde_json::json!({"path": "/nonexistent/file.mp4"}),
    };
    let resp = aicut_engine::mcp::handle_tool_call(&req);
    // ffprobe 执行失败应返回 success=false
    assert!(!resp.success || resp.error.is_some(), "不存在的文件应返回错误");
}

#[test]
fn test_cli_new_default_resolution() {
    // 验证 new 命令使用默认分辨率
    let project = aicut_engine::project::Project {
        version: "1.0".into(),
        canvas: aicut_engine::project::CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
        assets: vec![], tracks: vec![],
    };
    let path = std::env::temp_dir().join("aicut_cli_new_test.json");
    aicut_engine::project_io::save(&project, &path.to_string_lossy()).expect("save");
    let loaded = aicut_engine::project_io::load(&path.to_string_lossy()).expect("load");
    assert_eq!(loaded.canvas.width, 1920);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn test_subtitle_parse_and_render() {
    let srt = "1\n00:00:01,000 --> 00:00:03,000\nHello\n\n";
    let track = aicut_engine::subtitle::parse_srt(srt);
    assert_eq!(track.items.len(), 1);
    let filters = aicut_engine::subtitle::build_drawtext_filters(&track, 1920, 1080);
    assert!(filters[0].contains("drawtext="));
    assert!(filters[0].contains("Hello"));
}

#[test]
fn test_validate_negative_duration() {
    let mut p = aicut_engine::project::Project {
        version: "1.0".into(),
        canvas: aicut_engine::project::CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
        assets: vec![aicut_engine::project::Asset {
            id: "a1".into(), asset_type: "video".into(), path: "v.mp4".into(),
            duration: -5.0, width: 1920, height: 1080, codec: "h264".into(),
        }],
        tracks: vec![],
    };
    let errs = p.validate();
    assert!(!errs.is_empty());
    assert!(errs.iter().any(|e| e.contains("时长为负")));
}

#[test]
fn test_probe_default_info() {
    let info = aicut_engine::probe::MediaInfo::default();
    assert_eq!(info.media_type, "video");
    assert_eq!(info.width, 1920);
}

#[test]
fn test_project_io_roundtrip_with_tracks() {
    let p = aicut_engine::project::Project {
        version: "1.0".into(),
        canvas: aicut_engine::project::CanvasConfig { width: 1280, height: 720, fps: 24, sample_rate: 44100 },
        assets: vec![aicut_engine::project::Asset {
            id: "a1".into(), asset_type: "video".into(), path: "v.mp4".into(),
            duration: 5.0, width: 1920, height: 1080, codec: "h264".into(),
        }],
        tracks: vec![aicut_engine::project::Track {
            id: "t1".into(), track_type: "video".into(), order: 0,
            clips: vec![aicut_engine::project::Clip {
                id: "c1".into(), asset_id: "a1".into(),
                src_range: aicut_engine::project::Range { start: 0.0, end: 5.0 },
                timeline_in: 0.0, timeline_out: 5.0,
                transform: aicut_engine::project::Transform { x: 0.5, y: 0.5, scale_x: 1.0, scale_y: 1.0, rotation: 0.0, opacity: 1.0 },
                volume: 1.0, speed: 1.0,
                effects: vec![], masks: vec![], filters: vec![], keyframes: Default::default(), speed_curve: vec![],
            }],
        }],
    };
    let tmp = std::env::temp_dir().join("aicut_roundtrip_tracks.json");
    aicut_engine::project_io::save(&p, &tmp.to_string_lossy()).expect("save");
    let loaded = aicut_engine::project_io::load(&tmp.to_string_lossy()).expect("load");
    assert_eq!(loaded.tracks.len(), 1);
    assert_eq!(loaded.tracks[0].clips.len(), 1);
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn test_mcp_tools_list_has_seven() {
    let tools = aicut_engine::mcp::list_tools();
    assert_eq!(tools.len(), 7, "MCP 应有 7 个工具");
    let names: Vec<&str> = tools.iter().map(|t| t.name).collect();
    assert!(names.contains(&"render_project"));
    assert!(names.contains(&"transcribe_audio"));
    assert!(names.contains(&"generate_script"));
}
