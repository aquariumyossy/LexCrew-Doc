import { DEFAULT_ARGOS_BASE_URL } from "../shared/constants";
import { ArgosScopeRow, ArgosScopes } from "../shared/argos";
import { SearchHit } from "./types";
import { logError, logInfo } from "./logger";

export type { ArgosScopeRow, ArgosScopes };

export class ArgosError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

function normalizeArgosBase(baseUrl: string): string {
  const trimmed = (baseUrl || "").trim() || DEFAULT_ARGOS_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ArgosError(
      "Argos の URL が不正です。",
      "例: http://127.0.0.1:17890（localhost ではなく 127.0.0.1）"
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ArgosError("Argos の URL は http または https にしてください。");
  }
  if (parsed.hostname === "localhost") {
    parsed.hostname = "127.0.0.1";
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "";
  return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
}

function argosHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = (apiKey || "").trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

const HINT =
  "Argos をこの PC で起動しているか、待受が http://127.0.0.1:17890 かを確認してください。";

async function argosFetch(
  baseUrl: string,
  apiKey: string | undefined,
  path: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> {
  const root = normalizeArgosBase(baseUrl);
  let res: Response;
  try {
    res = await fetch(`${root}${path}`, {
      ...init,
      headers: { ...argosHeaders(apiKey), ...(init.headers as Record<string, string> | undefined) },
      signal,
    });
  } catch (error) {
    logError("argos failed", { name: error instanceof Error ? error.name : "error" });
    throw new ArgosError("Argos に接続できませんでした。", HINT);
  }
  return res;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) {
      return parsed.error;
    }
  } catch {
    // not JSON
  }
  if (res.status === 401) {
    return "Argos が認証を要求しました。LAN 経由なら設定の API キーを入れてください。同一 PC なら 127.0.0.1 を使います。";
  }
  return text.slice(0, 180) || `Argos が ${res.status} を返しました。`;
}

export async function checkArgos(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await argosFetch(baseUrl, apiKey, "/health", { method: "GET" }, signal);
    if (!res.ok) {
      return { ok: false, error: await readError(res) };
    }
    const payload = (await res.json()) as { ok?: boolean; name?: string };
    if (payload.ok && payload.name === "argos") {
      return { ok: true };
    }
    return { ok: false, error: "Argos の応答が想定と違います。" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Argos の確認に失敗しました。",
    };
  }
}

export async function listArgosScopes(
  baseUrl: string,
  apiKey: string | undefined,
  query?: string,
  signal?: AbortSignal
): Promise<ArgosScopes> {
  logInfo("argos scopes", { status: "start" });
  const q = (query || "").trim();
  const path = q ? `/scopes?query=${encodeURIComponent(q)}` : "/scopes";
  const res = await argosFetch(baseUrl, apiKey, path, { method: "GET" }, signal);
  logInfo("argos scopes", { status: res.status });
  if (!res.ok) {
    throw new ArgosError(await readError(res), HINT);
  }
  const payload = (await res.json()) as { recent?: ArgosScopeRow[]; scopes?: ArgosScopeRow[] };
  return {
    recent: Array.isArray(payload.recent) ? payload.recent : [],
    scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
  };
}

type ArgosHit = {
  title?: string;
  path?: string;
  snippet?: string;
  previewText?: string;
};

export async function searchArgos(
  baseUrl: string,
  apiKey: string | undefined,
  query: string,
  pathPrefixes: string[],
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const q = (query || "").trim();
  if (!q) {
    throw new ArgosError("検索語を入力してください。");
  }
  logInfo("argos search", { status: "start" });
  const res = await argosFetch(
    baseUrl,
    apiKey,
    "/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: q,
        limit: 8,
        pathPrefixes: pathPrefixes.filter((p) => p.trim()),
      }),
    },
    signal
  );
  logInfo("argos search", { status: res.status });
  if (!res.ok) {
    throw new ArgosError(await readError(res), HINT);
  }
  const payload = (await res.json()) as { hits?: ArgosHit[] };
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  return hits
    .filter((row) => row && (row.title || row.path))
    .map((row) => ({
      title: row.title || "(無題)",
      url: row.path || "",
      content: row.snippet || row.previewText || "",
    }));
}
