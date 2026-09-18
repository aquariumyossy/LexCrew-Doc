use crate::log;
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use time::{Duration, OffsetDateTime};

#[derive(Debug, Clone)]
pub struct CertPaths {
    pub ca_cert: PathBuf,
    pub server_cert: PathBuf,
    pub server_key: PathBuf,
}

pub fn certs_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("GURI")
        .join("certs")
}

pub fn ensure_certs() -> Result<CertPaths, String> {
    let dir = certs_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("証明書ディレクトリを作れませんでした: {e}"))?;

    let ca_cert_path = dir.join("ca.crt");
    let ca_key_path = dir.join("ca.key");
    let server_cert_path = dir.join("localhost.crt");
    let server_key_path = dir.join("localhost.key");

    if ca_cert_path.is_file()
        && ca_key_path.is_file()
        && server_cert_path.is_file()
        && server_key_path.is_file()
    {
        return Ok(CertPaths {
            ca_cert: ca_cert_path,
            server_cert: server_cert_path,
            server_key: server_key_path,
        });
    }

    let not_before = OffsetDateTime::now_utc() - Duration::days(1);
    let not_after = OffsetDateTime::now_utc() + Duration::days(3650);

    let ca_key = KeyPair::generate().map_err(|e| e.to_string())?;
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
    ];
    let mut ca_dn = DistinguishedName::new();
    ca_dn.push(DnType::CommonName, "GURI Local CA");
    ca_params.distinguished_name = ca_dn;
    ca_params.not_before = not_before;
    ca_params.not_after = not_after;
    let ca_cert = ca_params.self_signed(&ca_key).map_err(|e| e.to_string())?;

    let server_key = KeyPair::generate().map_err(|e| e.to_string())?;
    let mut server_params = CertificateParams::new(vec!["localhost".into(), "127.0.0.1".into()])
        .map_err(|e| e.to_string())?;
    let mut server_dn = DistinguishedName::new();
    server_dn.push(DnType::CommonName, "localhost");
    server_params.distinguished_name = server_dn;
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    server_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    server_params.not_before = not_before;
    server_params.not_after = not_after;
    let server_cert = server_params
        .signed_by(&server_key, &ca_cert, &ca_key)
        .map_err(|e| e.to_string())?;

    let mut chain = server_cert.pem();
    if !chain.ends_with('\n') {
        chain.push('\n');
    }
    chain.push_str(&ca_cert.pem());

    fs::write(&ca_cert_path, ca_cert.pem()).map_err(|e| e.to_string())?;
    fs::write(&ca_key_path, ca_key.serialize_pem()).map_err(|e| e.to_string())?;
    fs::write(&server_cert_path, chain).map_err(|e| e.to_string())?;
    fs::write(&server_key_path, server_key.serialize_pem()).map_err(|e| e.to_string())?;

    log::info("certificates generated", None);

    Ok(CertPaths {
        ca_cert: ca_cert_path,
        server_cert: server_cert_path,
        server_key: server_key_path,
    })
}

pub fn trust_ca(ca_cert: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = ca_cert;
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = Command::new("certutil")
            .args(["-user", "-addstore", "Root"])
            .arg(ca_cert)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("certutil を起動できませんでした: {e}"))?;
        if output.status.success() {
            log::info_status("certificate trust", "ok");
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{stdout} {stderr}").to_ascii_lowercase();
            if combined.contains("already") || combined.contains("存在する") {
                log::info_status("certificate trust", "exists");
                return Ok(());
            }
            Err(format!(
                "certutil が失敗しました (code {:?})",
                output.status.code()
            ))
        }
    }
}
