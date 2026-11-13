//! Built-in statute database. Citations are checked here, not by an LLM.

mod catalog;
mod check;
mod cite;
mod egov;
mod legal_ref;
mod lookup;
mod refresh;
mod store;
mod xmlparse;

pub use check::check_text;
pub use cite::{cap_statute_tool_text, format_tool_result};
pub use egov::{EgovFailure, EgovSource, LiveEgov, OfflineEgov};
pub use lookup::{resolve_articles, resolve_without_refresh, ArticleQuery};
pub use store::StatuteDb;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

pub struct StatuteService {
    pub db: StatuteDb,
    pub client: Arc<dyn EgovSource>,
    pub enabled: AtomicBool,
}

impl StatuteService {
    /// Opens the statute database without importing the seed. A broken file
    /// disables statute features and does not stop the rest of the app.
    pub fn open(data_dir: &Path) -> Self {
        match Self::try_open(data_dir) {
            Ok(service) => service,
            Err(err) => {
                eprintln!("guri: statute db disabled: {err}");
                Self::disabled()
            }
        }
    }

    fn try_open(data_dir: &Path) -> Result<Self, String> {
        let db = StatuteDb::open_empty(&data_dir.join("statutes.db"))?;
        let _ = db.article_count()?;
        let client: Arc<dyn EgovSource> = match LiveEgov::new() {
            Ok(client) => Arc::new(client),
            Err(err) => {
                eprintln!("guri: e-Gov client disabled: {err}");
                Arc::new(OfflineEgov)
            }
        };
        Ok(Self {
            db,
            client,
            enabled: AtomicBool::new(true),
        })
    }

    pub fn disabled() -> Self {
        let db = StatuteDb::open_memory().unwrap_or_else(|err| {
            eprintln!("guri: in-memory statute db failed: {err}");
            StatuteDb::open_empty(&std::env::temp_dir().join("guri-statute-disabled.db"))
                .expect("statute fallback")
        });
        Self {
            db,
            client: Arc::new(OfflineEgov),
            enabled: AtomicBool::new(false),
        }
    }

    /// Tests and offline callers. Does not import the bundled seed and never dials out.
    #[allow(dead_code)]
    pub fn open_offline(data_dir: &Path) -> Result<Self, String> {
        let db = StatuteDb::open_empty(&data_dir.join("statutes.db"))?;
        Ok(Self {
            db,
            client: Arc::new(OfflineEgov),
            enabled: AtomicBool::new(true),
        })
    }
}

/// Import the bundled seed. Not part of process startup.
pub fn prepare_service(service: &StatuteService) -> Result<(), String> {
    if !service.enabled.load(Ordering::Relaxed) {
        return Ok(());
    }
    if let Err(err) = service.db.import_seed() {
        service.enabled.store(false, Ordering::Relaxed);
        return Err(err);
    }
    Ok(())
}

/// Process-wide database under `%APPDATA%\GURI` (`dirs::data_dir()/GURI`).
/// The seed is imported on the first call.
pub fn shared() -> &'static StatuteService {
    static SERVICE: OnceLock<StatuteService> = OnceLock::new();
    SERVICE.get_or_init(|| {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("GURI");
        let service = StatuteService::open(&dir);
        if service.enabled.load(Ordering::Relaxed) {
            if let Err(err) = prepare_service(&service) {
                eprintln!("guri: statute seed: {err}");
            }
        }
        service
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_corrupt_statute_file_does_not_stop_open() {
        let dir = std::env::temp_dir().join(format!(
            "guri-statute-corrupt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("statutes.db"), "this is not sqlite").unwrap();
        let service = StatuteService::open(&dir);
        assert!(!service.enabled.load(Ordering::Relaxed));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
