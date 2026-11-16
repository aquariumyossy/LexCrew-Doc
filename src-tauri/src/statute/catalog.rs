//! Statute names and abbreviations.
//!
//! The shared list is `src/shared/statute_aliases.json`. The chat marker
//! imports that same file. `statuteAliasExtras.json` adds titles that contain
//! 及び and are not in the shared list. `bundle: false` only records the name,
//! the same way 金融商品取引法 is shipped.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;

const ALIAS_JSON: &str = include_str!("../../../src/shared/statute_aliases.json");
const EXTRAS_JSON: &str = include_str!("../../../src/shared/statuteAliasExtras.json");

#[derive(Debug, Clone, Deserialize)]
struct AliasFile {
    #[serde(default)]
    group_labels: Vec<String>,
    entries: Vec<CatalogEntryRaw>,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogEntryRaw {
    law_id: String,
    name: String,
    #[serde(default)]
    bundle: bool,
    #[serde(default)]
    aliases: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CatalogEntry {
    pub law_id: String,
    pub name: String,
    /// Full text is packed into the app. `false` only adds the name so a later
    /// fetch can resolve it.
    pub bundle: bool,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AliasList {
    pub group_labels: Vec<String>,
    pub entries: Vec<CatalogEntry>,
}

static LIST: OnceLock<AliasList> = OnceLock::new();

pub fn alias_list() -> Result<&'static AliasList, String> {
    if let Some(list) = LIST.get() {
        return Ok(list);
    }
    let mut list = parse_alias_list(ALIAS_JSON)?;
    // A bad extra row must not throw away the main list.
    if let Err(err) = append_entries(&mut list, EXTRAS_JSON) {
        eprintln!("guri: extra statute aliases were not applied: {err}");
    }
    Ok(LIST.get_or_init(|| list))
}

#[cfg(test)]
pub fn catalog() -> Result<&'static [CatalogEntry], String> {
    Ok(alias_list()?.entries.as_slice())
}

#[cfg(test)]
pub fn aliases_for(law_id: &str) -> Result<Vec<String>, String> {
    Ok(alias_list()?
        .entries
        .iter()
        .find(|entry| entry.law_id == law_id)
        .map(|entry| entry.aliases.clone())
        .unwrap_or_default())
}

pub fn is_listed_name(name: &str) -> bool {
    listed_names().iter().any(|alias| *alias == name)
}

/// Longest shared law name that is the whole window or exactly its tail.
pub fn longest_listed_name_suffix(window: &str) -> Option<&'static str> {
    listed_names()
        .iter()
        .copied()
        .find(|name| name.chars().count() >= 2 && (window == *name || window.ends_with(name)))
}

fn listed_names() -> &'static [&'static str] {
    static NAMES: OnceLock<Vec<&'static str>> = OnceLock::new();
    NAMES
        .get_or_init(|| {
            let Ok(list) = alias_list() else {
                return Vec::new();
            };
            let mut names = Vec::new();
            for entry in &list.entries {
                names.push(entry.name.as_str());
                names.extend(entry.aliases.iter().map(String::as_str));
            }
            names.sort_by(|left, right| {
                right
                    .chars()
                    .count()
                    .cmp(&left.chars().count())
                    .then_with(|| left.cmp(right))
            });
            names.dedup();
            names
        })
        .as_slice()
}

pub fn normalize_alias(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && *c != '　')
        .collect()
}

/// Split an e-Gov `LawTitle@Abbrev` value. ASCII `,` separates aliases.
/// Japanese `、` stays inside a name. Group labels are dropped.
pub fn split_alias(raw: &str, group_labels: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for part in raw.split(',') {
        let norm = normalize_alias(part);
        if norm.chars().count() < 2 {
            continue;
        }
        if group_labels.iter().any(|label| label == &norm) {
            continue;
        }
        if !out.contains(&norm) {
            out.push(norm);
        }
    }
    out
}

fn parse_alias_list(raw: &str) -> Result<AliasList, String> {
    let file: AliasFile = serde_json::from_str(raw)
        .map_err(|err| format!("法令略称リストを読めませんでした: {err}"))?;
    if file.entries.is_empty() {
        return Err("法令略称リストが空です".into());
    }
    let mut group_labels = Vec::new();
    for label in &file.group_labels {
        let norm = normalize_alias(label);
        if norm.chars().count() < 2 {
            return Err(format!("総称が短すぎます: {label}"));
        }
        if !group_labels.contains(&norm) {
            group_labels.push(norm);
        }
    }
    let mut entries = Vec::with_capacity(file.entries.len());
    let mut seen_ids = HashSet::new();
    let mut seen_alias: HashMap<String, String> = HashMap::new();
    for entry in file.entries {
        push_entry(
            &mut entries,
            &mut seen_ids,
            &mut seen_alias,
            &group_labels,
            entry,
        )?;
    }
    Ok(AliasList {
        group_labels,
        entries,
    })
}

fn append_entries(list: &mut AliasList, raw: &str) -> Result<(), String> {
    let extra = parse_alias_list(raw)?;
    let mut seen_ids: HashSet<String> = list
        .entries
        .iter()
        .map(|entry| entry.law_id.clone())
        .collect();
    let mut seen_alias: HashMap<String, String> = HashMap::new();
    for entry in &list.entries {
        for alias in &entry.aliases {
            seen_alias.insert(alias.clone(), entry.law_id.clone());
        }
    }
    for entry in extra.entries {
        let law_id = entry.law_id.clone();
        let raw = CatalogEntryRaw {
            law_id: entry.law_id,
            name: entry.name,
            bundle: entry.bundle,
            aliases: entry.aliases,
        };
        if let Err(err) = push_entry(
            &mut list.entries,
            &mut seen_ids,
            &mut seen_alias,
            &list.group_labels,
            raw,
        ) {
            eprintln!("guri: skipped an extra statute alias ({law_id}): {err}");
        }
    }
    Ok(())
}

