/**
 * Paths the index search has already returned. A path the model invents is not
 * in the set, so it cannot be read.
 */
export function rememberIndexedPath(allowed: Set<string>, path: string): void {
  const trimmed = (path || "").trim();
  if (trimmed) {
    allowed.add(trimmed);
  }
}

export function indexedPathAllowed(path: string, allowed: ReadonlySet<string>): boolean {
  const trimmed = (path || "").trim();
  return Boolean(trimmed) && allowed.has(trimmed);
}

function continueNote(end: number): string {
  return `\n…（続きは offset を ${end} にしてください）`;
}

/** The part of an indexed file that fits in one tool result, and how to ask for the rest. */
export function sliceIndexedText(text: string, offset: number, limit: number): string {
  const start = Math.max(0, Math.floor(offset) || 0);
  if (start >= text.length || limit <= 0) {
    return "この offset より先はありません。";
  }
  const rest = text.slice(start);
  if (rest.length <= limit) {
    return rest;
  }
  let bodyLen = limit - continueNote(start + limit).length;
  if (bodyLen < 1) {
    return continueNote(start).trimStart();
  }
  let note = continueNote(start + bodyLen);
  while (bodyLen > 0 && bodyLen + note.length > limit) {
    bodyLen -= 1;
    note = continueNote(start + bodyLen);
  }
  return text.slice(start, start + bodyLen) + note;
}
