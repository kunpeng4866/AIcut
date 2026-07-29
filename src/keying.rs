//! src/keying.rs — 智能抠像（Keying）引擎侧实现
//!
//! 公开函数：
//!   - `keying_generate` : 调用 Python 桥 (`python/keying/bridge.py`) 生成抠像 matte，
//!                        返回 `{"mattePath", "duration", "width", "height", "fps", ...}` JSON。
//!
//! 错误统一用 `crate::AppError::Render(String)` 返回，保持与 `speech_analyze` 一致的风格。

use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

use crate::AppError;

/// 托管的 Python 解释器（WorkBuddy 内置环境）。
/// 可用环境变量 `AICUT_PYTHON_BIN` 覆盖。
const MANAGED_PYTHON: &str = "C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe";

/// 解析 bridge.py 路径：
///   - 环境变量 `AICUT_KEYING_BRIDGE` 优先；
///   - 否则从当前可执行文件反推仓库根目录：
///     exe 位于 `<repo>/target/debug/` 或 `<repo>/target/release/`，
///     故 `parent().parent().parent()` 即 `<repo>`，再拼接 `python/keying/bridge.py`。
fn resolve_keying_bridge() -> Result<PathBuf, AppError> {
    if let Ok(p) = std::env::var("AICUT_KEYING_BRIDGE") {
        return Ok(PathBuf::from(p));
    }
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Render(format!("无法定位当前可执行文件: {}", e)))?;
    let repo_root = exe
        .parent() // <repo>/target/debug
        .and_then(|p| p.parent()) // <repo>/target
        .and_then(|p| p.parent()) // <repo>
        .ok_or_else(|| AppError::Render("无法从可执行文件路径推断仓库根目录".into()))?;
    Ok(repo_root.join("python/keying/bridge.py"))
}

/// 调用 Python 桥对视频做智能抠像，生成灰度 matte 视频。
///
/// `opts_json` 是一个紧凑的 JSON 字符串（无空格），作为**单个参数**传给 Python。
/// 桥只向 stdout 输出一行 JSON，故可直接 `serde_json::from_str(stdout.trim())`。
pub fn keying_generate(input: &str, opts_json: &str) -> Result<Value, AppError> {
    let py = std::env::var("AICUT_PYTHON_BIN").unwrap_or_else(|_| MANAGED_PYTHON.to_string());
    let bridge = resolve_keying_bridge()?;
    let bridge_str = bridge
        .to_str()
        .ok_or_else(|| AppError::Render("bridge.py 路径包含非 UTF-8 字符".into()))?;

    // rmbg2 (BRIA RMBG-2.0 / BiRefNet) 极重，必须放开 OpenMP 多线程，否则单帧
    // 推理数十秒、整条 matte 生成十几分钟不可用；modnet/manual 维持单线程避免争核。
    let is_rmbg2 = serde_json::from_str::<Value>(opts_json)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str().map(|s| s == "rmbg2")))
        .unwrap_or(false);
    let omp_threads = if is_rmbg2 { "8" } else { "1" };

    let output = Command::new(&py)
        .env("PYTHONIOENCODING", "utf-8") // Windows 下管道 stdout 默认按本地 codepage，中文会乱码/解析失败
        .env("PYTHONUTF8", "1")
        // 限单线程，避免 OpenMP/多线程在部分环境下的不稳定（rmbg2 除外，见上）
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
            "keying generate 失败 (退出码 {:?}): {}",
            output.status.code(),
            stderr.chars().take(1000).collect::<String>()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        AppError::Render(format!(
            "keying generate 输出不是合法 JSON: {} (原始前 200 字符: {})",
            e,
            &stdout.chars().take(200).collect::<String>()
        ))
    })?;
    Ok(v)
}
