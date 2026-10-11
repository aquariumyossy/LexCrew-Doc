const NUMBER = /\d+(?:\.\d+)?/.source;
const KATAKANA_WORD = /[\u30A1-\u30FA\u30FC]{2,}/.source;
const LATIN_WORD = /[A-Za-z]{2,}/.source;
const FACT = new RegExp(`${NUMBER}|${KATAKANA_WORD}|${LATIN_WORD}`, "g");
const NUMBERS = new RegExp(NUMBER, "g");

const OUTLINE_HEAD = /^[\s\u3000]*(?:第[0-9０-９]+|[0-9０-９]+[．.、]|[（(][0-9０-９]+[）)])/;

function isFact(token: string): boolean {
  return !/^\d$/.test(token);
}

function tokensOf(lines: readonly string[], pattern: RegExp): string[] {
  return lines
    .flatMap((line) => line.replace(OUTLINE_HEAD, "").normalize("NFKC").match(pattern) || [])
    .filter(isFact);
}

function missingFrom(tokens: readonly string[], text: string): string[] {
  const withoutSpaces = text.normalize("NFKC").replace(/\s+/g, "");
  return [...new Set(tokens.filter((token) => !withoutSpaces.includes(token)))];
}

export function unsourcedFacts(written: readonly string[], source: string): string[] {
  return missingFrom(tokensOf(written, FACT), source);
}

export function droppedNumbers(source: string, written: readonly string[]): string[] {
  return missingFrom(tokensOf(source.split("\n"), NUMBERS), written.join("\n"));
}
