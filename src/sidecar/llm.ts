import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from "../shared/constants";
import { MAX_OCR_PAGE_CHARS, OCR_PROMPT } from "../shared/ocr";
import { Completion, parseCompletion } from "../shared/stripThinking";
import { ThinkingLevel, normalizeThinkingLevel, thinkingFields } from "../shared/thinking";
import { ToolDefinition } from "../shared/tools";
import { logError, logInfo } from "./logger";
import { ChatMessage, HealthResult } from "./types";

export function splitLlmBase(baseUrl: string): { origin: string; v1Base: string } {
  const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("MTPLX の Base URL を入力してください。");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("MTPLX の Base URL が不正です。例: http://192.168.1.10:8000/v1");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MTPLX の Base URL は http または https にしてください。");
  }
  const origin = trimmed.replace(/\/v1$/i, "");
  return { origin, v1Base: `${origin}/v1` };
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

function hintForStatus(status: number | undefined, network: boolean, timeout: boolean): string {
  if (timeout) {
    return `タイムアウトしました。モデル起動直後は時間がかかることがあります。設定の待ち時間（既定 ${DEFAULT_TIMEOUT_MS / 1000} 秒）を確認してください。`;
  }
  if (network) {
    return "Word PC から LLM PC のポートに届いているか（ファイアウォール）、MTPLX が 0.0.0.0 で待っているかを確認してください。";
  }
  if (status === 401 || status === 403) {
    return "APIキーが合っているか確認してください。LAN 公開の MTPLX はキー無しを拒否します。";
  }
  return "MTPLX の URL・モデル名・APIキーを確認してください。";
}

function isTimeout(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) ||
    (error instanceof Error && /timeout/i.test(error.message))
  );
}

function isNetwork(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|certificate|ECONNRESET/i.test(
    `${error.message}${error.cause ? String(error.cause) : ""}`
  );
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function excerptError(raw: string): string {
  if (!raw) {
    return "";
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") {
      return parsed.error.slice(0, 300);
    }
    if (parsed.error && typeof parsed.error.message === "string") {
      return parsed.error.message.slice(0, 300);
    }
    if (typeof parsed.message === "string") {
      return parsed.message.slice(0, 300);
    }
  } catch {
    // ignore parse — return a short slice only
  }
  return raw.replace(/\s+/g, " ").slice(0, 180);
}

function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown; models?: unknown }).data;
  if (Array.isArray(data)) {
    return data
      .map((item) => (typeof item === "string" ? item : (item as { id?: string })?.id))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  const models = (payload as { models?: unknown }).models;
  if (Array.isArray(models)) {
    return models
      .map((item) => (typeof item === "string" ? item : (item as { id?: string })?.id))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return [];
}

function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[._]/g, "-");
}

export function pickDefaultModel(ids: string[], preferred = DEFAULT_MODEL): string {
  const exact = ids.find((id) => id === preferred);
  if (exact) {
    return exact;
  }
  const normalized = normalizeModelId(preferred);
  const fuzzy = ids.find((id) => {
    const candidate = normalizeModelId(id);
    return candidate.includes(normalized) || normalized.includes(candidate);
  });
  return fuzzy || preferred;
}

export async function checkLlmHealth(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<HealthResult> {
  if (!(apiKey || "").trim()) {
    return {
      ok: false,
      error: "APIキーが空です。",
      hint: "APIキーが合っているか確認してください。LAN 公開の MTPLX はキー無しを拒否します。",
    };
  }

  let origin: string;
  let v1Base: string;
  try {
    ({ origin, v1Base } = splitLlmBase(baseUrl));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "URL が不正です。" };
  }

  const headers = authHeaders(apiKey.trim());
  let modelsAuthFailed: HealthResult | undefined;

  try {
    logInfo("llm health models", { status: "start" });
    const modelsRes = await fetch(`${v1Base}/models`, { method: "GET", headers, signal });
    logInfo("llm health models", { status: modelsRes.status });
    if (modelsRes.ok) {
      const payload = (await modelsRes.json()) as unknown;
      const models = parseModelIds(payload);
      return { ok: true, models };
    }

    if (modelsRes.status === 401 || modelsRes.status === 403) {
      const detail = excerptError(await readBody(modelsRes));
      modelsAuthFailed = {
        ok: false,
        error: detail || `モデル一覧が ${modelsRes.status} でした。`,
        hint: hintForStatus(modelsRes.status, false, false),
      };
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logError("llm health models failed", { name: error instanceof Error ? error.name : "error" });
  }

  try {
    logInfo("llm health fallback", { status: "start" });
    const healthRes = await fetch(`${origin}/health`, { method: "GET", headers, signal });
    logInfo("llm health fallback", { status: healthRes.status });
    if (healthRes.ok) {
      return { ok: true, models: [] };
    }
    if (modelsAuthFailed) {
      return modelsAuthFailed;
    }
    const detail = excerptError(await readBody(healthRes));
    return {
      ok: false,
      error: detail || `GET /health が ${healthRes.status} でした。`,
      hint: hintForStatus(healthRes.status, false, false),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logError("llm health fallback failed", { name: error instanceof Error ? error.name : "error" });
    if (modelsAuthFailed) {
      return modelsAuthFailed;
    }
    return {
      ok: false,
      error: "GET /v1/models も GET /health も失敗しました。",
      hint: hintForStatus(undefined, isNetwork(error) || true, isTimeout(error)),
    };
  }
}

/**
 * A page image for the OCR route. Chat messages stay plain strings; only this
 * one call sends the OpenAI content-parts shape.
 */
export type VisionMessage = {
  role: "user";
  content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
};

export type ChatCallOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: (ChatMessage | VisionMessage)[];
  tools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
  thinkingBudget?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  stream?: boolean;
};

function buildPayload(options: ChatCallOptions, withThinking: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: options.model || DEFAULT_MODEL,
    messages: options.messages,
  };
  if (options.tools?.length) {
    payload.tools = options.tools;
    payload.tool_choice = "auto";
  }
  if (options.stream) {
    payload.stream = true;
  }
  if (withThinking) {
    Object.assign(
      payload,
      thinkingFields(normalizeThinkingLevel(options.thinkingLevel), options.thinkingBudget ?? 0)
    );
  }
  return payload;
}