fn push_entry(
    entries: &mut Vec<CatalogEntry>,
    seen_ids: &mut HashSet<String>,
    seen_alias: &mut HashMap<String, String>,
    group_labels: &[String],
    entry: CatalogEntryRaw,
) -> Result<(), String> {
    let law_id = entry.law_id.trim().to_string();
    let name = normalize_alias(&entry.name);
    if law_id.is_empty() || name.is_empty() {
        return Err("法令略称リストに law_id または name が空の行があります".into());
    }
    if !seen_ids.insert(law_id.clone()) {
        return Err(format!(
            "法令略称リストの law_id が重複しています: {law_id}"
        ));
    }
    if group_labels.iter().any(|label| label == &name) {
        return Err(format!("総称は一つの法令の名称にできません: {name}"));
    }
    let mut aliases = Vec::new();
    {
        let mut push_alias = |norm: String| -> Result<(), String> {
            if norm.chars().count() < 2 {
                return Err(format!("略称が短すぎます: {norm} ({law_id})"));
            }
            if group_labels.iter().any(|label| label == &norm) {
                return Err(format!("総称は一つの法令の略称にできません: {norm}"));
            }
            if let Some(other) = seen_alias.get(&norm) {
                if other != &law_id {
                    return Err(format!(
                        "略称 {norm} が {other} と {law_id} の両方にあります"
                    ));
                }
            } else {
                seen_alias.insert(norm.clone(), law_id.clone());
            }
            if !aliases.contains(&norm) {
                aliases.push(norm);
            }
            Ok(())
        };
        push_alias(name.clone())?;
        for alias in &entry.aliases {
            if alias.contains(',') {
                return Err(format!(
                    "略称リストに ASCII カンマがあります（分割は保存時に行います）: {alias}"
                ));
            }
            push_alias(normalize_alias(alias))?;
        }
    }
    entries.push(CatalogEntry {
        law_id,
        name,
        bundle: entry.bundle,
        aliases,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_lists_match_the_shared_json() {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/shared/lawCatalog.json")).unwrap();
        let deny = file["deny"].as_array().unwrap();
        let got: Vec<&str> = deny.iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(got, crate::statute::check::DENY_LAW_NAME);
        let ending = file["denyEnding"].as_array().unwrap();
        let got: Vec<&str> = ending.iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(got, crate::statute::check::DENY_LAW_ENDING);
    }

    #[test]
    fn shared_list_loads_without_group_labels_or_commas() {
        let list = alias_list().unwrap();
        assert!(list.group_labels.iter().any(|label| label == "労働三法"));
        assert!(list
            .group_labels
            .iter()
            .any(|label| label == "組織犯罪対策三法"));
        assert!(list.group_labels.iter().any(|label| label == "保安四法"));
        assert!(list.entries.len() >= 60, "{}", list.entries.len());
        let mut bundled = 0;
        for entry in &list.entries {
            if entry.bundle {
                bundled += 1;
            }
            for alias in &entry.aliases {
                assert!(!alias.contains(','), "{alias}");
                assert!(
                    !list.group_labels.iter().any(|label| label == alias),
                    "{alias}"
                );
            }
        }
        assert!(bundled >= 50, "bundled entries {bundled}");
        let pieces = split_alias(
            "労組法,労働三法,労安衛法,保安四法,安衛法,訪問販売、通信販売、マルチ販売等法",
            &list.group_labels,
        );
        assert_eq!(
            pieces,
            vec![
                "労組法".to_string(),
                "労安衛法".to_string(),
                "安衛法".to_string(),
                "訪問販売、通信販売、マルチ販売等法".to_string(),
            ]
        );
        assert!(is_listed_name("自賠法"));
        assert!(is_listed_name("自賠責法"));
        assert!(is_listed_name("個人情報保護法"));
        assert!(is_listed_name("フリーランス法"));
        assert!(is_listed_name("取適法"));
        assert!(is_listed_name("PL法"));
        assert!(is_listed_name("ＰＬ法"));
        assert!(is_listed_name("宅建法"));
        assert!(is_listed_name("入管法"));
        assert!(!is_listed_name("労働三法"));
        assert_eq!(longest_listed_name_suffix("取適法"), Some("取適法"));
    }

    #[test]
    fn a_duplicate_extra_keeps_the_main_list() {
        let main = r#"{"entries":[{"law_id":"A","name":"民法","bundle":true,"aliases":["民法","自賠法"]}]}"#;
        let extra = r#"{"entries":[
            {"law_id":"A","name":"民法","aliases":["民法","景表法"]},
            {"law_id":"B","name":"入管法","aliases":["入管法"]}
        ]}"#;
        let list = load_for_test(main, extra).unwrap();
        assert!(list.entries.iter().any(|entry| entry.aliases.iter().any(|alias| alias == "自賠法")));
        assert_eq!(list.entries.iter().filter(|entry| entry.law_id == "A").count(), 1);
        assert!(list.entries.iter().any(|entry| entry.law_id == "B"));
        assert!(load_for_test(main, "{").unwrap().entries.iter().any(|entry| entry.law_id == "A"));
    }

    fn load_for_test(main: &str, extra: &str) -> Result<AliasList, String> {
        let mut list = parse_alias_list(main)?;
        let _ = append_entries(&mut list, extra);
        Ok(list)
    }
}
