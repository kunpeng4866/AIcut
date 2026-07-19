//! src/mcp.rs — MCP (Model Context Protocol) Server 骨架
//!
//! 提供 AI Agent 可调用的工具接口：
//!   - render_project: JSON 工程 → FFmpeg 命令
//!   - probe_media: 文件路径 → 媒体元数据
//!   - list_presets: 返回可用滤镜预置
//!   - validate_project: 验证工程合法性
//!
//! 使用方式：
//!   aicut-engine mcp-tools              列出可用工具
//!   aicut-engine mcp-tool <name> <args>  单次工具调用

use serde::{Deserialize, Serialize};

/// MCP 工具调用请求
#[derive(Debug, Deserialize)]
pub struct ToolRequest {
    pub name: String,
    pub arguments: serde_json::Value,
}

/// MCP 工具调用响应
#[derive(Debug, Serialize)]
pub struct ToolResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// MCP Server 可用工具列表
pub fn list_tools() -> Vec<ToolDef> {
    vec![
        ToolDef { name: "render_project", description: "渲染 AIcut 工程 JSON，返回 FFmpeg 命令", input_schema: r#"{"type":"object","properties":{"project":{"type":"object"}}}"# },
        ToolDef { name: "probe_media", description: "探测媒体文件元数据（分辨率/时长/编码）", input_schema: r#"{"type":"object","properties":{"path":{"type":"string"}}}"# },
        ToolDef { name: "list_presets", description: "返回可用滤镜预置名列表", input_schema: r#"{"type":"object","properties":{}}"# },
        ToolDef { name: "validate_project", description: "验证 AIcut 工程合法性", input_schema: r#"{"type":"object","properties":{"project":{"type":"object"}}}"# },
    ]
}

#[derive(Debug, Serialize)]
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: &'static str,
}

/// 处理单个 MCP 工具调用
pub fn handle_tool_call(request: &ToolRequest) -> ToolResponse {
    match request.name.as_str() {
        "render_project" => {
            let project_json = &request.arguments["project"];
            let project = match serde_json::to_string(project_json) {
                Ok(s) => s,
                Err(e) => return ToolResponse { success: false, result: None, error: Some(e.to_string()) },
            };
            match crate::render(&project) {
                Ok(cmd) => ToolResponse { success: true, result: Some(serde_json::json!({"command": cmd})), error: None },
                Err(e) => ToolResponse { success: false, result: None, error: Some(e.to_string()) },
            }
        }
        "probe_media" => {
            let path = request.arguments["path"].as_str().unwrap_or("");
            if path.is_empty() {
                return ToolResponse { success: false, result: None, error: Some("缺少 path 参数".into()) };
            }
            match crate::probe::probe(path) {
                Ok(info) => ToolResponse {
                    success: true,
                    result: Some(serde_json::to_value(info).unwrap()),
                    error: None,
                },
                Err(e) => ToolResponse { success: false, result: None, error: Some(e) },
            }
        }
        "list_presets" => ToolResponse {
            success: true,
            result: Some(serde_json::json!({"presets": crate::get_preset_list()})),
            error: None,
        },
        "validate_project" => {
            let project: crate::project::Project = match serde_json::from_value(request.arguments["project"].clone()) {
                Ok(p) => p,
                Err(e) => return ToolResponse { success: false, result: None, error: Some(e.to_string()) },
            };
            let errs = project.validate();
            ToolResponse {
                success: errs.is_empty(),
                result: Some(serde_json::json!({"errors": errs})),
                error: None,
            }
        }
        _ => ToolResponse { success: false, result: None, error: Some(format!("未知工具: {}", request.name)) },
    }
}

// ════════════════════ MCP JSON-RPC Server (stdio) ════════════════════

use std::io::{BufRead, Write};

/// 启动 MCP JSON-RPC stdio server，阻塞运行直到 stdin 关闭
pub fn run_stdio_server() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let reader = std::io::BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() { continue; }

        let response = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(req) => handle_jsonrpc(&req),
            Err(e) => serde_json::json!({
                "jsonrpc": "2.0", "error": {"code": -32700, "message": format!("Parse error: {}", e)}, "id": null
            }),
        };

        let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap_or_default());
        let _ = stdout.flush();
    }
}

fn handle_jsonrpc(req: &serde_json::Value) -> serde_json::Value {
    let id = req.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = req["method"].as_str().unwrap_or("");

    match method {
        "initialize" => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "aicut-engine", "version": env!("CARGO_PKG_VERSION")},
                "capabilities": {"tools": {}}
            }
        }),
        "tools/list" => {
            let tools: Vec<serde_json::Value> = list_tools().iter().map(|t| serde_json::json!({
                "name": t.name, "description": t.description,
                "inputSchema": serde_json::from_str::<serde_json::Value>(t.input_schema).unwrap_or_default()
            })).collect();
            serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {"tools": tools}})
        }
        "tools/call" => {
            let tool_name = req["params"]["name"].as_str().unwrap_or("");
            let args = req["params"]["arguments"].clone();
            let resp = handle_tool_call(&ToolRequest { name: tool_name.to_string(), arguments: args });
            let result = serde_json::json!({"content": [{"type": "text", "text": serde_json::to_string(&resp).unwrap_or_default()}]});
            serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
        }
        "notifications/initialized" => serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {}}),
        _ => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "error": {"code": -32601, "message": format!("Method not found: {}", method)}
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_tools() {
        let tools = list_tools();
        assert_eq!(tools.len(), 4);
        assert!(tools.iter().any(|t| t.name == "render_project"));
    }

    #[test]
    fn test_handle_unknown_tool() {
        let resp = handle_tool_call(&ToolRequest { name: "unknown".into(), arguments: serde_json::json!({}) });
        assert!(!resp.success);
    }

    #[test]
    fn test_handle_list_presets() {
        let resp = handle_tool_call(&ToolRequest { name: "list_presets".into(), arguments: serde_json::json!({}) });
        assert!(resp.success);
    }

    #[test]
    fn test_handle_probe_missing_path() {
        let resp = handle_tool_call(&ToolRequest { name: "probe_media".into(), arguments: serde_json::json!({}) });
        assert!(!resp.success);
        assert!(resp.error.unwrap().contains("path"));
    }
}
