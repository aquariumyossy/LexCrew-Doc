import { MAX_ARGOS_SCOPES } from "./constants";

export type ArgosScopeRow = {
  path: string;
  label: string;
  isRoot: boolean;
};

export type ArgosScopes = {
  recent: ArgosScopeRow[];
  scopes: ArgosScopeRow[];
};

export function parseArgosScopes(pathPrefix: string | undefined | null): string[] {
  if (!pathPrefix) {
    return [];
  }
  return pathPrefix
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function joinArgosScopes(paths: string[]): string {
  return collapseArgosScopes(paths).join("\n");
}

function normalizePath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function argosPathStartsWith(path: string, prefix: string): boolean {
  const a = normalizePath(path);
  const b = normalizePath(prefix);
  if (!b) {
    return true;
  }
  if (a === b) {
    return true;
  }
  return a.startsWith(`${b}\\`);
}

export function sameArgosPath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** Drop children when a parent is already selected, then cap the count. */
export function collapseArgosScopes(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = raw.trim();
    if (!p) {
      continue;
    }
    if (out.some((kept) => argosPathStartsWith(p, kept))) {
      continue;
    }
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (argosPathStartsWith(out[i], p)) {
        out.splice(i, 1);
      }
    }
    out.push(p);
    if (out.length >= MAX_ARGOS_SCOPES) {
      break;
    }
  }
  return out;
}

export function argosScopeChipLabel(path: string, label?: string | null): string {
  if (label && label.trim()) {
    return label.trim();
  }
  if (path.startsWith("mailfolder:")) {
    const rest = path.slice("mailfolder:".length);
    const parts = rest
      .split(/[\\/]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length <= 1) {
      return rest.trim() || path;
    }
    return `${parts.slice(1).join("／")}（${parts[0]}）`;
  }
  const normalized = path.replace(/\//g, "\\").replace(/\\+$/, "");
  return normalized.split("\\").filter(Boolean).pop() || path;
}

export function argosButtonLabel(pathPrefix: string | undefined | null): string {
  const paths = parseArgosScopes(pathPrefix);
  if (paths.length === 0) {
    return "argos";
  }
  if (paths.length === 1) {
    return `argos: ${argosScopeChipLabel(paths[0])}`;
  }
  return `argos: ${argosScopeChipLabel(paths[0])} ほか${paths.length - 1}件`;
}

export function argosScopeSystemLine(pathPrefix: string | undefined | null): string | undefined {
  const scopes = parseArgosScopes(pathPrefix);
  if (!scopes.length) {
    return undefined;
  }
  const quoted = scopes.map((s) => `「${s}」`).join("、");
  return `インデックス検索は${quoted}配下に限定されています。ここに無いものは索引外として扱ってください。`;
}

function pathSegments(path: string): string[] {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").split("\\").filter(Boolean);
}

/** Nested folder line as in Argos: `親 / 子 / 孫`. Roots keep their label. */
export function argosFolderListLabel(row: ArgosScopeRow, roots: ArgosScopeRow[]): string {
  if (row.isRoot) {
    return (row.label || "").trim() || argosScopeChipLabel(row.path);
  }
  const parent = roots
    .filter(
      (root) =>
        root.isRoot &&
        argosPathStartsWith(row.path, root.path) &&
        !sameArgosPath(row.path, root.path)
    )
    .sort((a, b) => pathSegments(b.path).length - pathSegments(a.path).length)[0];
  if (!parent) {
    return (row.label || "").trim() || argosScopeChipLabel(row.path);
  }
  const rel = pathSegments(row.path).slice(pathSegments(parent.path).length);
  return rel.join(" / ") || row.label || argosScopeChipLabel(row.path);
}

export function matchesArgosFilter(row: ArgosScopeRow, query: string, listLabel?: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [row.label, row.path, listLabel || ""].some((value) =>
    value.toLowerCase().includes(needle)
  );
}
