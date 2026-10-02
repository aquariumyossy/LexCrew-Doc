mod api;
mod argos;
mod certs;
mod connection;
mod constants;
mod history;
mod https;
mod indexed;
mod json;
mod llm;
mod log;
mod ocr;
mod paths;
mod registry;
mod search;
mod thinking;

use serde_json::json;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

struct TrayCell(Mutex<Option<tauri::tray::TrayIcon>>);

fn wants_uninstall_hooks() -> bool {
    std::env::args().any(|a| a == "--uninstall-hooks")
}

fn show_error(app: &AppHandle, message: &str) {
    let _ = app.dialog().message(message).title("LexCrew Doc").blocking_show();
}

fn run_uninstall_hooks(app: &AppHandle) {
    let _ = app.autolaunch().disable();
    registry::delete_run_value();
    registry::delete_guri_software_key();
    if let Some(manifest) = paths::resolve_manifest(Some(app)) {
        let _ = registry::unregister_addin(&manifest);
    }
    log::info("uninstall hooks done", None);
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let status = MenuItem::with_id(app, "status", "LexCrew Doc 起動中", false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "ログイン時に起動",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&status, &sep1, &autostart, &sep2, &quit])
}

fn rebuild_tray_menu(app: &AppHandle) {
    if let Ok(menu) = tray_menu(app) {
        if let Ok(guard) = app.state::<TrayCell>().0.lock() {
            if let Some(tray) = guard.as_ref() {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
}

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = tray_menu(app)?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("default window icon missing")?;
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("LexCrew Doc 起動中")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "autostart" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let result = if enabled {
                    app.autolaunch().disable()
                } else {
                    app.autolaunch().enable()
                };
                match result {
                    Ok(()) => log::info("login item", Some(json!({ "openAtLogin": !enabled }))),
                    Err(_) => log::error_name("login item", "error"),
                }
                rebuild_tray_menu(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    if let Ok(mut guard) = app.state::<TrayCell>().0.lock() {
        *guard = Some(tray);
    }
    Ok(())
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let handle = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = handle.hide();
            }
        });
    }
}

fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let certs = certs::ensure_certs().map_err(|e| {
        log::error_name("certificate install failed", "error");
        e
    })?;
    if let Err(error) = certs::trust_ca(&certs.ca_cert) {
        log::error(
            "certificate install failed",
            Some(json!({ "name": "error" })),
        );
        show_error(
            app,
            "HTTPS 証明書を現在のユーザーの信頼ストアに入れられませんでした。作業ウィンドウが白紙のときは、LexCrew Doc を終了してから開き直してください。",
        );
        let _ = error;
    }

    if let Some(manifest) = paths::resolve_manifest(Some(app)) {
        if let Err(error) = registry::register_addin(&manifest) {
            log::error_name("add-in register failed", "error");
            show_error(
                app,
                "Word アドインの登録に失敗しました。Word を閉じてから LexCrew Doc を開き直してください。",
            );
            let _ = error;
        }
    } else {
        log::error_name("add-in register failed", "missing-manifest");
        show_error(
            app,
            "Word アドインの登録に失敗しました。Word を閉じてから LexCrew Doc を開き直してください。",
        );
    }

    let listener = match https::bind_listener() {
        Ok(listener) => listener,
        Err(error) if https::is_addr_in_use(&error) => {
            log::error(
                "server failed",
                Some(json!({ "name": "error", "code": "EADDRINUSE" })),
            );
            return Err(
                "ポート 28765 は既に使われています。起動中の LexCrew Doc または開発用サーバ（npm start）を終了してください。"
                    .into(),
            );
        }
        Err(error) => {
            log::error(
                "server failed",
                Some(json!({ "name": "error", "code": error.kind().to_string() })),
            );
            return Err("ローカルサーバを起動できませんでした。".into());
        }
    };

    let router = https::make_router(paths::resolve_static_dir(app));
    let cert = certs.server_cert.clone();
    let key = certs.server_key.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = https::serve(listener, cert, key, router).await {
            log::error("server failed", Some(json!({ "name": "error" })));
            let _ = error;
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log::init_default_log_file();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--autostart")
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app.dialog()
                .message("既に起動しています。")
                .title("LexCrew Doc")
                .show(|_| {});
        }))
        .manage(TrayCell(Mutex::new(None)))
        .setup(|app| {
            if wants_uninstall_hooks() {
                run_uninstall_hooks(app.handle());
                std::process::exit(0);
            }

            registry::cleanup_electron_run_value();
            hide_main_window(app.handle());

            if let Err(e) = setup_tray(app.handle()) {
                log::error(
                    "tray setup failed",
                    Some(json!({ "name": "error", "detail": e.to_string() })),
                );
            }

            if let Err(message) = start_sidecar(app.handle()) {
                show_error(app.handle(), &message);
                app.handle().exit(1);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("error while running GURI: {e}");
        });
}