async function postChat(
  options: ChatCallOptions,
  payload: Record<string, unknown>
): Promise<Response> {
  const { v1Base } = splitLlmBase(options.baseUrl);
  const timeoutMs =
    options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) {
    signals.push(options.signal);
  }
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  return fetch(`${v1Base}/chat/completions`, {
    method: "POST",
    headers: {
      ...authHeaders(options.apiKey.trim()),
      "Content-Type": "application/json",
      Accept: options.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
}

function throwIfEmptyKey(options: ChatCallOptions): void {
  if (!(options.apiKey || "").trim()) {
    throw Object.assign(new Error("APIキーが空です。"), {
      hint: "APIキーが合っているか確認してください。",
    });
  }
  if (!options.messages?.length) {
    throw new Error("messages が空です。");
  }
}

async function postWithThinkingFallback(options: ChatCallOptions): Promise<Response> {
  throwIfEmptyKey(options);
  let res: Response;
  try {
    logInfo("llm chat", { status: "start" });
    res = await postChat(options, buildPayload(options, true));
    if (res.status === 400) {
      // Servers without the Qwen thinking controls reject the extra fields.
      logInfo("llm chat retry without thinking fields", { status: 400 });
      res = await postChat(options, buildPayload(options, false));
    }
    logInfo("llm chat", { status: res.status });
  } catch (error) {
    logError("llm chat failed", { name: error instanceof Error ? error.name : "error" });
    const timeout = isTimeout(error);
    const err = new Error(
      timeout ? "MTPLX が時間内に応答しませんでした。" : "MTPLX に接続できませんでした。"
    );
    (err as Error & { hint?: string }).hint = hintForStatus(undefined, !timeout, timeout);
    throw err;
  }

  if (!res.ok) {
    const detail = excerptError(await readBody(res));
    const err = new Error(detail || `MTPLX が ${res.status} を返しました。`);
    (err as Error & { hint?: string }).hint = hintForStatus(res.status, false, false);
    throw err;
  }
  return res;
}

export async function chatCompletions(options: ChatCallOptions): Promise<Completion> {
  const res = await postWithThinkingFallback({ ...options, stream: false });
  return parseCompletion((await res.json()) as unknown);
}

/**
 * Reads the text off one page image. Thinking is off: transcription is not a
 * reasoning task, and a long deliberation per page makes a 20-page scan crawl.
 */
export async function readImageText(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** A `data:image/...;base64,` URL. */
  image: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const message: VisionMessage = {
    role: "user",
    content: [
      { type: "text", text: OCR_PROMPT },
      { type: "image_url", image_url: { url: options.image } },
    ],
  };
  const completion = await chatCompletions({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    messages: [message],
    thinkingLevel: "off",
    thinkingBudget: 0,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  return completion.content.slice(0, MAX_OCR_PAGE_CHARS);
}

export type StreamSink = {
  status: (code: number) => unknown;
  setHeader: (name: string, value: string) => unknown;
  write: (chunk: string | Uint8Array) => unknown;
  end: () => unknown;
  flushHeaders?: () => unknown;
};

/** Forward MTPLX's SSE (or wrap a JSON reply as one SSE event) onto the sidecar response. */
export async function pipeChatStream(options: ChatCallOptions, sink: StreamSink): Promise<void> {
  const upstream = await postWithThinkingFallback({ ...options, stream: true });
  sink.status(200);
  sink.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  sink.setHeader("Cache-Control", "no-cache");
  sink.setHeader("Connection", "keep-alive");
  sink.setHeader("X-Accel-Buffering", "no");
  sink.flushHeaders?.();

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  if ((!contentType.includes("json") || contentType.includes("event-stream")) && upstream.body) {
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        sink.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    sink.end();
    return;
  }

  const payload = (await upstream.json()) as unknown;
  sink.write(`data: ${JSON.stringify(payload)}\n\n`);
  sink.write("data: [DONE]\n\n");
  sink.end();
}
