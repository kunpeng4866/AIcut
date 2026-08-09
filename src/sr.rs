//! src/sr.rs — 视频超清增强（Super Resolution）引擎侧实现
//!
//! 公开函数：
//!   - `sr_generate`       : 调用 Python 桥 (`python/sr/bridge.py`) 对单个视频做逐帧超分，
//!                           返回 `{"ok", "output_path", "model_path", ...}` JSON。
//!   - `sr_export_project` : 导出级后处理——先把工程渲染成临时视频，再超分到最终输出。
//!
//! 架构说明：SR 依赖 onnxruntime CUDA EP 逐帧推理，**无法**表达为 ffmpeg 滤镜，
//! 故不能进入 `graph.rs::build_video_chain`；且 SR 会改变分辨率，也不能仿 keying
//! 的 clip 级资产引用模式（会破坏时间轴合成）。因此 SR 只作为**导出级后处理**存在。
//!
//! 错误统一用 `crate::AppError::Render(String)` 返回，保持与 `keying_generate` 一致的风格。

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::AppError;

/// 托管的 Python 解释器（WorkBuddy 内置环境）。
/// 可用环境变量 `AICUT_PYTHON_BIN` 覆盖。
const MANAGED_PYTHON: &str = "C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe";

/// 解析 bridge.py 路径：
///   - 环境变量 `AICUT_SR_BRIDGE` 优先；
///   - 否则从当前可执行文件反推仓库根目录：
///     exe 位于 `<repo>/target/debug/` 或 `<repo>/target/release/`，
///     故 `parent().parent().parent()` 即 `<repo>`，再拼接 `python/sr/bridge.py`。
fn resolve_sr_bridge() -> Result<PathBuf, AppError> {
    if let Ok(p) = std::env::var("AICUT_SR_BRIDGE") {
        return Ok(PathBuf::from(p));
    }
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Render(format!("无法定位当前可执行文件: {}", e)))?;
    let repo_root = exe
        .parent() // <repo>/target/debug
        .and_then(|p| p.parent()) // <repo>/target
        .and_then(|p| p.parent()) // <repo>
        .ok_or_else(|| AppError::Render("无法从可执行文件路径推断仓库根目录".into()))?;
    Ok(repo_root.join("python/sr/bridge.py"))
}

/// 调用 Python 桥对视频做超清增强，输出放大后的视频。
///
/// `opts_json` 是一个紧凑的 JSON 字符串（无空格），作为**单个参数**传给 Python。
/// 支持字段：`output_path` / `scale` / `tile_size` / `tile_overlap` / `provider`
/// / `encoder` / `crf` / `bitrate` / `preset` / `strength` / `model_path`。
/// 桥只向 stdout 输出一行 JSON，故可直接 `serde_json::from_str(stdout.trim())`。
pub fn sr_generate(input: &str, opts_json: &str) -> Result<Value, AppError> {
    let py = std::env::var("AICUT_PYTHON_BIN").unwrap_or_else(|_| MANAGED_PYTHON.to_string());
    let bridge = resolve_sr_bridge()?;
    let bridge_str = bridge
        .to_str()
        .ok_or_else(|| AppError::Render("bridge.py 路径包含非 UTF-8 字符".into()))?;

    // SR 是逐帧 ONNX 推理，属于重负载：CPU provider 下必须放开 OpenMP 多线程，
    // 否则单帧推理数秒、整段视频不可用；CUDA provider 下 GPU 承担主算力，
    // CPU 侧只做前后处理，给 4 线程避免与解码/编码进程争核。
    let is_cpu = serde_json::from_str::<Value>(opts_json)
        .ok()
        .and_then(|v| v.get("provider").and_then(|p| p.as_str().map(|s| s == "cpu")))
        .unwrap_or(false);
    let omp_threads = if is_cpu { "8" } else { "4" };

    let output = Command::new(&py)
        .env("PYTHONIOENCODING", "utf-8") // Windows 下管道 stdout 默认按本地 codepage，中文会乱码/解析失败
        .env("PYTHONUTF8", "1")
        .env("OMP_NUM_THREADS", omp_threads)
        .env("MKL_NUM_THREADS", omp_threads)
        .arg(bridge_str)
        .arg(input)
        .arg(opts_json)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 Python ({})：{}", py, e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Render(format!(
            "sr generate 失败 (退出码 {:?}): {}",
            output.status.code(),
            stderr.chars().take(1000).collect::<String>()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        AppError::Render(format!(
            "sr generate 输出不是合法 JSON: {} (原始前 200 字符: {})",
            e,
            &stdout.chars().take(200).collect::<String>()
        ))
    })?;
    Ok(v)
}

/// 计算超分临时中间文件路径：`<output 同目录>/<stem>_sr_temp.mp4`。
///
/// 与最终输出同盘同目录，避免跨盘移动；若 output 无父目录则退回系统临时目录。
fn sr_temp_path(output_path: &str) -> PathBuf {
    let out = Path::new(output_path);
    let stem = out
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("aicut_sr");
    let file_name = format!("{}_sr_temp.mp4", stem);
    match out.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(file_name),
        _ => std::env::temp_dir().join(file_name),
    }
}

/// 导出级 SR 后处理：把工程渲染成临时视频，再整段超分到 `output_path`。
///
/// 流程：
///   1. `crate::export_project(project_json, temp)` 走既有导出路径渲染中间文件；
///   2. `sr_generate(temp, opts)` 超分，`opts.output_path` 被强制改写为 `output_path`；
///   3. 清理临时文件（失败只告警，不影响返回值）。
///
/// `opts_json` 传空串或非法 JSON 时按空对象处理，其余字段（scale/provider/encoder…）
/// 原样透传给 Python 桥。
pub fn sr_export_project(
    project_json: &str,
    output_path: &str,
    opts_json: &str,
) -> Result<(), AppError> {
    let temp = sr_temp_path(output_path);
    let temp_str = temp
        .to_str()
        .ok_or_else(|| AppError::Render("SR 临时文件路径包含非 UTF-8 字符".into()))?
        .to_string();

    // ① 先按既有导出路径（快速路径 / ExportPipeline）渲染到临时文件
    crate::export_project(project_json, &temp_str)
        .map_err(|e| AppError::Render(format!("SR 前置导出失败: {}", e)))?;

    // ② opts 注入最终输出路径（强制覆盖：最终落盘位置由调用方决定）
    let mut opts_val: Value =
        serde_json::from_str(opts_json).unwrap_or_else(|_| Value::Object(serde_json::Map::new()));
    if !opts_val.is_object() {
        opts_val = Value::Object(serde_json::Map::new());
    }
    if let Value::Object(ref mut map) = opts_val {
        map.insert(
            "output_path".to_string(),
            Value::String(output_path.to_string()),
        );
    }
    let opts_merged = serde_json::to_string(&opts_val)
        .map_err(|e| AppError::Render(format!("SR opts 序列化失败: {}", e)))?;

    // ③ 超分（失败也要清理临时文件，避免残留）
    let result = sr_generate(&temp_str, &opts_merged);

    if let Err(e) = std::fs::remove_file(&temp) {
        eprintln!("[sr] 临时文件清理失败（可忽略）: {} ({})", temp_str, e);
    }

    result.map(|_| ())
}
