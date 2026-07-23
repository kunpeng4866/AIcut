//! src/ai.rs — AI 自动字幕生成（DeepSeek LLM 封装）
//!
//! 物理隔离：本文件为新增加独立模块，不依赖/不修改项目内其他数据结构，
//! 仅消费 `crate::subtitle::SubtitleOverlay` 作为输出载体。
//!
//! 设计要点：
//! - 网络层用 `std::process::Command` 调用系统 `curl`（避免引入 reqwest 等新依赖，
//!   保证 `cargo test --offline` 离线可编译、可测试）。
//! - 响应解析抽成纯函数 `parse_subtitle_response`，不依赖网络与 key，便于单元测试。
//! - DeepSeek key 取自环境变量 `DEEPSEEK_API_KEY`。

use std::process::Command;

use crate::subtitle::SubtitleOverlay;

const DEEPSEEK_URL: &str = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL: &str = "deepseek-chat";

/// 从环境变量读取 DeepSeek API key（空值视为缺失）
fn api_key() -> Option<String> {
    std::env::var("DEEPSEEK_API_KEY").ok().filter(|s| !s.trim().is_empty())
}

/// 构造字幕切分 prompt
fn build_subtitle_prompt(transcript: &str, lang: &str) -> String {
    format!(
        "你是一个专业的字幕分词与断句助手。下面是一段语音转写（ASR）文本，语言为 {lang}。\n\
请将其切分为适合阅读的逐条字幕，并只输出一个 JSON 数组（不要使用 markdown 代码块、不要额外说明文字）。\n\
数组中每条对象包含三个字段：\n\
  \"start\": 该条字幕开始时间（秒，浮点数，>=0）\n\
  \"end\":   该条字幕结束时间（秒，浮点数，> start）\n\
  \"text\":  该条字幕的纯文本（不要包含时间戳）\n\
要求：\n\
1. 按语义与停顿合理断句，单条不超过 2 行、约 15-25 字；\n\
2. start/end 必须单调递增且首尾覆盖整段，end - start 通常 1.5-5 秒；\n\
3. 仅基于原文，不臆造内容，不翻译（除非原文非 {lang} 且用户要求）；\n\
4. 直接输出 JSON 数组，例如 [{{\"start\":0.0,\"end\":2.5,\"text\":\"你好世界\"}}]。\n\n\
转写文本如下：\n{transcript}"
    )
}

/// 从 LLM 返回文本中抽取 JSON 数组片段（兼容裸 JSON 与 ```json 代码块包裹）
fn extract_json_array(content: &str) -> &str {
    let s = content.trim();
    // 处理 ```json ... ``` 或 ``` ... ``` 包裹
    if let Some(fence) = s.find("```") {
        let after = &s[fence + 3..];
        let after = after.trim_start_matches("json").trim_start();
        let body = match after.find("```") {
            Some(end) => &after[..end],
            None => after,
        };
        return body.trim();
    }
    s
}

/// 纯函数：解析 DeepSeek 完整 API 响应 JSON → SubtitleOverlay
///
/// 期望结构：
/// ```json
/// { "choices": [ { "message": { "content": "[{\"start\":0,\"end\":2,\"text\":\"...\"}]" } } ] }
/// ```
/// content 内可能是裸 JSON 数组，也可能是 ```json 代码块包裹。
/// 任何解析失败（缺字段/非数组/非法 JSON）都返回 `Err(String)`。
pub fn parse_subtitle_response(json: &str) -> Result<SubtitleOverlay, String> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("DeepSeek 响应不是合法 JSON: {}", e))?;

    // 1) 取 choices[0].message.content
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| {
            // 容错：某些实现直接把数组放在顶层
            if v.is_array() {
                "ok-array".to_string()
            } else {
                "DeepSeek 响应缺少 choices[0].message.content".to_string()
            }
        })?;

    // 2) 容错分支：content 解析失败但顶层是数组
    let array_text = if content == "ok-array" {
        json.trim()
    } else {
        extract_json_array(content)
    };

    // 3) 解析为 Vec<SubtitleItemOverride>
    let raw: Vec<serde_json::Value> = serde_json::from_str(array_text)
        .map_err(|e| format!("字幕数组解析失败: {}", e))?;

    let mut items = Vec::with_capacity(raw.len());
    for (i, item) in raw.iter().enumerate() {
        let start = item
            .get("start")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("第 {} 条字幕缺少合法 start 字段", i + 1))?;
        let end = item
            .get("end")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("第 {} 条字幕缺少合法 end 字段", i + 1))?;
        let text = item
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if end <= start {
            return Err(format!("第 {} 条字幕 end({}) 必须 > start({})", i + 1, end, start));
        }
        items.push(crate::subtitle::SubtitleItemOverride { start, end, text });
    }

    Ok(SubtitleOverlay {
        items,
        ..Default::default()
    })
}

