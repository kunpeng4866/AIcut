//! src/main.rs — AIcut 引擎 CLI 入口
//!
//!   aicut-engine render  <project.json>   渲染 → FFmpeg 命令
//!   aicut-engine probe   <media_file>     探测媒体元数据
//!   aicut-engine new     <name> <W>x<H>   创建空白工程
//!   aicut-engine validate <project.json>  验证工程合法性
//!   aicut-engine presets                  预置列表
//!   aicut-engine version                  版本号

use std::env;
use std::fs;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("用法: aicut-engine <render|probe|new|validate|presets|version> [参数]");
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
                (parts[0].parse().unwrap_or(1920), parts[1].parse().unwrap_or(1080))
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
        other => {
            eprintln!("未知子命令: {} (可用: render, probe, new, validate, presets, version, mcp-tools, mcp-tool)", other);
            process::exit(2);
        }
    }
}
