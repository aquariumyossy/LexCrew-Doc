/**
 * Law names and abbreviations shared with the Rust checker.
 * `statute_aliases.json` is the copied list. `statuteAliasExtras.json` adds
 * titles that contain 及び and are not in that list.
 */
import extras from "./statuteAliasExtras.json";
import shared from "./statute_aliases.json";

export type CatalogAlias = { alias: string; id: string; canonical: string };

type Entry = {
  law_id: string;
  name: string;
  bundle?: boolean;
  aliases?: string[];
};

export function normalizeAlias(text: string): string {
  return Array.from(text)
    .filter((ch) => !/\s/u.test(ch) && ch !== "\u3000")
    .join("");
}

const sharedGroups = Array.isArray(shared.group_labels) ? shared.group_labels : [];
const sharedEntries = Array.isArray(shared.entries) ? (shared.entries as Entry[]) : [];
const extraEntries = Array.isArray(extras.entries) ? (extras.entries as Entry[]) : [];

export const GROUP_LABELS: string[] = sharedGroups
  .map((label) => normalizeAlias(label))
  .filter((label) => Array.from(label).length >= 2);

const groups = new Set(GROUP_LABELS);

/** Split an e-Gov Abbrev on ASCII commas. Japanese 「、」 stays inside a name. */
export function splitAlias(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const norm = normalizeAlias(part);
    if (Array.from(norm).length < 2 || groups.has(norm) || out.includes(norm)) {
      continue;
    }
    out.push(norm);
  }
  return out;
}

function loadEntries(entries: Entry[]): CatalogAlias[] {
  const out: CatalogAlias[] = [];
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  for (const entry of entries) {
    const id = entry.law_id.trim();
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const canonical = normalizeAlias(entry.name);
    const aliases = [canonical, ...(entry.aliases ?? []).flatMap((alias) => splitAlias(alias))];
    for (const alias of aliases) {
      if (Array.from(alias).length < 2 || groups.has(alias) || seen.has(alias)) {
        continue;
      }
      seen.add(alias);
      out.push({ alias, id, canonical });
    }
  }
  out.sort(
    (a, b) => Array.from(b.alias).length - Array.from(a.alias).length || a.alias.localeCompare(b.alias, "ja")
  );
  return out;
}

export const CATALOG_ALIASES: CatalogAlias[] = loadEntries([...sharedEntries, ...extraEntries]);

/** Longest shared law name that is the whole window or its tail. */
export function longestListedName(window: string): string | null {
  for (const hit of CATALOG_ALIASES) {
    if (Array.from(hit.alias).length < 2) {
      continue;
    }
    if (window === hit.alias || window.endsWith(hit.alias)) {
      return hit.alias;
    }
  }
  return null;
}

export function listedNameWins(window: string, deny: readonly string[]): boolean {
  const name = longestListedName(window);
  return name !== null && !deny.includes(name);
}