/// 同步核心实现：调用 DeepSeek 将 ASR 转写文本转换为字幕轨道。
///
/// - 读取 `DEEPSEEK_API_KEY`（缺失返回 Err）
/// - 通过 curl 发送 chat/completions 请求
/// - 解析响应为 `SubtitleOverlay`
///
/// 抽成同步函数，便于 N-API（同步绑定）与 async 包装共用。
pub fn generate_subtitles_sync(transcript: &str, lang: &str) -> Result<SubtitleOverlay, String> {
    let key = api_key().ok_or_else(|| "缺少环境变量 DEEPSEEK_API_KEY（请先 export）".to_string())?;
    if transcript.trim().is_empty() {
        return Err("转写文本为空，无法生成字幕".to_string());
    }

    let prompt = build_subtitle_prompt(transcript, lang);
    let body = serde_json::json!({
        "model": DEEPSEEK_MODEL,
        "messages": [
            { "role": "system", "content": "你是字幕生成助手，必须严格按用户要求的 JSON 数组格式输出，不要任何额外解释。" },
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.2,
        "max_tokens": 4096,
    });

    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let output = Command::new("curl")
        .args([
            "-sS",
            "-m",
            "90",
            "-X",
            "POST",
            DEEPSEEK_URL,
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {}", key),
            "-d",
            &body_str,
        ])
        .output()
        .map_err(|e| format!("调用 curl 失败（请确认系统已安装 curl）: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "DeepSeek 请求失败（退出码 {:?}）: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).chars().take(500).collect::<String>()
        ));
    }

    let resp = String::from_utf8_lossy(&output.stdout);
    parse_subtitle_response(&resp)
}

/// 异步包装（任务规格要求 `async fn`；内部为同步网络调用，便于无 tokio 依赖的纯 Rust 路径使用）
pub async fn generate_subtitles(transcript: &str, lang: &str) -> Result<SubtitleOverlay, String> {
    generate_subtitles_sync(transcript, lang)
}

/// 通用文案生成（备用）：将 prompt 交给 DeepSeek，返回其文本回复
pub async fn generate_script(prompt: &str) -> Result<String, String> {
    let key = api_key().ok_or_else(|| "缺少环境变量 DEEPSEEK_API_KEY（请先 export）".to_string())?;
    if prompt.trim().is_empty() {
        return Err("prompt 为空".to_string());
    }

    let body = serde_json::json!({
        "model": DEEPSEEK_MODEL,
        "messages": [ { "role": "user", "content": prompt } ],
        "temperature": 0.8,
        "max_tokens": 4096,
    });
    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let output = Command::new("curl")
        .args([
            "-sS",
            "-m",
            "90",
            "-X",
            "POST",
            DEEPSEEK_URL,
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {}", key),
            "-d",
            &body_str,
        ])
        .output()
        .map_err(|e| format!("调用 curl 失败（请确认系统已安装 curl）: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "DeepSeek 请求失败（退出码 {:?}）: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).chars().take(500).collect::<String>()
        ));
    }

    let resp = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value = serde_json::from_str(&resp)
        .map_err(|e| format!("DeepSeek 响应不是合法 JSON: {}", e))?;
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| "DeepSeek 响应缺少 choices[0].message.content".to_string())?
        .to_string();
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_deepseek_response(content: &str) -> String {
        let v = serde_json::json!({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "choices": [
                { "index": 0, "message": { "role": "assistant", "content": content }, "finish_reason": "stop" }
            ]
        });
        serde_json::to_string(&v).unwrap()
    }

    #[test]
    fn test_parse_full_deepseek_response() {
        let content = r#"[{"start":0.0,"end":2.5,"text":"你好世界"},{"start":2.5,"end":5.0,"text":"这是 AI 字幕测试"}]"#;
        let json = mock_deepseek_response(content);
        let overlay = parse_subtitle_response(&json).expect("应成功解析");
        assert_eq!(overlay.items.len(), 2);
        assert!((overlay.items[0].start - 0.0).abs() < 1e-9);
        assert!((overlay.items[0].end - 2.5).abs() < 1e-9);
        assert_eq!(overlay.items[0].text, "你好世界");
        assert_eq!(overlay.items[1].text, "这是 AI 字幕测试");
    }

    #[test]
    fn test_parse_fenced_code_block() {
        let inner = r#"[{"start":1.0,"end":3.0,"text":"带代码块包裹"}]"#;
        let content = format!("```json\n{}\n```", inner);
        let json = mock_deepseek_response(&content);
        let overlay = parse_subtitle_response(&json).expect("应成功解析");
        assert_eq!(overlay.items.len(), 1);
        assert_eq!(overlay.items[0].text, "带代码块包裹");
        assert!((overlay.items[0].start - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_parse_empty_array() {
        let json = mock_deepseek_response("[]");
        let overlay = parse_subtitle_response(&json).expect("空数组应成功");
        assert!(overlay.items.is_empty());
    }

    #[test]
    fn test_parse_missing_choices_is_err() {
        let json = serde_json::to_string(&serde_json::json!({ "error": { "message": "invalid api key" } })).unwrap();
        assert!(parse_subtitle_response(&json).is_err());
    }

    #[test]
    fn test_parse_invalid_end_is_err() {
        let content = r#"[{"start":5.0,"end":2.0,"text":"时间倒流"}]"#;
        let json = mock_deepseek_response(content);
        assert!(parse_subtitle_response(&json).is_err());
    }

    #[test]
    fn test_parse_missing_field_is_err() {
        let content = r#"[{"start":0.0,"text":"缺 end"}]"#;
        let json = mock_deepseek_response(content);
        assert!(parse_subtitle_response(&json).is_err());
    }

    #[test]
    fn test_parse_not_json_is_err() {
        assert!(parse_subtitle_response("not json at all").is_err());
    }
}
