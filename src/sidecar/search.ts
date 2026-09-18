import { logError, logInfo } from "./logger";
import { SearchHit, SearchProvider } from "./types";

function normalizeBase(baseUrl: string): string {
  const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("SearXNG の URL を入力してください。");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("SearXNG の URL が不正です。例: http://127.0.0.1:8080");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SearXNG の URL は http または https にしてください。");
  }
  return trimmed.replace(/\/search$/i, "");
}

function searchUrl(baseUrl: string, query: string): string {
  const root = normalizeBase(baseUrl);
  const url = new URL(`${root}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "ja");
  return url.toString();
}

export class SearxngProvider implements SearchProvider {
  readonly id = "searxng";

  async search(query: string, baseUrl: string, signal?: AbortSignal): Promise<SearchHit[]> {
    const q = (query || "").trim();
    if (!q) {
      throw new Error("検索語を入力してください。");
    }

    const url = searchUrl(baseUrl, q);
    logInfo("searxng search", { status: "start" });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      });
    } catch (error) {
      logError("searxng search failed", { name: error instanceof Error ? error.name : "error" });
      throw new Error(
        "SearXNG に接続できませんでした。URL と、Word PC からそのホストへ届くか（ファイアウォール）を確認してください。"
      );
    }

    logInfo("searxng search", { status: res.status });

    if (res.status === 403) {
      throw new Error(
        "SearXNG が JSON 形式を拒否しました（403）。settings.yml の search.formats に json を追加してインスタンスを再起動してください。"
      );
    }
    if (!res.ok) {
      throw new Error(`SearXNG が ${res.status} を返しました。`);
    }

    const payload = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const results = Array.isArray(payload.results) ? payload.results : [];
    return results
      .filter((row) => row && (row.title || row.url))
      .map((row) => ({
        title: row.title || "(無題)",
        url: row.url || "",
        content: row.content || "",
      }));
  }
}

/** Provider seam. MVP implements SearXNG only; Argos is not wired. */
export function getSearchProvider(): SearchProvider {
  return new SearxngProvider();
}

export async function checkSearxng(
  baseUrl: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  if (!(baseUrl || "").trim()) {
    return { ok: false, error: "SearXNG の URL が空です。" };
  }
  try {
    await getSearchProvider().search("ping", baseUrl, signal);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "SearXNG の確認に失敗しました。",
    };
  }
}
