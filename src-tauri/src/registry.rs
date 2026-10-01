use crate::constants::ADDIN_ID;
use crate::log;
use regex::Regex;
use std::path::Path;

pub fn addin_id_from_manifest(manifest_path: &Path) -> Result<String, String> {
    let xml = std::fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
    let re = Regex::new(r"(?i)<Id>([^<]+)</Id>").expect("id regex");
    re.captures(&xml)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "manifest.xml からアドイン ID を読めませんでした。".into())
}

#[cfg(windows)]
fn hkcu() -> winreg::RegKey {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
}

pub fn register_addin(manifest_path: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = manifest_path;
        Ok(())
    }
    #[cfg(windows)]
    {
        let id = addin_id_from_manifest(manifest_path).unwrap_or_else(|_| ADDIN_ID.to_string());
        let abs =
            std::fs::canonicalize(manifest_path).unwrap_or_else(|_| manifest_path.to_path_buf());
        let abs = abs.to_string_lossy().replacen(r"\\?\", "", 1);
        let (key, _) = hkcu()
            .create_subkey("SOFTWARE\\Microsoft\\Office\\16.0\\Wef\\Developer")
            .map_err(|e| format!("WEF Developer キーを開けませんでした: {e}"))?;
        key.set_value(&id, &abs)
            .map_err(|e| format!("アドインを登録できませんでした: {e}"))?;
        log::info("add-in registered", None);
        Ok(())
    }
}

pub fn unregister_addin(manifest_path: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = manifest_path;
        Ok(())
    }
    #[cfg(windows)]
    {
        use winreg::enums::*;
        let id = addin_id_from_manifest(manifest_path).unwrap_or_else(|_| ADDIN_ID.to_string());
        if let Ok(key) = hkcu().open_subkey_with_flags(
            "SOFTWARE\\Microsoft\\Office\\16.0\\Wef\\Developer",
            KEY_SET_VALUE,
        ) {
            let _ = key.delete_value(&id);
        }
        Ok(())
    }
}

pub fn cleanup_electron_run_value() {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        if let Ok(key) = hkcu().open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            KEY_READ | KEY_SET_VALUE,
        ) {
            let value: Result<String, _> = key.get_value("GURI");
            if let Ok(data) = value {
                if !data.contains("--autostart") {
                    let _ = key.delete_value("GURI");
                    log::info("removed leftover Electron Run key", None);
                }
            }
        }
    }
}

pub fn delete_guri_software_key() {
    #[cfg(windows)]
    {
        let _ = hkcu().delete_subkey_all("Software\\GURI");
    }
}

pub fn delete_run_value() {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        if let Ok(key) = hkcu().open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            KEY_SET_VALUE,
        ) {
            let _ = key.delete_value("GURI");
        }
    }
}
