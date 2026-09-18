use std::path::PathBuf;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

pub fn resolve_manifest(app: Option<&AppHandle>) -> Option<PathBuf> {
    let mut cands = Vec::new();
    if let Some(app) = app {
        if let Ok(p) = app.path().resolve("manifest.xml", BaseDirectory::Resource) {
            cands.push(p);
        }
        if let Ok(dir) = app.path().resource_dir() {
            cands.push(dir.join("manifest.xml"));
        }
    }
    if let Some(dir) = exe_dir() {
        cands.push(dir.join("manifest.xml"));
        cands.push(dir.join("resources").join("manifest.xml"));
    }
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("manifest.xml"),
    );
    cands.into_iter().find(|p| p.is_file())
}

pub fn resolve_static_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut cands = Vec::new();
    if let Ok(p) = app.path().resolve("taskpane", BaseDirectory::Resource) {
        cands.push(p);
    }
    if let Ok(dir) = app.path().resource_dir() {
        cands.push(dir.join("taskpane"));
    }
    if let Some(dir) = exe_dir() {
        cands.push(dir.join("taskpane"));
        cands.push(dir.join("resources").join("taskpane"));
    }
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist"),
    );
    cands.into_iter().find(|p| p.is_dir())
}
