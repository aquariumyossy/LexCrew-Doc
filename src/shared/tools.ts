import { BLOCK_TYPES, DraftBlock, Severity, normalizeBlock } from "./blocks";

export const TOOL_SEARCH = "search";
export const TOOL_SEARCH_INDEX = "search_index";
export const TOOL_GET_SELECTION = "get_selection";
export const TOOL_REPLACE_SELECTION = "replace_selection";
export const TOOL_REPLACE_QUOTE = "replace_quote";
export const TOOL_INSERT_BLOCKS = "insert_blocks";
export const TOOL_INSERT_COMMENT = "insert_comment";
export const TOOL_INSERT_CITATION = "insert_citation";
export const TOOL_FORMAT_TEXT = "format_text";
export const TOOL_FORMAT_PARAGRAPH = "format_paragraph";

/** Default rounds of tool calls before the task pane stops and tells the user. */
export const MAX_TOOL_ROUNDS = 8;
/** 0 means keep calling tools until the model answers or the user cancels. */
export const UNLIMITED_TOOL_ROUNDS = 0;
export const MAX_MAX_TOOL_ROUNDS = 256;
export const TOOL_ROUND_PRESETS = [8, 16, 32, UNLIMITED_TOOL_ROUNDS] as const;

export function normalizeMaxToolRounds(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return MAX_TOOL_ROUNDS;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return MAX_TOOL_ROUNDS;
  }
  const rounded = Math.round(n);
  if (rounded === UNLIMITED_TOOL_ROUNDS) {
    return UNLIMITED_TOOL_ROUNDS;
  }
  return Math.min(MAX_MAX_TOOL_ROUNDS, Math.max(1, rounded));
}

export function toolRoundPresetLabel(rounds: number): string {
  if (rounds === UNLIMITED_TOOL_ROUNDS) {
    return "制限なし";
  }
  if (rounds === MAX_TOOL_ROUNDS) {
    return `${rounds}（既定）`;
  }
  return String(rounds);
}

/** Shown in chat when the turn hits the configured tool-round cap. */
export function toolRoundLimitNotice(maxRounds: number): string {
  return (
    `ツール往復が上限の ${maxRounds} 回に達したため、残りの操作はしていません。` +
    "続きはもう一度指示するか、設定の「ツール往復の上限」を上げてください。"
  );
}

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ParagraphAlignmentArg = "left" | "center" | "right" | "justify";

export type SearchArgs = { q: string };
export type SearchIndexArgs = { q: string };
export type GetSelectionArgs = Record<string, never>;
export type ReplaceSelectionArgs = { text: string };
export type ReplaceQuoteArgs = { quote: string; text: string };
export type InsertAtArg = "cursor" | "continue" | "end";
export type InsertBlocksArgs = { blocks: DraftBlock[]; at?: InsertAtArg; quote?: string };
export type InsertCommentArgs = { comment: string; quote: string; severity: Severity };
export type InsertCitationArgs = {
  title: string;
  url: string;
  snippet: string;
  as: "comment" | "text";
};
export type FormatTextArgs = {
  quote: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  fontName?: string;
  color?: string;
  highlightColor?: string;
};
export type FormatParagraphArgs = {
  quote: string;
  alignment?: ParagraphAlignmentArg;
  firstLineIndent?: number;
  leftIndent?: number;
  spaceAfter?: number;
  lineSpacing?: number;
};

export type ToolInvocation =
  | { name: typeof TOOL_SEARCH; args: SearchArgs }
  | { name: typeof TOOL_SEARCH_INDEX; args: SearchIndexArgs }
  | { name: typeof TOOL_GET_SELECTION; args: GetSelectionArgs }
  | { name: typeof TOOL_REPLACE_SELECTION; args: ReplaceSelectionArgs }
  | { name: typeof TOOL_REPLACE_QUOTE; args: ReplaceQuoteArgs }
  | { name: typeof TOOL_INSERT_BLOCKS; args: InsertBlocksArgs }
  | { name: typeof TOOL_INSERT_COMMENT; args: InsertCommentArgs }
  | { name: typeof TOOL_INSERT_CITATION; args: InsertCitationArgs }
  | { name: typeof TOOL_FORMAT_TEXT; args: FormatTextArgs }
  | { name: typeof TOOL_FORMAT_PARAGRAPH; args: FormatParagraphArgs };

