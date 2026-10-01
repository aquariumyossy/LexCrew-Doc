import { HAN_BMP_A, HAN_BMP_A0, HAN_BMP_B, HAN_BMP_B0, HAN_EXTRA } from "./japaneseHanData";
import {
  TOOL_INSERT_BLOCKS,
  TOOL_INSERT_COMMENT,
  TOOL_REPLACE_QUOTE,
  TOOL_REPLACE_SELECTION,
  ToolCall,
  ToolInvocation,
  parseToolArguments,
} from "./tools";

const SHOWN_LIMIT = 12;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

const bmpA = decodeBase64(HAN_BMP_A);
const bmpB = decodeBase64(HAN_BMP_B);
const extra = new Set(HAN_EXTRA);

function bitAt(table: Uint8Array, index: number): boolean {
  return (table[index >> 3] & (1 << (index & 7))) !== 0;
}

/** CJK unified / compatibility ideographs, including extensions. */
export function isCjkIdeograph(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0x2ceb0 && cp <= 0x2ebef) ||
    (cp >= 0x30000 && cp <= 0x3134f) ||
    (cp >= 0x31350 && cp <= 0x323af)
  );
}

export function isJapaneseHan(cp: number): boolean {
  if (cp >= HAN_BMP_A0 && cp < HAN_BMP_A0 + bmpA.length * 8) {
    return bitAt(bmpA, cp - HAN_BMP_A0);
  }
  if (cp >= HAN_BMP_B0 && cp < HAN_BMP_B0 + bmpB.length * 8) {
    return bitAt(bmpB, cp - HAN_BMP_B0);
  }
  return extra.has(cp);
}

/**
 * Writing systems that have no place in a Japanese legal document. A model that
 * drifts out of Japanese mid-sentence reaches for hangul or Cyrillic, and the
 * Kangxi radicals look like kanji but are not, so a quote holding one can never
 * be found again by Word's search.
 *
 * Latin and Greek stay allowed on purpose: URLs, ISO, DPA, α版 are legitimate.
 */
export function isForeignScript(cp: number): boolean {
  return (
    (cp >= 0x0400 && cp <= 0x052f) || // キリル文字
    (cp >= 0x0590 && cp <= 0x05ff) || // ヘブライ文字
    (cp >= 0x0600 && cp <= 0x06ff) || // アラビア文字
    (cp >= 0x0700 && cp <= 0x077f) || // シリア文字・アラビア文字補助
    (cp >= 0x0900 && cp <= 0x097f) || // デーヴァナーガリー
    (cp >= 0x0e00 && cp <= 0x0e7f) || // タイ文字
    (cp >= 0x1100 && cp <= 0x11ff) || // ハングル字母
    (cp >= 0x2e80 && cp <= 0x2fdf) || // CJK 部首補助・康熙部首
    (cp >= 0x3100 && cp <= 0x312f) || // 注音符号
    (cp >= 0x3130 && cp <= 0x318f) || // ハングル互換字母
    (cp >= 0xa960 && cp <= 0xa97f) || // ハングル字母拡張A
    (cp >= 0xac00 && cp <= 0xd7ff) || // ハングル音節・字母拡張B
    (cp >= 0xfb50 && cp <= 0xfdff) || // アラビア表示形A
    (cp >= 0xfe70 && cp <= 0xfefc) || // アラビア表示形B（BOM は除く）
    (cp >= 0xffa0 && cp <= 0xffdc) // 半角ハングル
  );
}

/** Distinct glyphs that do not belong in Japanese text, in first-seen order. */
export function foreignChars(...parts: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const part of parts) {
    if (!part) {
      continue;
    }
    for (const ch of part) {
      const cp = ch.codePointAt(0);
      if (cp === undefined || seen.has(ch)) {
        continue;
      }
      const foreign = isForeignScript(cp) || (isCjkIdeograph(cp) && !isJapaneseHan(cp));
      if (!foreign) {
        continue;
      }
      seen.add(ch);
      ordered.push(ch);
    }
  }
  return ordered;
}

function formatChars(chars: string[]): string {
  const shown = chars.slice(0, SHOWN_LIMIT);
  const more = chars.length > SHOWN_LIMIT ? ` ほか${chars.length - SHOWN_LIMIT}字` : "";
  return `${shown.join("、")}${more}`;
}

/** Chat-pane notice. Empty string / Japanese-only text returns null. */
export function foreignCharNotice(...parts: string[]): string | null {
  const chars = foreignChars(...parts);
  if (!chars.length) {
    return null;
  }
  return `日本語で用いない文字: ${formatChars(chars)}`;
}

/** Model-authored strings that will be written into the document or a comment. */
export function authoredToolTexts(call: ToolInvocation): string[] {
  switch (call.name) {
    case TOOL_REPLACE_SELECTION:
      return [call.args.text];
    case TOOL_REPLACE_QUOTE:
      return [call.args.text];
    case TOOL_INSERT_BLOCKS: {
      const parts: string[] = [];
      for (const block of call.args.blocks) {
        if (block.label) {
          parts.push(block.label);
        }
        parts.push(block.text);
      }
      return parts;
    }
    case TOOL_INSERT_COMMENT:
      return [call.args.comment];
    default:
      return [];
  }
}

/** Error body for `executeToolCall` (the caller prefixes エラー). */
export function foreignCharToolError(call: ToolInvocation): string | null {
  const chars = foreignChars(...authoredToolTexts(call));
  if (!chars.length) {
    return null;
  }
  return (
    `日本語で用いない文字が含まれています（${formatChars(chars)}）。` +
    "その部分を日本語（漢字の新字体・ひらがな・カタカナ）で書き直してください。"
  );
}

/** Visible assistant text plus model-authored tool arguments. */
export function foreignCharNoticeForAssistant(
  content: string,
  toolCalls: Pick<ToolCall, "function">[] = []
): string | null {
  const parts = [content];
  for (const call of toolCalls) {
    const parsed = parseToolArguments(call.function.name, call.function.arguments);
    if (parsed.ok) {
      parts.push(...authoredToolTexts(parsed.call));
    }
  }
  return foreignCharNotice(...parts);
}
