const NUMBER = /\d+(?:\.\d+)?/.source;
const KATAKANA_WORD = /[\u30A1-\u30FA\u30FC]{2,}/.source;
const LATIN_WORD = /[A-Za-z]{2,}/.source;
const FACT = new RegExp(`${NUMBER}|${KATAKANA_WORD}|${LATIN_WORD}`, "g");

const OUTLINE_HEAD = /^[\s\u3000]*(?:第[0-9０-９]+|[0-9０-９]+[．.、]|[（(][0-9０-９]+[）)])/;

function isFact(token: string): boolean {
  return !/^\d$/.test(token);
}

export function unsourcedFacts(written: readonly string[], source: string): string[] {
  const sourceWithoutSpaces = source.normalize("NFKC").replace(/\s+/g, "");
  const missing = new Set<string>();
  for (const line of written) {
    const spacedBody = line.replace(OUTLINE_HEAD, "").normalize("NFKC");
    for (const token of spacedBody.match(FACT) || []) {
      if (isFact(token) && !sourceWithoutSpaces.includes(token)) {
        missing.add(token);
      }
    }
  }
  return [...missing];
}