export type ParsedTool = { ok: true; call: ToolInvocation } | { ok: false; error: string };

const QUOTE_HINT = "対象にする本文の短い引用。省略すると選択範囲全体が対象。";
const QUOTE_HINT_REQUIRED = "対象にする本文の短い引用。文書内で 1 か所だけに当たる引用にする。";

function stringParam(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function searchTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_SEARCH,
      description:
        "SearXNG で公開ウェブを検索する。条文・判例・用語を確かめたいときに使う。" +
        "検索語は単語を空白区切りで並べる（例:『民法 第415条 損害賠償』）。" +
        "結果は候補であり、本文に入れるのは insert_citation を呼んだときだけ。",
      parameters: {
        type: "object",
        properties: { q: stringParam("検索語") },
        required: ["q"],
      },
    },
  };
}

function searchIndexTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_SEARCH_INDEX,
      description:
        "この PC の Argos 索引（Tantivy）を検索する。契約書・準備書面・メールなどローカル資料を探すときに使う。" +
        "検索語は単語を空白区切りで並べる。範囲は利用者がボタンで指定済みなので path_prefix は渡さない。" +
        "結果の url はファイルパスである。文書に入れるのは insert_citation を呼んだときだけ。",
      parameters: {
        type: "object",
        properties: { q: stringParam("検索語") },
        required: ["q"],
      },
    },
  };
}

function getSelectionTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_GET_SELECTION,
      description:
        "Word のいまの選択範囲を読む。選択は指示と一緒に渡されるので通常は不要。" +
        "書き換えたあとの状態を確かめたいときだけ使う。",
      parameters: { type: "object", properties: {} },
    },
  };
}

function replaceSelectionTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_REPLACE_SELECTION,
      description:
        "選択範囲をプレーンテキストで置き換える。修正履歴に残る。" +
        "太字や表は消えるので、書式を残したいときは format_text / format_paragraph を使う。",
      parameters: {
        type: "object",
        properties: { text: stringParam("置換後の本文") },
        required: ["text"],
      },
    },
  };
}

function replaceQuoteTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_REPLACE_QUOTE,
      description:
        "本文の特定の文字列だけを置き換える。修正履歴に残る。書き換えの基本はこのツール。" +
        "選択があればその中を先に探し、無ければ本文全体から探す。",
      parameters: {
        type: "object",
        properties: {
          quote: stringParam(
            "置き換える本文の引用。添付された本文どおりに書き、文書内で 1 か所だけに当たる長さにする。"
          ),
          text: stringParam("置換後の本文"),
        },
        required: ["quote", "text"],
      },
    },
  };
}

function insertBlocksTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_INSERT_BLOCKS,
      description:
        "構造付きの段落を挿入する。修正履歴に残る。" +
        "決まった場所の後ろに入れるときは quote を使う。quote には入れたい位置の直前の段落から取った引用を入れる。" +
        "「第13条の次に」なら第13条の最後の項を引用する。quote があるときは at を見ない。" +
        "at は挿入位置。cursor（既定）はいまのカーソルの直後、continue は直前に挿入した段落の続き、end は文書の末尾。" +
        "長い原稿を分割するときは 2 回目以降を continue にし、条の若い順に続きだけを足す。" +
        "前のやりとりの続きを書くときも continue を指定する。cursor へ繰り返し入れると順序が逆になる。" +
        "使い分け: title は文書タイトル（中央・太字）、heading は「請求の趣旨」などの見出し、" +
        "body は本文（先頭字下げはアドインが付けるので全角空白を足さない）、clause は条（label に「第○条」）、" +
        "item は項・号、center は日付など、right は当事者名など。表・罫線・余白は出さない。",
      parameters: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            description: "挿入する段落の並び（文書上の出現順）",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: BLOCK_TYPES, description: "段落の種類" },
                text: stringParam("段落の本文"),
                label: stringParam("clause のときの「第○条」など（任意）"),
              },
              required: ["type", "text"],
            },
          },
          quote: {
            type: "string",
            description:
              "入れたい位置の直前の段落からの引用。その段落の後ろに入る。1 段落に収まり、文書内で 1 か所だけに当たる引用にする。",
          },
          at: {
            type: "string",
            enum: ["cursor", "continue", "end"],
            description:
              "cursor はカーソル直後、continue は直前の挿入の続き、end は文書末尾。分割した続きは continue。quote があるときは見ない。",
          },
        },
        required: ["blocks"],
      },
    },
  };
}

