/** A paragraph number reference in markup lists, e.g. `[段落 12]`. */
export const PARAGRAPH_REF = /^\[段落 (\d+)\]$/;

export function formatParagraphRef(number: number): string {
  return `[段落 ${number}]`;
}

export function parseParagraphRef(text: string): number | undefined {
  const match = (text || "").trim().match(PARAGRAPH_REF);
  if (!match) {
    return undefined;
  }
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** True when the location is already a paragraph reference from a newer build. */
export function isParagraphRef(text: string): boolean {
  return PARAGRAPH_REF.test((text || "").trim());
}
