import { ToolCall, ToolDefinition } from "../shared/tools";
import { ThinkingLevel } from "../shared/thinking";

/** OpenAI chat message. Assistant turns may carry tool calls; tool turns answer them. */
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
};

export type HealthResult = {
  ok: boolean;
  models?: string[];
  error?: string;
  hint?: string;
};

export type SearchHit = {
  title: string;
  url: string;
  content: string;
};

export interface SearchProvider {
  readonly id: string;
  search(query: string, baseUrl: string, signal?: AbortSignal): Promise<SearchHit[]>;
}

export type ChatRequestBody = {
  llmBaseUrl?: string;
  llmApiKey?: string;
  model?: string;
  messages?: ChatMessage[];
  tools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
  thinkingBudget?: number;
  timeoutMs?: number;
  stream?: boolean;
};

/**
 * One page image to read. The LLM settings ride along because they live in the
 * task pane's storage; the sidecar holds none of them.
 */
export type OcrRequestBody = {
  llmBaseUrl?: string;
  llmApiKey?: string;
  model?: string;
  /** A `data:image/...;base64,` URL. */
  image?: string;
  timeoutMs?: number;
};

export type HealthRequestBody = {
  llmBaseUrl?: string;
  llmApiKey?: string;
  searxngUrl?: string;
  argosBaseUrl?: string;
  argosApiKey?: string;
};

export type SearchRequestBody = {
  searxngUrl?: string;
  q?: string;
};

export type ArgosSearchRequestBody = {
  argosBaseUrl?: string;
  argosApiKey?: string;
  q?: string;
  pathPrefixes?: string[];
};

export type ArgosScopesRequestBody = {
  argosBaseUrl?: string;
  argosApiKey?: string;
  query?: string;
};
