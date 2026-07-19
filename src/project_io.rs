//! src/project_io.rs — 工程文件读写
//! JSON 序列化/反序列化 + 自动保存/备份

use crate::project::Project;
use std::fs;
use std::path::Path;

/// 从文件加载工程
pub fn load(path: &str) -> Result<Project, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("读取工程文件失败 {}: {}", path, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("工程 JSON 解析失败: {}", e))
}

/// 保存工程到文件，自动创建父目录
pub fn save(project: &Project, path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let json = serde_json::to_string_pretty(project)
        .map_err(|e| format!("工程序列化失败: {}", e))?;
    fs::write(path, &json)
        .map_err(|e| format!("写入工程文件失败 {}: {}", path, e))
}

/// 带备份的保存：原文件 → .bak，再写入新内容
pub fn save_with_backup(project: &Project, path: &str) -> Result<(), String> {
    let bak = format!("{}.bak", path);
    if Path::new(path).exists() {
        fs::copy(path, &bak)
            .map_err(|e| format!("备份失败: {}", e))?;
    }
    save(project, path)
}

/// 自动备份到 `.aicut/backups/` 目录，带时间戳
pub fn autosave(project: &Project, project_path: &str) -> Result<String, String> {
    let dir = Path::new(project_path).parent()
        .map(|p| p.join(".aicut").join("backups"))
        .unwrap_or_else(|| Path::new(".aicut").join("backups"));
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {}", e))?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("时间错误: {}", e))?
        .as_secs();
    let stem = Path::new(project_path).file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());
    let backup_path = dir.join(format!("{}_{}.json", stem, ts));
    let path_str = backup_path.to_string_lossy().to_string();
    save(project, &path_str)?;
    Ok(path_str)
}

/// 列出备份文件
pub fn list_backups(project_path: &str) -> Result<Vec<String>, String> {
    let dir = Path::new(project_path).parent()
        .map(|p| p.join(".aicut").join("backups"))
        .unwrap_or_else(|| Path::new(".aicut").join("backups"));
    if !dir.exists() { return Ok(vec![]); }
    let mut files = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取备份目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("{}", e))?;
        files.push(entry.file_name().to_string_lossy().to_string());
    }
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::*;

    fn test_project() -> Project {
        Project {
            version: "1.0".into(),
            canvas: CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
            assets: vec![],
            tracks: vec![],
        }
    }

    fn tmp_path(name: &str) -> String {
        std::env::temp_dir().join(name).to_string_lossy().to_string()
    }

    #[test]
    fn test_save_load_roundtrip() {
        let p = test_project();
        let tmp = tmp_path("aicut_test_project.json");
        save(&p, &tmp).expect("save");
        let loaded = load(&tmp).expect("load");
        assert_eq!(loaded.version, "1.0");
        assert_eq!(loaded.canvas.width, 1920);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_save_with_backup() {
        let p = test_project();
        let tmp = tmp_path("aicut_test_bak.json");
        save(&p, &tmp).expect("save1");
        save_with_backup(&p, &tmp).expect("save2");
        assert!(Path::new(&format!("{}.bak", &tmp)).exists());
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(format!("{}.bak", &tmp));
    }

    #[test]
    fn test_autosave() {
        let p = test_project();
        let tmp = tmp_path("aicut_autosave.json");
        let backup = autosave(&p, &tmp).expect("autosave");
        assert!(backup.contains(".aicut"));
        let _ = fs::remove_dir_all(Path::new(&tmp).parent().unwrap().join(".aicut"));
    }
}