function insertCommentTool(selection: boolean): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_INSERT_COMMENT,
      description:
        "Word のコメントを付ける。本文は変えない。点検の指摘や申し送りに使う。" +
        "1 か所ずつ呼び、指摘が複数あれば複数回呼ぶ。",
      parameters: {
        type: "object",
        properties: {
          comment: stringParam("コメント本文。判例・条文番号を書くときは未確認と明記する。"),
          quote: stringParam(selection ? QUOTE_HINT : QUOTE_HINT_REQUIRED),
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "重要度。既定は medium。",
          },
        },
        required: selection ? ["comment"] : ["comment", "quote"],
      },
    },
  };
}

function insertCitationTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_INSERT_CITATION,
      description:
        "search または search_index で得たヒットを出典として文書に入れる。" +
        "タイトルと url（ウェブ URL または Argos のファイルパス）は検索結果のものをそのまま使い、捏造しない。",
      parameters: {
        type: "object",
        properties: {
          title: stringParam("検索結果のタイトル"),
          url: stringParam("検索結果の URL または Argos のファイルパス"),
          snippet: stringParam("抜粋（任意）"),
          as: {
            type: "string",
            enum: ["comment", "text"],
            description: "comment ならコメント、text なら本文に段落として入れる。既定は comment。",
          },
        },
        required: ["title", "url"],
      },
    },
  };
}

function formatTextTool(selection: boolean): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_FORMAT_TEXT,
      description:
        "文字書式を変える。本文は変えない。修正履歴に書式変更として残る。" +
        "指定しなかった項目は元のまま。",
      parameters: {
        type: "object",
        ...(selection ? {} : { required: ["quote"] }),
        properties: {
          quote: stringParam(selection ? QUOTE_HINT : QUOTE_HINT_REQUIRED),
          bold: { type: "boolean", description: "太字" },
          italic: { type: "boolean", description: "斜体" },
          underline: { type: "boolean", description: "下線" },
          size: { type: "number", description: "文字の大きさ（pt）" },
          fontName: stringParam("フォント名（例: 游明朝）"),
          color: stringParam("文字色。#RRGGBB。"),
          highlightColor: stringParam("蛍光ペン。#RRGGBB。解除は空文字。"),
        },
      },
    },
  };
}

function formatParagraphTool(selection: boolean): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_FORMAT_PARAGRAPH,
      description:
        "段落書式を変える。本文は変えない。修正履歴に書式変更として残る。" +
        "指定しなかった項目は元のまま。余白・罫線は変えられない。",
      parameters: {
        type: "object",
        ...(selection ? {} : { required: ["quote"] }),
        properties: {
          quote: stringParam(selection ? QUOTE_HINT : QUOTE_HINT_REQUIRED),
          alignment: {
            type: "string",
            enum: ["left", "center", "right", "justify"],
            description: "揃え",
          },
          firstLineIndent: { type: "number", description: "1 行目の字下げ（pt）" },
          leftIndent: { type: "number", description: "左インデント（pt）" },
          spaceAfter: { type: "number", description: "段落後の間隔（pt）" },
          lineSpacing: { type: "number", description: "行間（pt）" },
        },
      },
    },
  };
}

export type ToolSetOptions = {
  /** SearXNG の URL が未設定ならウェブ検索ツールを出さない。 */
  search?: boolean;
  /** Argos の URL が未設定なら索引検索ツールを出さない。 */
  argos?: boolean;
  /** 選択が無いターンでは、選択を対象にするツールを出さない。 */
  selection?: boolean;
};

