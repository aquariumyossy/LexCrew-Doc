const FORBIDDEN = new Set([
  "body",
  "prompt",
  "content",
  "reasoning_content",
  "reasoningContent",
  "messages",
  "text",
  "q",
  "query",
  "replacement",
  "selection",
  "instruction",
  "apiKey",
  "llmApiKey",
  "argosApiKey",
  "authorization",
  "snippet",
  "previewText",
  "pathPrefixes",
  "path_prefix",
  "path_prefixes",
]);

function scrub(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!extra) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (FORBIDDEN.has(key)) {
      continue;
    }
    if (typeof value === "string" && value.length > 180) {
      out[key] = `${value.slice(0, 80)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Status-only logging. Never pass document body or prompts. */
export function logInfo(message: string, extra?: Record<string, unknown>): void {
  const safe = scrub(extra);
  if (safe) {
    console.info("[GURI]", message, safe);
  } else {
    console.info("[GURI]", message);
  }
}

export function logError(message: string, extra?: Record<string, unknown>): void {
  const safe = scrub(extra);
  if (safe) {
    console.error("[GURI]", message, safe);
  } else {
    console.error("[GURI]", message);
  }
}
