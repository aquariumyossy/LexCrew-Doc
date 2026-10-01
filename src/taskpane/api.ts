import { ArgosScopes } from "../shared/argos";
import { CommittedFile, parseCommittedFiles } from "../shared/fileSource";
import {
  ConversationDetail,
  ConversationSummary,
  NewMessage,
  StoredMessage,
} from "../shared/history";
import { StreamAccumulator, StreamSnapshot, takeSseData } from "../shared/stream";
import { Completion } from "../shared/stripThinking";
import { ThinkingLevel } from "../shared/thinking";
import { ToolDefinition } from "../shared/tools";
import { ChatMessage, SearchHit } from "../sidecar/types";
import { ConnectionFields, ConnectionView } from "./connectionState";

/* global fetch, Response, RequestInit, AbortSignal */

export type HealthResponse = {
  sidecar?: { ok: boolean };
  llm?: {
    ok: boolean;
    models?: string[];
    error?: string;
    hint?: string;
  };
  searxng?: { ok: boolean; error?: string };
  argos?: { ok: boolean; error?: string };
  error?: string;
  hint?: string;
};

export type ChatResponse = Completion & {
  error?: string;
  hint?: string;
};

const STALE_SIDECAR =
  "LexCrew Doc のローカル側が古いままです。トレイ常駐または npm start を起動し直してください。";

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<!") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<HTML") ||
    trimmed.startsWith("<pre>")
  );
}

