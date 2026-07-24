//! src/plugin.rs — 插件/扩展接口系统
//!
//! 自研 .aifx 插件格式（AIcut FX）。每个插件为一个子目录，内含 manifest.json
//! 声明参数定义 / FFmpeg 滤镜模板 / 可选 WGSL 着色器。运行期由 PluginManager
//! 扫描、校验、按需构建 FFmpeg 滤镜串。
//!
//! 设计原则：接口原创，滤镜模板基于 FFmpeg 开源滤镜，着色器使用 WGSL 标准。

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// ════════════════════ 插件清单 ════════════════════

/// 插件类型。序列化为 PascalCase 字符串（"Filter" / "Effect" / ...），
/// 与 TS 侧字面量联合类型一一对齐。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub enum PluginType {
    /// 滤镜（整段应用）
    Filter,
    /// 特效（叠层）
    Effect,
    /// 转场
    Transition,
    /// 文字模板
    TextTemplate,
    /// 贴纸
    Sticker,
}

/// 参数控件类型。决定前端 UI 渲染方式。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub enum ParamType {
    /// 滑块（连续数值）
    Slider,
    /// 开关（0/1）
    Toggle,
    /// 颜色选择器（RGB 编码为 f64）
    Color,
    /// 下拉选择（min=选项 index）
    Select,
}

/// 插件暴露的单个参数定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParameterDef {
    pub key: String,
    pub label: String,
    pub param_type: ParamType,
    pub default: f64,
    pub min: f64,
    pub max: f64,
    pub step: Option<f64>,
    /// Select 类型的选项标签（下拉项），其他类型可为 null
    #[serde(default)]
    pub options: Option<Vec<String>>,
}

/// 插件清单（manifest.json 反序列化目标）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub plugin_type: PluginType,
    pub min_app_version: String,
    #[serde(default)]
    pub parameters: Vec<ParameterDef>,
    /// FFmpeg 滤镜模板，`{key}` 占位符由参数实际值替换
    #[serde(default)]
    pub filter_spec: Option<String>,
    /// WGSL 着色器源码（预览用，可选）
    #[serde(default)]
    pub shader: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
}

// ════════════════════ 插件管理器 ════════════════════

/// 插件管理器：扫描目录、缓存清单、构建滤镜串
pub struct PluginManager {
    plugins: HashMap<String, PluginManifest>,
    plugin_dir: PathBuf,
}

impl PluginManager {
    /// 创建管理器。plugin_dir 为插件根目录（其下每个子目录代表一个插件）
    pub fn new(plugin_dir: PathBuf) -> Self {
        Self {
            plugins: HashMap::new(),
            plugin_dir,
        }
    }

    /// 扫描插件目录的子目录，加载所有合法的 manifest.json
    pub fn scan(&mut self) -> Result<usize> {
        if !self.plugin_dir.exists() {
            return Ok(0);
        }
        let mut count = 0;
        for entry in std::fs::read_dir(&self.plugin_dir)
            .with_context(|| format!("读取插件目录失败: {}", self.plugin_dir.display()))?
        {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let manifest_path = entry.path().join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }
            let json = std::fs::read_to_string(&manifest_path)
                .with_context(|| format!("读取 manifest 失败: {}", manifest_path.display()))?;
            let manifest = match Self::validate_manifest(&json) {
                Ok(m) => m,
                Err(e) => {
                    // 单个插件加载失败不阻断整体扫描
                    eprintln!("[plugin] 跳过 {}: {}", entry.path().display(), e);
                    continue;
                }
            };
            self.plugins.insert(manifest.id.clone(), manifest);
            count += 1;
        }
        Ok(count)
    }

    /// 获取所有已加载插件清单
    pub fn list(&self) -> Vec<&PluginManifest> {
        self.plugins.values().collect()
    }

    /// 按类型筛选
    pub fn list_by_type(&self, pt: &PluginType) -> Vec<&PluginManifest> {
        self.plugins
            .values()
            .filter(|m| &m.plugin_type == pt)
            .collect()
    }

    /// 按ID获取
    pub fn get(&self, id: &str) -> Option<&PluginManifest> {
        self.plugins.get(id)
    }

    /// 生成 FFmpeg 滤镜字符串。
    /// 将 filter_spec 模板中的 `{param_name}` 替换为参数实际值。
    /// 未提供的参数使用其 default 值；多余参数被忽略。
    pub fn build_filter(
        &self,
        plugin_id: &str,
        params: &HashMap<String, f64>,
    ) -> Result<String> {
        let manifest = self
            .plugins
            .get(plugin_id)
            .ok_or_else(|| anyhow!("插件未找到: {}", plugin_id))?;
        let template = manifest
            .filter_spec
            .as_ref()
            .ok_or_else(|| anyhow!("插件 {} 未定义 filter_spec", plugin_id))?;

        let mut result = template.clone();
        for p in &manifest.parameters {
            let value = params
                .get(&p.key)
                .copied()
                .unwrap_or(p.default)
                // 限制在 [min, max] 范围内，避免越界
                .clamp(p.min, p.max);
            let placeholder = format!("{{{}}}", p.key);
            result = result.replace(&placeholder, &format_number(value));
        }
        Ok(result)
    }

    /// 校验 manifest.json：解析 + 必填字段检查
    pub fn validate_manifest(json: &str) -> Result<PluginManifest> {
        let manifest: PluginManifest =
            serde_json::from_str(json).context("manifest.json 解析失败")?;
        if manifest.id.trim().is_empty() {
            bail!("manifest.id 不能为空");
        }
        if manifest.name.trim().is_empty() {
            bail!("manifest.name 不能为空");
        }
        if manifest.version.trim().is_empty() {
            bail!("manifest.version 不能为空");
        }
        // 简单语义化版本格式校验：必须包含至少两个点
        if manifest.version.matches('.').count() < 2 {
            bail!("manifest.version 不符合语义化版本格式: {}", manifest.version);
        }
        for p in &manifest.parameters {
            if p.key.trim().is_empty() {
                bail!("参数 key 不能为空");
            }
            if p.min > p.max {
                bail!("参数 {} 的 min({}) > max({})", p.key, p.min, p.max);
            }
            // default 应在 [min, max] 范围内（仅警告级别，不阻断）
            if p.default < p.min || p.default > p.max {
                eprintln!(
                    "[plugin] 警告: 参数 {} 的 default {} 不在 [{}, {}] 范围内",
                    p.key, p.default, p.min, p.max
                );
            }
        }
        Ok(manifest)
    }
}