/**
 * Tools sent with every chat request. What the document offers decides the list:
 * a tool that would edit an empty selection is left out rather than allowed to
 * fail, and `quote` becomes required where the selection used to stand in.
 */
export function buildTools(options: ToolSetOptions = {}): ToolDefinition[] {
  const selection = Boolean(options.selection);
  const tools: ToolDefinition[] = [];
  if (options.search) {
    tools.push(searchTool());
  }
  if (options.argos) {
    tools.push(searchIndexTool());
  }
  if (options.search || options.argos) {
    tools.push(insertCitationTool());
  }
  if (selection) {
    tools.push(getSelectionTool());
    tools.push(replaceSelectionTool());
  }
  tools.push(replaceQuoteTool());
  tools.push(insertBlocksTool());
  tools.push(insertCommentTool(selection));
  tools.push(formatTextTool(selection));
  tools.push(formatParagraphTool(selection));
  return tools;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function bool(row: Record<string, unknown>, key: string): boolean | undefined {
  const value = row[key];
  return typeof value === "boolean" ? value : undefined;
}

function num(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function severityOf(row: Record<string, unknown>): Severity {
  const value = row.severity;
  return value === "high" || value === "low" || value === "medium" ? value : "medium";
}

function alignmentOf(row: Record<string, unknown>): ParagraphAlignmentArg | undefined {
  const value = row.alignment;
  if (value === "left" || value === "center" || value === "right" || value === "justify") {
    return value;
  }
  return undefined;
}

function insertAtOf(row: Record<string, unknown>): InsertAtArg | { error: string } | undefined {
  if (row.at === undefined) {
    return undefined;
  }
  if (row.at === "cursor" || row.at === "continue" || row.at === "end") {
    return row.at;
  }
  return { error: 'at は "cursor"、"continue"、"end" のどれかにしてください。' };
}

export function parseToolArguments(name: string, rawArguments: string): ParsedTool {
  const raw = (rawArguments || "").trim();
  let parsed: unknown = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "引数が JSON として読めませんでした。JSON オブジェクトで渡し直してください。",
      };
    }
  }
  const row = asRecord(parsed);
  if (!row) {
    return { ok: false, error: "引数は JSON オブジェクトにしてください。" };
  }

  switch (name) {
    case TOOL_SEARCH: {
      const q = text(row, "q").trim();
      if (!q) {
        return { ok: false, error: "q が空です。検索語を入れてください。" };
      }
      return { ok: true, call: { name: TOOL_SEARCH, args: { q } } };
    }
    case TOOL_SEARCH_INDEX: {
      const q = text(row, "q").trim();
      if (!q) {
        return { ok: false, error: "q が空です。検索語を入れてください。" };
      }
      return { ok: true, call: { name: TOOL_SEARCH_INDEX, args: { q } } };
    }
    case TOOL_GET_SELECTION:
      return { ok: true, call: { name: TOOL_GET_SELECTION, args: {} } };
    case TOOL_REPLACE_SELECTION: {
      const value = text(row, "text");
      if (!value.trim()) {
        return { ok: false, error: "text が空です。置換後の本文を入れてください。" };
      }
      return { ok: true, call: { name: TOOL_REPLACE_SELECTION, args: { text: value } } };
    }
    case TOOL_REPLACE_QUOTE: {
      const quote = text(row, "quote").trim();
      const value = text(row, "text");
      if (!quote) {
        return { ok: false, error: "quote が空です。置き換える本文の引用を入れてください。" };
      }
      if (!value.trim()) {
        return { ok: false, error: "text が空です。置換後の本文を入れてください。" };
      }
      return { ok: true, call: { name: TOOL_REPLACE_QUOTE, args: { quote, text: value } } };
    }
    case TOOL_INSERT_BLOCKS: {
      const rawBlocks = row.blocks;
      if (!Array.isArray(rawBlocks)) {
        return { ok: false, error: "blocks が配列ではありません。" };
      }
      const at = insertAtOf(row);
      if (typeof at === "object") {
        return { ok: false, error: at.error };
      }
      const quote = text(row, "quote").trim();
      const blocks: DraftBlock[] = [];
      for (const item of rawBlocks) {
        const record = asRecord(item);
        if (!record) {
          continue;
        }
        const block = normalizeBlock(record);
        if (block) {
          blocks.push(block);
        }
      }
      if (!blocks.length) {
        return {
          ok: false,
          error: "blocks に有効な段落がありません。type と text を入れてください。",
        };
      }
      return {
        ok: true,
        call: {
          name: TOOL_INSERT_BLOCKS,
          args: { blocks, ...(at ? { at } : {}), ...(quote ? { quote } : {}) },
        },
      };
    }
    case TOOL_INSERT_COMMENT: {
      const comment = text(row, "comment");
      if (!comment.trim()) {
        return { ok: false, error: "comment が空です。" };
      }
      return {
        ok: true,
        call: {
          name: TOOL_INSERT_COMMENT,
          args: { comment, quote: text(row, "quote"), severity: severityOf(row) },
        },
      };
    }
    case TOOL_INSERT_CITATION: {
      const title = text(row, "title").trim();
      const url = text(row, "url").trim();
      if (!title || !url) {
        return {
          ok: false,
          error: "title と url が必要です。search の結果をそのまま渡してください。",
        };
      }
      return {
        ok: true,
        call: {
          name: TOOL_INSERT_CITATION,
          args: {
            title,
            url,
            snippet: text(row, "snippet"),
            as: row.as === "text" ? "text" : "comment",
          },
        },
      };
    }
    case TOOL_FORMAT_TEXT: {
      const args: FormatTextArgs = {
        quote: text(row, "quote"),
        bold: bool(row, "bold"),
        italic: bool(row, "italic"),
        underline: bool(row, "underline"),
        size: num(row, "size"),
        fontName: optionalString(row, "fontName"),
        color: optionalString(row, "color"),
        highlightColor: optionalString(row, "highlightColor"),
      };
      if (
        args.bold === undefined &&
        args.italic === undefined &&
        args.underline === undefined &&
        args.size === undefined &&
        args.fontName === undefined &&
        args.color === undefined &&
        args.highlightColor === undefined
      ) {
        return { ok: false, error: "変更する書式が指定されていません。" };
      }
      if (args.size !== undefined && args.size <= 0) {
        return { ok: false, error: "size は正の数にしてください。" };
      }
      return { ok: true, call: { name: TOOL_FORMAT_TEXT, args } };
    }
    case TOOL_FORMAT_PARAGRAPH: {
      const args: FormatParagraphArgs = {
        quote: text(row, "quote"),
        alignment: alignmentOf(row),
        firstLineIndent: num(row, "firstLineIndent"),
        leftIndent: num(row, "leftIndent"),
        spaceAfter: num(row, "spaceAfter"),
        lineSpacing: num(row, "lineSpacing"),
      };
      if (
        args.alignment === undefined &&
        args.firstLineIndent === undefined &&
        args.leftIndent === undefined &&
        args.spaceAfter === undefined &&
        args.lineSpacing === undefined
      ) {
        return { ok: false, error: "変更する書式が指定されていません。" };
      }
      return { ok: true, call: { name: TOOL_FORMAT_PARAGRAPH, args } };
    }
    default:
      return { ok: false, error: `${name} というツールはありません。` };
  }
}

