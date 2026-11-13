//! e-Gov law API.
//!
//! The rest of this module still builds the Version 1 URL shape, because the
//! lookup tests match those paths. `LiveEgov` translates them and sends
//! Version 2 requests that contain only a law id and, for one article, that
//! article's number. Document text is never sent.
//!
//! Spec: https://laws.e-gov.go.jp/api/2/

use std::time::Duration;

#[cfg(test)]
use parking_lot::Mutex;

pub const API_ORIGIN: &str = "https://laws.e-gov.go.jp/api/1";
const USER_AGENT: &str = "GURI/1.3.3 (LexCrew-Doc statute cache; e-Gov law API v2)";
const V2_ORIGIN: &str = "https://laws.e-gov.go.jp/api/2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgovFailure {
    Offline,
    NotFound,
    Bad(String),
}

pub trait EgovSource: Send + Sync {
    fn fetch(&self, url: &str) -> Result<String, EgovFailure>;
}

pub fn article_url(law_id: &str, article: &str) -> String {
    format!(
        "{API_ORIGIN}/articles;lawId={};article={}",
        encode(law_id),
        encode(article)
    )
}

pub fn lawdata_url(law_id: &str) -> String {
    format!("{API_ORIGIN}/lawdata/{}", encode(law_id))
}

pub fn update_list_url(yyyymmdd: &str) -> String {
    format!("{API_ORIGIN}/updatelawlists/{yyyymmdd}")
}

pub fn lawlist_url(category: u8) -> String {
    format!("{API_ORIGIN}/lawlists/{category}")
}

fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub struct LiveEgov {
    client: reqwest::blocking::Client,
}

impl LiveEgov {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(5))
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { client })
    }
}

/// Version 2 URL for a Version 1 article or full-law URL. `None` when this
/// URL is not one of those two.
pub fn v2_url(legacy: &str) -> Option<String> {
    if let Some(rest) = legacy.split("articles;lawId=").nth(1) {
        let (law_id, article) = rest.split_once(";article=")?;
        let article = percent_decode(article);
        let key = article_elm_key(&article)?;
        return Some(format!(
            "{V2_ORIGIN}/law_data/{law_id}?response_format=xml&law_full_text_format=xml&elm=MainProvision-Article_{key}"
        ));
    }
    if let Some(rest) = legacy.split("/lawdata/").nth(1) {
        let law_id = rest.split(['?', '#', '&']).next().unwrap_or(rest);
        if law_id.is_empty() {
            return None;
        }
        return Some(format!(
            "{V2_ORIGIN}/law_data/{law_id}?response_format=xml&law_full_text_format=xml"
        ));
    }
    None
}

fn article_elm_key(article: &str) -> Option<String> {
    let (key, _) = crate::statute::xmlparse::parse_article_query(article)?;
    let key = key.strip_prefix('s').unwrap_or(&key);
    let key = key.split('#').next().unwrap_or(key);
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_digit() || c == '_') {
        return None;
    }
    Some(key.to_string())
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl EgovSource for LiveEgov {
    fn fetch(&self, url: &str) -> Result<String, EgovFailure> {
        let target = if url.contains("/api/2/") {
            url.to_string()
        } else {
            match v2_url(url) {
                Some(next) => next,
                // Law lists and update lists are not sent. Callers that need a
                // name which is not already local get an empty catalog instead.
                None => {
                    return Err(EgovFailure::Bad(
                        "法令IDと条番号以外は e-Gov に送りません".into(),
                    ))
                }
            }
        };
        let response = match self.client.get(&target).send() {
            Ok(response) => response,
            Err(_) => return Err(EgovFailure::Offline),
        };
        let status = response.status();
        if status.as_u16() == 404 {
            return Err(EgovFailure::NotFound);
        }
        if !status.is_success() {
            return Err(EgovFailure::Bad(format!(
                "法令APIが応答しませんでした（HTTP {}）",
                status.as_u16()
            )));
        }
        match response.text() {
            Ok(body) => {
                if body.trim_start().starts_with("<!DOCTYPE html")
                    || body.contains("Request Rejected")
                {
                    return Err(EgovFailure::Bad("法令APIがリクエストを拒否しました".into()));
                }
                Ok(body)
            }
            Err(_) => Err(EgovFailure::Offline),
        }
    }
}

pub struct OfflineEgov;

impl EgovSource for OfflineEgov {
    fn fetch(&self, _url: &str) -> Result<String, EgovFailure> {
        Err(EgovFailure::Offline)
    }
}

/// Test double. The first needle contained in the URL wins.
#[cfg(test)]
pub struct MapEgov {
    pub routes: Mutex<Vec<(String, Result<String, EgovFailure>)>>,
}

#[cfg(test)]
impl MapEgov {
    pub fn new(routes: Vec<(String, Result<String, EgovFailure>)>) -> Self {
        Self {
            routes: Mutex::new(routes),
        }
    }
}

#[cfg(test)]
impl EgovSource for MapEgov {
    fn fetch(&self, url: &str) -> Result<String, EgovFailure> {
        for (needle, result) in self.routes.lock().iter() {
            if url.contains(needle) {
                return result.clone();
            }
        }
        Err(EgovFailure::Offline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn article_url_encodes_the_japanese_article_number() {
        let url = article_url("129AC0000000089", "第555条");
        assert!(url
            .starts_with("https://laws.e-gov.go.jp/api/1/articles;lawId=129AC0000000089;article="));
        assert!(url.contains("%E7%AC%AC555%E6%9D%A1"));
        assert!(!url.contains("第"));
        assert_eq!(
            update_list_url("20261111"),
            "https://laws.e-gov.go.jp/api/1/updatelawlists/20261111"
        );
    }

    #[test]
    fn live_requests_use_law_id_and_article_number_only() {
        let legacy = article_url("129AC0000000089", "第3条の2");
        let url = v2_url(&legacy).unwrap();
        assert!(url.starts_with(
            "https://laws.e-gov.go.jp/api/2/law_data/129AC0000000089?"
        ));
        assert!(url.contains("elm=MainProvision-Article_3_2"));
        assert!(url.contains("response_format=xml"));
        assert!(!url.contains("第"));
        assert!(!url.contains("条"));
        let full = v2_url(&lawdata_url("129AC0000000089")).unwrap();
        assert!(full.contains("/law_data/129AC0000000089?"));
        assert!(!full.contains("elm="));
        assert!(v2_url(&update_list_url("20261111")).is_none());
        assert!(v2_url(&lawlist_url(2)).is_none());
    }
}
