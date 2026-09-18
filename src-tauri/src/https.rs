use crate::api::create_router;
use crate::constants::{HOST, PORT};
use crate::log;
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use std::net::TcpListener;
use std::path::PathBuf;

pub fn bind_listener() -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind((HOST, PORT))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

pub fn is_addr_in_use(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::AddrInUse
}

fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

pub async fn serve(
    listener: TcpListener,
    cert_pem: PathBuf,
    key_pem: PathBuf,
    router: Router,
) -> Result<(), String> {
    install_crypto_provider();
    let config = RustlsConfig::from_pem_file(&cert_pem, &key_pem)
        .await
        .map_err(|e| format!("TLS 設定を読めませんでした: {e}"))?;
    log::info(&format!("listening https://{HOST}:{PORT}"), None);
    axum_server::from_tcp_rustls(listener, config)
        .map_err(|e| format!("HTTPS の待受に失敗しました: {e}"))?
        .serve(router.into_make_service())
        .await
        .map_err(|e| format!("HTTPS サーバが停止しました: {e}"))
}

pub fn make_router(static_dir: Option<PathBuf>) -> Router {
    create_router(static_dir)
}