/**
 * Servers that do not implement function calling reject the request outright.
 * Detected so the turn can be retried once as a plain chat.
 */
export function isToolsUnsupportedError(message: string): boolean {
  const text = (message || "").toLowerCase();
  if (!text.includes("tool") && !text.includes("function")) {
    return false;
  }
  return /not supported|unsupported|unknown|unrecognized|invalid|does not support/.test(text);
}

function shorten(text: string, chars: number): string {
  const trimmed = (text || "").replace(/\s+/g, " ").trim();
  return trimmed.length > chars ? `${trimmed.slice(0, chars)}…` : trimmed;
}

function textFormatParts(args: FormatTextArgs): string[] {
  const parts: string[] = [];
  if (args.bold !== undefined) {
    parts.push(args.bold ? "太字" : "太字を解除");
  }
  if (args.italic !== undefined) {
    parts.push(args.italic ? "斜体" : "斜体を解除");
  }
  if (args.underline !== undefined) {
    parts.push(args.underline ? "下線" : "下線を解除");
  }
  if (args.size !== undefined) {
    parts.push(`${args.size}pt`);
  }
  if (args.fontName) {
    parts.push(args.fontName);
  }
  if (args.color) {
    parts.push(`文字色 ${args.color}`);
  }
  if (args.highlightColor !== undefined) {
    parts.push(args.highlightColor.trim() ? `蛍光ペン ${args.highlightColor}` : "蛍光ペンを解除");
  }
  return parts;
}

