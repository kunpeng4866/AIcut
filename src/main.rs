//! src/main.rs — AIcut 引擎 CLI 入口
//!
//!   aicut-engine render  <project.json>           渲染 → FFmpeg 命令
//!   aicut-engine export  <project.json> <output>  导出 → 视频文件
//!   aicut-engine probe   <media_file>             探测媒体元数据
//!   aicut-engine new     <name> <W>x<H>           创建空白工程
//!   aicut-engine validate <project.json>          验证工程合法性
//!   aicut-engine presets                          预置列表
//!   aicut-engine version                          版本号
//!   aicut-engine ai subtitles <file> <lang>       DeepSeek 生成字幕 JSON
//!   aicut-engine asr transcribe <audio> <lang> <provider> <enginePath> <modelPath> <apiKey> <endpoint> <model>
//!       provider: bailian → 百炼(DashScope) Python 桥；其余/空 → whisper.cpp 本地转写

use std::env;
use std::fs;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("用法: aicut-engine <render|export|probe|new|validate|presets|version> [参数]");
        process::exit(2);
    }

    match args[1].as_str() {
        "render" => {
            if args.len() < 3 { eprintln!("用法: aicut-engine render <project.json>"); process::exit(2); }
            let json = fs::read_to_string(&args[2]).unwrap_or_else(|e| {
                eprintln!("无法读取 {}: {}", args[2], e); process::exit(1);
            });
            match aicut_engine::render(&json) {
                Ok(cmd) => println!("{}", cmd),
                Err(e) => { eprintln!("渲染失败: {:#}", e); process::exit(1); }
            }
        }
        "export" => {
            if args.len() < 4 { eprintln!("用法: aicut-engine export <project.json> <output.mp4>"); process::exit(2); }
            let json = fs::read_to_string(&args[2]).unwrap_or_else(|e| {
                eprintln!("无法读取 {}: {}", args[2], e); process::exit(1);
            });
            match aicut_engine::export_project(&json, &args[3]) {
                Ok(()) => println!("✅ 导出完成: {}", args[3]),
                Err(e) => { eprintln!("❌ 导出失败: {}", e); process::exit(1); }
            }
        }
        "probe" => {
            if args.len() < 3 { eprintln!("用法: aicut-engine probe <media_file>"); process::exit(2); }
            match aicut_engine::probe::probe(&args[2]) {
                Ok(info) => println!("{}", serde_json::to_string_pretty(&info).unwrap()),
                Err(e) => { eprintln!("探测失败: {}", e); process::exit(1); }
            }
        }
        "new" => {
            if args.len() < 3 { eprintln!("用法: aicut-engine new <name> [WxH]"); process::exit(2); }
            let (w, h) = if args.len() >= 4 {
                let parts: Vec<&str> = args[3].split('x').collect();
                if parts.len() >= 2 {
                    (parts[0].parse().unwrap_or(1920), parts[1].parse().unwrap_or(1080))
                } else {
                    eprintln!("警告: 分辨率格式应为 WxH (如 1920x1080)，使用默认 1920x1080");
                    (1920, 1080)
                }
            } else { (1920, 1080) };
            let project = aicut_engine::project::Project {
                version: "1.0".into(),
                canvas: aicut_engine::project::CanvasConfig { width: w, height: h, fps: 30, sample_rate: 48000 },
                assets: vec![], tracks: vec![],
            };
            let path = format!("{}.json", args[2]);
            match aicut_engine::project_io::save(&project, &path) {
                Ok(()) => println!("工程已创建: {}", path),
                Err(e) => { eprintln!("{}", e); process::exit(1); }
            }
        }
        "validate" => {
            if args.len() < 3 { eprintln!("用法: aicut-engine validate <project.json>"); process::exit(2); }
            let project = aicut_engine::project_io::load(&args[2]).unwrap_or_else(|e| {
                eprintln!("加载失败: {}", e); process::exit(1);
            });
            let errs = project.validate();
            if errs.is_empty() { println!("✅ 工程验证通过"); }
            else { for e in &errs { eprintln!("❌ {}", e); } process::exit(1); }
        }
        "presets" => {
            println!("{}", serde_json::to_string(&aicut_engine::get_preset_list()).unwrap());
        }
        "version" => {
            println!("{}", aicut_engine::get_version());
        }
        "plugin" => {
            if args.len() < 3 { eprintln!("用法: aicut-engine plugin <list|scan|build> [参数]"); process::exit(2); }
            let plugin_dir = std::path::PathBuf::from(
                env::var("AICUT_PLUGIN_DIR").unwrap_or_else(|_| "plugins".into())
            );
            match args[2].as_str() {
                "list" => {
                    let mut mgr = aicut_engine::plugin::PluginManager::new(plugin_dir);
                    let _ = mgr.scan();
                    let list: Vec<&aicut_engine::plugin::PluginManifest> = mgr.list();
                    println!("{}", serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()));
                }
                "scan" => {
                    let mut mgr = aicut_engine::plugin::PluginManager::new(plugin_dir);
                    match mgr.scan() {
                        Ok(n) => println!("{}", n),
                        Err(e) => { eprintln!("扫描失败: {:#}", e); process::exit(1); }
                    }
                }
                "build" => {
                    if args.len() < 5 { eprintln!("用法: aicut-engine plugin build <plugin_id> <params_json>"); process::exit(2); }
                    let mut mgr = aicut_engine::plugin::PluginManager::new(plugin_dir);
                    let _ = mgr.scan();
                    let params: std::collections::HashMap<String, f64> =
                        serde_json::from_str(&args[4]).unwrap_or_default();
                    match mgr.build_filter(&args[3], &params) {
                        Ok(filter) => println!("{}", filter),
                        Err(e) => { eprintln!("构建失败: {:#}", e); process::exit(1); }
                    }
                }
                other => { eprintln!("未知 plugin 子命令: {} (可用: list, scan, build)", other); process::exit(2); }
            }
        }
        "mcp" => {
            aicut_engine::mcp::run_stdio_server();
        }
        "mcp-tools" => {
            println!("{}", serde_json::to_string_pretty(&aicut_engine::mcp::list_tools()).unwrap());
        }
        "mcp-tool" => {
            if args.len() < 4 { eprintln!("用法: aicut-engine mcp-tool <name> <json_args>"); process::exit(2); }
            let req = aicut_engine::mcp::ToolRequest {
                name: args[2].clone(),
                arguments: serde_json::from_str(&args[3]).unwrap_or(serde_json::Value::Null),
            };
            let resp = aicut_engine::mcp::handle_tool_call(&req);
            println!("{}", serde_json::to_string_pretty(&resp).unwrap());
        }
        "tts" => {
            // aicut-engine tts --appid <id> --token <t> --text "..." --voice BV002 --out out.mp3
            let mut appid = String::new();
            let mut token = String::new();
            let mut text = String::new();
            let mut voice = String::new();
            let mut output = String::from("tts_output.mp3");
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--appid" => { appid = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--token" => { token = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--text"  => { text  = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--voice" => { voice = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--output"|"-o" => { output = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    other => { eprintln!("未知参数: {}", other); process::exit(2); }
                }
            }
            if appid.is_empty() || token.is_empty() || text.is_empty() {
                eprintln!("用法: aicut-engine tts --appid <id> --token <token> --text \"...\" [--voice BV002_streaming] [--output out.mp3]");
                process::exit(2);
            }
            let config = aicut_engine::tts::TtsConfig {
                appid, access_token: token, ..Default::default()
            };
            let client = aicut_engine::tts::VolcanoTtsClient::from_config(&config);
            let req = aicut_engine::tts::TtsRequest {
                text, voice_type: voice, ..Default::default()
            };
            match client.synthesize_to_file(&req, &output) {
                Ok(dur) => println!("✅ TTS 合成成功: {} (时长 {:.2}s)", output, dur),
                Err(e) => { eprintln!("❌ TTS 合成失败: {:#}", e); process::exit(1); }
            }
        }
        "ai" => {
            // aicut-engine ai subtitles <transcript_file> <lang>
            // aicut-engine ai translate  <text_file> <target_lang>
            // 文本经临时文件传入，避免长文本/中文在命令行参数中的转义与编码问题。
            if args.len() < 4 {
                eprintln!("用法: aicut-engine ai subtitles <transcript_file> <lang> | ai translate <text_file> <target_lang>");
                process::exit(2);
            }
            match args[2].as_str() {
                "subtitles" => {
                    let transcript = fs::read_to_string(&args[3]).unwrap_or_else(|e| {
                        eprintln!("无法读取转写文件 {}: {}", args[3], e);
                        process::exit(1);
                    });
                    let lang = args.get(4).map(|s| s.as_str()).unwrap_or("zh");
                    match aicut_engine::ai::generate_subtitles_sync(&transcript, lang) {
                        Ok(overlay) => println!("{}", serde_json::to_string(&overlay).unwrap()),
                        Err(e) => { eprintln!("AI 字幕生成失败: {}", e); process::exit(1); }
                    }
                }
                "translate" => {
                    let text = fs::read_to_string(&args[3]).unwrap_or_else(|e| {
                        eprintln!("无法读取翻译文本文件 {}: {}", args[3], e);
                        process::exit(1);
                    });
                    let target_lang = args.get(4).map(|s| s.as_str()).unwrap_or("en");
                    match aicut_engine::ai::translate_sync(&text, target_lang) {
                        Ok(translated) => println!("{}", translated),
                        Err(e) => { eprintln!("AI 翻译失败: {}", e); process::exit(1); }
                    }
                }
                other => {
                    eprintln!("未知 ai 子命令: {} (可用: subtitles, translate)", other);
                    process::exit(2);
                }
            }
        }
        "asr" => {
            // aicut-engine asr transcribe <audio> <lang> <provider> <enginePath> <modelPath> <apiKey> <endpoint> <model>
            if args.len() < 4 {
                eprintln!("用法: aicut-engine asr transcribe <audio> <lang> [provider] [enginePath] [modelPath] [apiKey] [endpoint] [model]");
                process::exit(2);
            }
            match args[2].as_str() {
                "transcribe" => {
                    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
                    let audio = &args[3];
                    let lang = args.get(4).map(|s| s.as_str()).unwrap_or("zh").to_string();
                    let lang = if lang.is_empty() { "zh".to_string() } else { lang };
                    let provider_kind = arg(5);   // whisper-local / whisper-api / custom / 空 / bailian
                    let engine_path = arg(6);
                    let model_path = arg(7);
                    let api_key = arg(8);
                    let endpoint = arg(9);
                    let model = arg(10);
                    let provider = aicut_engine::provider::create_asr_provider(
                        &provider_kind, &engine_path, &model_path, &api_key, &endpoint, &model,
                    );
                    match aicut_engine::provider::AsrProvider::transcribe(provider.as_ref(), audio, &lang) {
                        Ok(r) => println!("{}", serde_json::to_string(&r).unwrap()),
                        Err(e) => { eprintln!("ASR 转写失败: {}", e); process::exit(1); }
                    }
                }
                other => {
                    eprintln!("未知 asr 子命令: {} (可用: transcribe)", other);
                    process::exit(2);
                }
            }
        }
        "speech" => {
            // aicut-engine speech --mode <analyze|assemble> --input <path> --opts <json>
            let mut mode = String::new();
            let mut input = String::new();
            let mut opts = String::new();
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--mode"  => { mode  = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--input" => { input = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--opts"  => { opts  = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    other => { eprintln!("未知参数: {}", other); process::exit(2); }
                }
            }
            match mode.as_str() {
                "analyze" => match aicut_engine::speech_analyze(&input, &opts) {
                    Ok(v) => println!("{}", serde_json::to_string(&v).unwrap()),
                    Err(e) => { eprintln!("speech analyze 失败: {}", e); process::exit(1); }
                },
                "assemble" => match aicut_engine::speech_assemble(&input, &opts) {
                    Ok(v) => println!("{}", serde_json::to_string(&v).unwrap()),
                    Err(e) => { eprintln!("speech assemble 失败: {}", e); process::exit(1); }
                },
                "separate" => match aicut_engine::speech_separate(&input, &opts) {
                    Ok(v) => println!("{}", serde_json::to_string(&v).unwrap()),
                    Err(e) => { eprintln!("speech separate 失败: {}", e); process::exit(1); }
                },
                other => { eprintln!("未知 speech 模式: {} (可用: analyze, assemble, separate)", other); process::exit(2); }
            }
        }
        "keying" => {
            // aicut-engine keying --mode matte --input <path> --opts <json>
            let mut mode = String::new();
            let mut input = String::new();
            let mut opts = String::new();
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--mode"  => { mode  = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--input" => { input = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--opts"  => { opts  = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    other => { eprintln!("未知参数: {}", other); process::exit(2); }
                }
            }
            // 把 mode 并入 opts JSON 再转发给 Python 桥（bridge.py 从 opts 读 mode），
            // 保证 CLI 与 Electron（前端已塞入 mode）两条路径行为一致。
            let mut opts_val: serde_json::Value = serde_json::from_str(&opts)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(ref mut map) = opts_val {
                // 仅当 opts 未自带 mode 时（CLI 直跑路径）才用 CLI --mode 注入；
                // GUI 路径前端已在 optsJson 内塞入真实 mode，用 or_insert 绝不覆盖，
                // 修复「manual 被强制覆盖成 matte、guide 被忽略」的隐藏 bug。
                map.entry("mode".to_string())
                    .or_insert_with(|| serde_json::Value::String(mode.clone()));
            }
            let opts_merged = serde_json::to_string(&opts_val).unwrap_or_else(|_| opts.clone());
            match mode.as_str() {
                "matte" | "manual" => match aicut_engine::keying_generate(&input, &opts_merged) {
                    Ok(v) => println!("{}", serde_json::to_string(&v).unwrap()),
                    Err(e) => { eprintln!("keying {} 失败: {}", mode, e); process::exit(1); }
                },
                other => { eprintln!("未知 keying 模式: {} (可用: matte, manual)", other); process::exit(2); }
            }
        }
        "sr" => {
            // aicut-engine sr --input <path> --opts <json>
            //   或 aicut-engine sr --project <project.json> --output <out.mp4> --opts <json>
            let mut input = String::new();
            let mut project = String::new();
            let mut output = String::new();
            let mut opts = String::new();
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--input"   => { input   = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--project" => { project = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--output"  => { output  = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    "--opts"    => { opts    = args.get(i+1).cloned().unwrap_or_default(); i += 2; }
                    other => { eprintln!("未知参数: {}", other); process::exit(2); }
                }
            }
            if !project.is_empty() {
                // 导出级后处理：工程 → 临时视频 → 超分 → output
                if output.is_empty() {
                    eprintln!("用法: aicut-engine sr --project <project.json> --output <out.mp4> [--opts <json>]");
                    process::exit(2);
                }
                let json = fs::read_to_string(&project).unwrap_or_else(|e| {
                    eprintln!("无法读取 {}: {}", project, e); process::exit(1);
                });
                match aicut_engine::sr_export_project(&json, &output, &opts) {
                    Ok(()) => println!("{}", serde_json::json!({ "ok": true, "output_path": output })),
                    Err(e) => { eprintln!("sr export 失败: {}", e); process::exit(1); }
                }
            } else {
                // 单视频超分
                if input.is_empty() {
                    eprintln!("用法: aicut-engine sr --input <video> [--opts <json>]");
                    process::exit(2);
                }
                match aicut_engine::sr_generate(&input, &opts) {
                    Ok(v) => println!("{}", serde_json::to_string(&v).unwrap()),
                    Err(e) => { eprintln!("sr 失败: {}", e); process::exit(1); }
                }
            }
        }
        other => {
            eprintln!("未知子命令: {} (可用: render, export, probe, new, validate, presets, version, mcp, mcp-tools, mcp-tool, tts, ai, asr, speech, keying, sr)", other);
            process::exit(2);
        }
    }
}
