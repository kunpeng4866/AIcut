//! src/main.rs — AIcut 引擎 CLI 入口
//!
//! 让纯 Rust 引擎可从命令行调用，作为 N-API 绑定不可用时的桥接回退路径：
//!   aicut-engine render  <project.json 路径>   读文件 → render → 打印 FFmpeg 命令
//!   aicut-engine presets                       打印 get_preset_list（JSON 数组）
//!   aicut-engine version                       打印 get_version 字符串
//!
//! 所有公开能力都来自 lib crate `aicut_engine`（见 src/lib.rs 的 `pub fn`）。

use std::env;
use std::fs;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("用法: aicut-engine <render|presets|version> [参数]");
        process::exit(2);
    }

    match args[1].as_str() {
        "render" => {
            if args.len() < 3 {
                eprintln!("用法: aicut-engine render <project.json 路径>");
                process::exit(2);
            }
            let path = &args[2];
            let json = match fs::read_to_string(path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("无法读取文件 {}: {}", path, e);
                    process::exit(1);
                }
            };
            match aicut_engine::render(&json) {
                Ok(cmd) => println!("{}", cmd),
                Err(e) => {
                    eprintln!("渲染失败: {:#}", e);
                    process::exit(1);
                }
            }
        }
        "presets" => {
            let list = aicut_engine::get_preset_list();
            // JSON 数组形式输出，便于 TS 侧 JSON.parse 解析为 string[]
            match serde_json::to_string(&list) {
                Ok(s) => println!("{}", s),
                Err(e) => {
                    eprintln!("序列化预置列表失败: {}", e);
                    process::exit(1);
                }
            }
        }
        "version" => {
            println!("{}", aicut_engine::get_version());
        }
        other => {
            eprintln!("未知子命令: {}（可用: render, presets, version）", other);
            process::exit(2);
        }
    }
}