const ALIGNMENT_LABELS: Record<ParagraphAlignmentArg, string> = {
  left: "左揃え",
  center: "中央揃え",
  right: "右揃え",
  justify: "両端揃え",
};

function paragraphFormatParts(args: FormatParagraphArgs): string[] {
  const parts: string[] = [];
  if (args.alignment) {
    parts.push(ALIGNMENT_LABELS[args.alignment]);
  }
  if (args.firstLineIndent !== undefined) {
    parts.push(`字下げ ${args.firstLineIndent}pt`);
  }
  if (args.leftIndent !== undefined) {
    parts.push(`左インデント ${args.leftIndent}pt`);
  }
  if (args.spaceAfter !== undefined) {
    parts.push(`段落後 ${args.spaceAfter}pt`);
  }
  if (args.lineSpacing !== undefined) {
    parts.push(`行間 ${args.lineSpacing}pt`);
  }
  return parts;
}

/** Short Japanese label for the operation chips in the chat. */
export function describeToolCall(name: string, rawArguments: string): string {
  const parsed = parseToolArguments(name, rawArguments);
  if (!parsed.ok) {
    return `${name}（引数を読めませんでした）`;
  }
  const call = parsed.call;
  switch (call.name) {
    case TOOL_SEARCH:
      return `検索「${shorten(call.args.q, 20)}」`;
    case TOOL_SEARCH_INDEX:
      return `索引「${shorten(call.args.q, 20)}」`;
    case TOOL_GET_SELECTION:
      return "選択範囲を確認";
    case TOOL_REPLACE_SELECTION:
      return "選択範囲を置換";
    case TOOL_REPLACE_QUOTE:
      return `「${shorten(call.args.quote, 12)}」を置換`;
    case TOOL_INSERT_BLOCKS: {
      const count = call.args.blocks.length;
      if (call.args.quote) {
        return `「${shorten(call.args.quote, 12)}」の後ろに ${count} 段落を挿入`;
      }
      if (call.args.at === "end") {
        return `${count} 段落を末尾に挿入`;
      }
      return call.args.at === "continue" ? `${count} 段落を続きに挿入` : `${count} 段落を挿入`;
    }
    case TOOL_INSERT_COMMENT:
      return call.args.quote ? `「${shorten(call.args.quote, 12)}」にコメント` : "コメントを追加";
    case TOOL_INSERT_CITATION:
      return call.args.as === "text" ? "出典を本文に挿入" : "出典をコメントに追加";
    case TOOL_FORMAT_TEXT:
      return `文字書式: ${textFormatParts(call.args).join("・")}`;
    case TOOL_FORMAT_PARAGRAPH:
      return `段落書式: ${paragraphFormatParts(call.args).join("・")}`;
    default:
      return name;
  }
}

export function normalizeToolCalls(input: unknown): ToolCall[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const calls: ToolCall[] = [];
  input.forEach((item, index) => {
    const row = asRecord(item);
    if (!row) {
      return;
    }
    const fn = asRecord(row.function);
    const name = fn ? text(fn, "name").trim() : "";
    if (!name) {
      return;
    }
    const args = fn && typeof fn.arguments === "string" ? fn.arguments : "";
    const id = text(row, "id").trim() || `call_${index}`;
    calls.push({ id, type: "function", function: { name, arguments: args } });
  });
  return calls;
}