/** JSON 以外（Express の HTML 404 など）をチャットに生で出さない。 */
export function httpErrorMessage(text: string, status: number): string {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return `ローカル側が ${status} を返しました。`;
  }
  if (looksLikeHtml(trimmed) || /cannot\s+(get|post)\s+\/api\//i.test(trimmed)) {
    if (/\/api\/argos/i.test(trimmed)) {
      return STALE_SIDECAR;
    }
    return `ローカル側が ${status} を返しました。LexCrew Doc を起動し直してください。`;
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: string };
    if (parsed.error) {
      return parsed.error;
    }
  } catch {
    // not JSON
  }
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}…` : trimmed;
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(httpErrorMessage(text, res.status));
  }
}

export async function pingSidecar(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { method: "GET", signal });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchConnection(): Promise<ConnectionView> {
  const res = await fetch("/api/connection");
  const payload = await parseJson<ConnectionView & { error?: string }>(res);
  if (!res.ok) throw new Error(payload.error || `通信に失敗しました。${res.status}`);
  return payload;
}

export async function adoptStoredConnection(fields: ConnectionFields): Promise<ConnectionView> {
  const res = await fetch("/api/connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  const payload = await parseJson<ConnectionView & { error?: string }>(res);
  if (!res.ok) throw new Error(payload.error || `通信に失敗しました。${res.status}`);
  return payload;
}

export async function saveStoredConnection(fields: ConnectionFields): Promise<void> {
  const res = await fetch("/api/connection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  const payload = await parseJson<{ error?: string }>(res);
  if (!res.ok) throw new Error(payload.error || `通信に失敗しました。${res.status}`);
}

export async function checkHealth(
  body: {
    llmBaseUrl: string;
    llmApiKey: string;
    searxngUrl: string;
    argosBaseUrl: string;
    argosApiKey: string;
  },
  signal?: AbortSignal
): Promise<HealthResponse> {
  const res = await fetch("/api/health", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseJson<HealthResponse>(res);
  if (!res.ok && !data.llm) {
    throw new Error(data.error || `接続確認に失敗しました（${res.status}）。`);
  }
  return data;
}

export type ChatBody = {
  llmBaseUrl: string;
  llmApiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  thinkingLevel: ThinkingLevel;
  thinkingBudget: number;
  timeoutMs: number;
};

export async function chat(body: ChatBody, signal?: AbortSignal): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseJson<ChatResponse>(res);
  if (!res.ok) {
    const error = new Error(data.error || `生成に失敗しました（${res.status}）。`);
    (error as Error & { hint?: string }).hint = data.hint;
    throw error;
  }
  return data;
}

export async function chatStream(
  body: ChatBody,
  options: {
    signal?: AbortSignal;
    onDelta?: (snapshot: StreamSnapshot) => void;
  } = {}
): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: options.signal,
  });

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    const data = await parseJson<ChatResponse>(res);
    const error = new Error(data.error || `生成に失敗しました（${res.status}）。`);
    (error as Error & { hint?: string }).hint = data.hint;
    throw error;
  }

  if (!contentType.includes("event-stream")) {
    const data = await parseJson<ChatResponse>(res);
    options.onDelta?.({ content: data.content, reasoningContent: data.reasoningContent });
    return data;
  }

  if (!res.body) {
    throw new Error("ストリーム応答の本体が空です。");
  }

  const acc = new StreamAccumulator();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const taken = takeSseData(buffer);
      buffer = taken.rest;
      for (const event of taken.events) {
        if (event === "[DONE]") {
          continue;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(event);
        } catch {
          continue;
        }
        const snapshot = acc.ingest(payload);
        options.onDelta?.(snapshot);
      }
    }
    if (buffer.trim()) {
      const taken = takeSseData(`${buffer}\n`);
      for (const event of taken.events) {
        if (event === "[DONE]") {
          continue;
        }
        try {
          options.onDelta?.(acc.ingest(JSON.parse(event)));
        } catch {
          // ignore a trailing fragment
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  options.signal?.throwIfAborted();
  return acc.finish();
}

export type OcrBody = {
  llmBaseUrl: string;
  llmApiKey: string;
  model: string;
  /** A `data:image/...;base64,` URL for one page. */
  image: string;
  timeoutMs: number;
};

/** One page image at a time; the sidecar makes the vision call. */
export async function readImage(body: OcrBody, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    // `fetch` throws a bare "Failed to fetch" when it cannot reach anything,
    // and the thing it could not reach here is the local sidecar, not the LLM.
    throw new Error("LexCrew Doc のローカル側に繋がりませんでした。起動し直してください。");
  }
  const data = await parseJson<{ text?: string; error?: string; hint?: string }>(res);
  if (!res.ok) {
    const error = new Error(data.error || `画像の読み取りに失敗しました（${res.status}）。`);
    (error as Error & { hint?: string }).hint = data.hint;
    throw error;
  }
  return data.text || "";
}

export async function search(
  body: { searxngUrl: string; q: string },
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseJson<{ results?: SearchHit[]; error?: string }>(res);
  if (!res.ok) {
    throw new Error(data.error || `検索に失敗しました（${res.status}）。`);
  }
  return data.results || [];
}

export async function listArgosScopes(
  body: { argosBaseUrl: string; argosApiKey: string; query?: string },
  signal?: AbortSignal
): Promise<ArgosScopes> {
  const res = await fetch("/api/argos/scopes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      argosBaseUrl: body.argosBaseUrl,
      argosApiKey: body.argosApiKey,
      query: (body.query || "").trim(),
    }),
    signal,
  });
  const data = await parseJson<ArgosScopes & { error?: string; hint?: string }>(res);
  if (!res.ok) {
    const error = new Error(data.error || `Argos の範囲一覧に失敗しました（${res.status}）。`);
    (error as Error & { hint?: string }).hint = data.hint;
    throw error;
  }
  return {
    recent: Array.isArray(data.recent) ? data.recent : [],
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
  };
}

export async function searchArgosIndex(
  body: {
    argosBaseUrl: string;
    argosApiKey: string;
    q: string;
    pathPrefixes: string[];
  },
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const res = await fetch("/api/argos/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseJson<{ results?: SearchHit[]; error?: string; hint?: string }>(res);
  if (!res.ok) {
    const error = new Error(data.error || `Argos の検索に失敗しました（${res.status}）。`);
    (error as Error & { hint?: string }).hint = data.hint;
    throw error;
  }
  return data.results || [];
}

export async function setConversationArgosScope(
  id: string,
  pathPrefixes: string[]
): Promise<ConversationSummary> {
  return historyCall<ConversationSummary>(
    `/api/conversations/${encodeURIComponent(id)}/argos-scope`,
    {
      method: "PUT",
      body: JSON.stringify({ pathPrefixes }),
    }
  );
}

/**
 * The whole set, every time: adding what a turn attached and dropping what the
 * user took away are the same call, so a retry lands on the same state.
 */
export async function setConversationFiles(
  id: string,
  files: CommittedFile[]
): Promise<CommittedFile[]> {
  const data = await historyCall<{ files: CommittedFile[] }>(
    `/api/conversations/${encodeURIComponent(id)}/files`,
    { method: "PUT", body: JSON.stringify({ files }) }
  );
  return parseCommittedFiles(data.files);
}

async function historyCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const data = await parseJson<T & { error?: string }>(res);
  if (!res.ok) {
    throw new Error(data.error || `会話履歴の読み書きに失敗しました（${res.status}）。`);
  }
  return data;
}

export async function listConversations(documentKey?: string): Promise<ConversationSummary[]> {
  const query = documentKey ? `?documentKey=${encodeURIComponent(documentKey)}` : "";
  const data = await historyCall<{ conversations: ConversationSummary[] }>(
    `/api/conversations${query}`
  );
  return data.conversations || [];
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  const detail = await historyCall<ConversationDetail>(
    `/api/conversations/${encodeURIComponent(id)}`
  );
  // The Rust sidecar stores the file rows as given, so the shape is checked
  // here rather than trusted on the way out of the database.
  return { ...detail, files: parseCommittedFiles(detail.files) };
}

export async function createConversation(
  documentKey: string,
  documentPath = ""
): Promise<ConversationSummary> {
  return historyCall<ConversationSummary>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ documentKey, documentPath }),
  });
}

export async function rememberDocumentPath(
  documentKey: string,
  documentPath: string
): Promise<void> {
  await historyCall<{ ok: boolean }>("/api/conversations/document-path", {
    method: "PUT",
    body: JSON.stringify({ documentKey, documentPath }),
  });
}

export async function appendMessage(
  conversationId: string,
  message: NewMessage
): Promise<StoredMessage> {
  return historyCall<StoredMessage>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(message),
    }
  );
}

export async function deleteConversation(id: string): Promise<void> {
  await historyCall<{ ok: boolean }>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