/// 格式化数值：整数省略小数部分，浮点保留必要精度
fn format_number(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v)
    } else {
        // 去掉尾部多余零，最多 6 位小数
        let s = format!("{:.6}", v);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_MANIFEST: &str = r#"{
        "id": "filter.brightness",
        "name": "亮度调节",
        "version": "1.0.0",
        "author": "AIcut",
        "description": "调整画面亮度",
        "plugin_type": "Filter",
        "min_app_version": "0.1.0",
        "parameters": [
            {"key": "brightness", "label": "亮度", "param_type": "Slider", "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01},
            {"key": "contrast", "label": "对比度", "param_type": "Slider", "default": 1.0, "min": 0.0, "max": 3.0, "step": 0.01}
        ],
        "filter_spec": "eq=brightness={brightness}:contrast={contrast}",
        "shader": null,
        "thumbnail": "thumbnail.png"
    }"#;

    #[test]
    fn test_validate_manifest() {
        let m = PluginManager::validate_manifest(SAMPLE_MANIFEST).unwrap();
        assert_eq!(m.id, "filter.brightness");
        assert_eq!(m.plugin_type, PluginType::Filter);
        assert_eq!(m.parameters.len(), 2);
        assert_eq!(m.parameters[0].param_type, ParamType::Slider);
    }

    #[test]
    fn test_build_filter() {
        let mut mgr = PluginManager::new(PathBuf::from("/nonexistent"));
        let m = PluginManager::validate_manifest(SAMPLE_MANIFEST).unwrap();
        mgr.plugins.insert(m.id.clone(), m);

        let mut params = HashMap::new();
        params.insert("brightness".to_string(), 0.1);
        params.insert("contrast".to_string(), 1.2);
        let filter = mgr.build_filter("filter.brightness", &params).unwrap();
        assert_eq!(filter, "eq=brightness=0.1:contrast=1.2");
    }

    #[test]
    fn test_build_filter_uses_default() {
        let mut mgr = PluginManager::new(PathBuf::from("/nonexistent"));
        let m = PluginManager::validate_manifest(SAMPLE_MANIFEST).unwrap();
        mgr.plugins.insert(m.id.clone(), m);

        // 不提供任何参数，应使用 default 值
        let filter = mgr
            .build_filter("filter.brightness", &HashMap::new())
            .unwrap();
        assert_eq!(filter, "eq=brightness=0:contrast=1");
    }

    #[test]
    fn test_build_filter_clamps_out_of_range() {
        let mut mgr = PluginManager::new(PathBuf::from("/nonexistent"));
        let m = PluginManager::validate_manifest(SAMPLE_MANIFEST).unwrap();
        mgr.plugins.insert(m.id.clone(), m);

        let mut params = HashMap::new();
        params.insert("brightness".to_string(), 5.0); // 超出 max=1.0
        let filter = mgr.build_filter("filter.brightness", &params).unwrap();
        assert_eq!(filter, "eq=brightness=1:contrast=1");
    }

    #[test]
    fn test_invalid_manifest_empty_id() {
        let bad = r#"{
            "id": "", "name": "x", "version": "1.0.0", "author": "a",
            "description": "d", "plugin_type": "Filter", "min_app_version": "0.1.0",
            "parameters": []
        }"#;
        assert!(PluginManager::validate_manifest(bad).is_err());
    }

    #[test]
    fn test_plugin_type_serde() {
        let json = serde_json::to_string(&PluginType::TextTemplate).unwrap();
        assert_eq!(json, r#""TextTemplate""#);
        let pt: PluginType = serde_json::from_str(r#""Sticker""#).unwrap();
        assert_eq!(pt, PluginType::Sticker);
    }
}
