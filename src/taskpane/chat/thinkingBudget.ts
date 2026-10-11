import { fetchThinkingBudget } from "../api";

/** What MTPLX last showed: tokens, null when none is set, undefined until it says. */
let known: number | null | undefined;

export function knownThinkingBudget(): number | null | undefined {
  return known;
}

/** A new connection may be another server, so what the old one showed no longer holds. */
export function forgetThinkingBudget(): void {
  known = undefined;
}

export async function readThinkingBudget(
  connection: { llmBaseUrl: string; llmApiKey: string },
  requestId?: string
): Promise<number | null | undefined> {
  const seen = await fetchThinkingBudget({
    llmBaseUrl: connection.llmBaseUrl,
    llmApiKey: connection.llmApiKey,
    ...(requestId ? { requestId } : {}),
  });
  if (seen !== undefined) {
    known = seen;
  }
  return known;
}
