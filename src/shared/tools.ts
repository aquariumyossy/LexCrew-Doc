import { BLOCK_TYPES, DraftBlock, Severity, normalizeBlock } from "./blocks";
import { LINE_SPACING_CHARS, LineSpacingChars } from "./constants";
import { ListStyle, isListStyle, listStyleEnum, listStyleToolDescription } from "./listStyles";

export type { ListStyle } from "./listStyles";

export const TOOL_SEARCH = "search";
export const TOOL_SEARCH_INDEX = "search_index";
export const TOOL_GET_SELECTION = "get_selection";
export const TOOL_REPLACE_SELECTION = "replace_selection";
export const TOOL_REPLACE_QUOTE = "replace_quote";
export const TOOL_INSERT_BLOCKS = "insert_blocks";
export const TOOL_INSERT_BLANK_BEFORE = "insert_blank_before";
export const TOOL_INSERT_COMMENT = "insert_comment";
export const TOOL_INSERT_CITATION = "insert_citation";
export const TOOL_FORMAT_TEXT = "format_text";
export const TOOL_FORMAT_PARAGRAPH = "format_paragraph";
export const TOOL_FORMAT_LIST = "format_list";
export const TOOL_SET_OUTLINE = "set_outline_level";
export const TOOL_READ_PARAGRAPHS = "read_paragraphs";
export const TOOL_FIND_IN_DOCUMENT = "find_in_document";
export const TOOL_DELETE_PARAGRAPHS = "delete_paragraphs";
export const TOOL_DELETE_SHAPE = "delete_shape";
export const TOOL_READ_INDEXED_FILE = "read_indexed_file";

/** Word's search string cannot exceed this, and cannot span paragraphs. */
export const MAX_FIND_CHARS = 255;
/** One delete call. A longer list is a runaway, not a review. */
export const MAX_DELETE_PARAGRAPHS = 8;

/**
 * Shown on the next turn instead of a document read. The body is stale by then.
 * The chat pane still shows what was read.
 */
export const STALE_DOCUMENT_READ =
  "読み取った本文は次のターンには渡していません。いまの文書は添付を見てください。";

export function isDocumentSnapshotTool(name: string): boolean {
  return name === TOOL_READ_PARAGRAPHS || name === TOOL_FIND_IN_DOCUMENT;
}

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
export type ReplaceQuoteArgs = { quote: string; text: string; paragraph?: number };
export type InsertAtArg = "cursor" | "continue" | "end";
export type InsertBlocksArgs = {
  blocks: DraftBlock[];
  at?: InsertAtArg;
  quote?: string;
  paragraph?: number;
  /** Set only when the user asked for that property. */
  fontName?: string;
  bodyPt?: number;
  titlePt?: number;
  lineSpacingChars?: LineSpacingChars;
};
export type InsertBlankBeforeArgs = { paragraphs: number[] };
export type InsertCommentArgs = {
  comment: string;
  quote: string;
  severity: Severity;
  paragraph?: number;
};
export type InsertCitationArgs = {
  title: string;
  url: string;
  snippet: string;
  as: "comment" | "text";
};
export type FormatTextArgs = {
  quote: string;
  paragraph?: number;
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
  paragraph?: number;
  alignment?: ParagraphAlignmentArg;
  firstLineIndent?: number;
  leftIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  lineSpacing?: number;
};

export type ListAction = "apply" | "remove" | "restart";

export type FormatListArgs = {
  action: ListAction;
  quote?: string;
  paragraph?: number;
  through?: number;
  style?: ListStyle;
  level?: number;
  /** Begin a fresh list at 1 instead of joining the numbering above. */
  start?: boolean;
};

export type OutlineAction = "set" | "clear";

export type SetOutlineArgs = {
  action: OutlineAction;
  quote?: string;
  paragraph?: number;
  through?: number;
  /** 1 to 9 when action is set. Absent when action is clear. */
  level?: number;
};

export type ParagraphReadView = "full" | "marks";

export type ReadParagraphsArgs = {
  from?: number;
  through?: number;
  view?: ParagraphReadView;
};

export type FindInDocumentArgs = {
  q: string;
  /** Only hits whose paragraph number is greater than this. */
  after?: number;
};

export type DeleteParagraphsArgs = {
  paragraphs: number[];
  /** Paragraph number immediately before the copy to delete, when the text is not unique. */
  follows?: number;
};

export type DeleteShapeArgs = {
  /** The `[図1]` number from this turn's shape section. */
  shape: number;
};

export type ReadIndexedFileArgs = {
  path: string;
  offset?: number;
};

export type ToolInvocation =
  | { name: typeof TOOL_SEARCH; args: SearchArgs }
  | { name: typeof TOOL_SEARCH_INDEX; args: SearchIndexArgs }
  | { name: typeof TOOL_GET_SELECTION; args: GetSelectionArgs }
  | { name: typeof TOOL_REPLACE_SELECTION; args: ReplaceSelectionArgs }
  | { name: typeof TOOL_REPLACE_QUOTE; args: ReplaceQuoteArgs }
  | { name: typeof TOOL_INSERT_BLOCKS; args: InsertBlocksArgs }
  | { name: typeof TOOL_INSERT_BLANK_BEFORE; args: InsertBlankBeforeArgs }
  | { name: typeof TOOL_INSERT_COMMENT; args: InsertCommentArgs }
  | { name: typeof TOOL_INSERT_CITATION; args: InsertCitationArgs }
  | { name: typeof TOOL_FORMAT_TEXT; args: FormatTextArgs }
  | { name: typeof TOOL_FORMAT_PARAGRAPH; args: FormatParagraphArgs }
  | { name: typeof TOOL_FORMAT_LIST; args: FormatListArgs }
  | { name: typeof TOOL_SET_OUTLINE; args: SetOutlineArgs }
  | { name: typeof TOOL_READ_PARAGRAPHS; args: ReadParagraphsArgs }
  | { name: typeof TOOL_FIND_IN_DOCUMENT; args: FindInDocumentArgs }
  | { name: typeof TOOL_DELETE_PARAGRAPHS; args: DeleteParagraphsArgs }
  | { name: typeof TOOL_DELETE_SHAPE; args: DeleteShapeArgs }
  | { name: typeof TOOL_READ_INDEXED_FILE; args: ReadIndexedFileArgs };

export type ParsedTool = { ok: true; call: ToolInvocation } | { ok: false; error: string };

const PARAGRAPH_HINT =
  "対象の段落番号。添付された本文の行頭、または insert_blocks の結果にある [12] の数字をそのまま渡す。";
const PARAGRAPH_HINT_INSERTED =
  "対象の段落番号。このターンの insert_blocks の結果にある [12] の数字をそのまま渡す。それ以外の段落に番号は無いので quote で指す。";
const QUOTE_HINT_NARROW =
  "段落の中で対象をさらに絞る引用（任意）。添付された本文から字句どおりに写す。省略すると段落全体が対象。";
const QUOTE_HINT_SELECTION = "対象にする本文の引用。省略すると選択範囲全体が対象。";
const QUOTE_HINT_ONLY =
  "対象にする本文の引用。添付された本文から字句どおりに写し、文書内で 1 か所だけに当たる長さにする。";

function stringParam(description: string): Record<string, unknown> {
  return { type: "string", description };
}

/** How a tool is told where to work, which depends on what the turn carries. */
type TargetHints = { properties: Record<string, unknown>; required: string[] };

/**
 * With a numbered body attached, a paragraph number is always available and is
 * the address the model can copy without retyping the document, so it is asked
 * for instead of a quote. `paragraph` is not offered at all when the body was not
 * numbered: an address space the model was never given invites invented numbers.
 * Once an insert has handed out numbers for its new paragraphs (`inserted`),
 * those are offered too, beside the quote the rest of the document still needs.
 */
function targetHints(selection: boolean, numbered: boolean, inserted = false): TargetHints {
  if (numbered) {
    return {
      properties: {
        paragraph: { type: "number", description: PARAGRAPH_HINT },
        quote: stringParam(QUOTE_HINT_NARROW),
      },
      required: selection ? [] : ["paragraph"],
    };
  }
  if (inserted) {
    return {
      properties: {
        paragraph: { type: "number", description: PARAGRAPH_HINT_INSERTED },
        quote: stringParam(selection ? QUOTE_HINT_SELECTION : QUOTE_HINT_ONLY),
      },
      required: [],
    };
  }
  return {
    properties: { quote: stringParam(selection ? QUOTE_HINT_SELECTION : QUOTE_HINT_ONLY) },
    required: selection ? [] : ["quote"],
  };
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
        "選択範囲を、渡した全文で置き換える。履歴に残るのは、そのうち実際に違った部分だけです。" +
        "変わった数語だけを渡すと、残りの文が削除になります。段落をまたぐ選択は、範囲全体が一つの履歴になります。" +
        "変わった部分の太字は消えるので、書式を残したいときは format_text / format_paragraph を使う。",
      parameters: {
        type: "object",
        properties: { text: stringParam("置換後の本文") },
        required: ["text"],
      },
    },
  };
}

function replaceQuoteTool(target: TargetHints, numbered: boolean): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_REPLACE_QUOTE,
      description:
        "本文の範囲を、渡した全文で置き換える。書き換えの基本はこのツール。" +
        "履歴に残るのは、範囲のうち実際に違った部分だけです。text はその範囲の置換後全文です。" +
        "変わった数語だけを渡すと、残りの文が削除になります。" +
        (numbered
          ? "paragraph で段落を指します。quote でその中の範囲を絞れます。quote を省くと段落全体が範囲になります。"
          : "選択があればその中を先に探し、無ければ本文全体から探す。"),
      parameters: {
        type: "object",
        properties: { ...target.properties, text: stringParam("置換後の本文") },
        // Always points somewhere: replacing the selection is replace_selection's
        // job, and doing it here by omission would be an unasked-for edit.
        required: [...(numbered ? ["paragraph"] : ["quote"]), "text"],
      },
    },
  };
}

function insertBlocksTool(numbered: boolean): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_INSERT_BLOCKS,
      description:
        "構造付きの段落を挿入する。修正履歴に残る。" +
        (numbered
          ? "決まった場所の後ろに入れるときは paragraph に段落番号を渡す。その段落の直後に入る。" +
            "「第13条の次に」なら第13条の最後の項の番号を渡す。paragraph があるときは quote と at を見ない。"
          : "") +
        "quote を使うときは、入れたい位置の直前の段落から取った引用を入れる。" +
        "「第13条の次に」なら第13条の最後の項を引用する。quote があるときは at を見ない。" +
        "at は挿入位置。cursor（既定）はいまのカーソルの直後、continue は直前に挿入した段落の続き、end は文書の末尾。" +
        "長い原稿を分割するときは 2 回目以降を continue にし、条の若い順に続きだけを足す。" +
        "前のやりとりの続きを書くときも continue を指定する。cursor へ繰り返し入れると順序が逆になる。" +
        "使い分け: title は文書タイトル（中央・太字）、heading は「請求の趣旨」などの太字の見出し（ナビゲーションには出ない。出すなら set_outline_level）、" +
        "body は本文（先頭字下げはアドインが付けるので全角空白を足さない）、clause は条（label に「第○条」）、" +
        "item は項・号（直前がリストなら番号を継ぐ。番号そのものは本文に書かない）、" +
        "center は日付など、right は当事者名など。表・罫線・余白は出さない。" +
        "番号の付け外しと 1 からの振り直しは format_list。" +
        "結果に、入れた段落の番号 [12] が返る。同じターンでその段落を指すときは、quote ではなくその番号を paragraph / through に渡す。" +
        "fontName、bodyPt、titlePt、lineSpacingChars は、利用者がその項目をチャットで指定したときだけ入れる。空欄は設定で埋める指示ではない。行間の pt 指定は format_paragraph に残す。",
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
          ...(numbered
            ? {
                paragraph: {
                  type: "number",
                  description:
                    "入れたい位置の直前の段落の番号。添付された本文の行頭にある [12] の数字。その段落の後ろに入る。",
                },
              }
            : {}),
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
          fontName: stringParam("利用者が指定したフォント名。指定が無いときは省略する。"),
          bodyPt: {
            type: "number",
            description: "利用者が指定した本文の大きさ（pt）。指定が無いときは省略する。",
          },
          titlePt: {
            type: "number",
            description: "利用者が指定したタイトルの大きさ（pt）。本文の大きさとは別に、指定が無いときは省略する。",
          },
          lineSpacingChars: {
            type: "number",
            enum: [...LINE_SPACING_CHARS],
            description: "利用者が指定した行間（字）。1、1.25、1.5、2。指定が無いときは省略する。",
          },
        },
        required: ["blocks"],
      },
    },
  };
}

function insertBlankBeforeTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_INSERT_BLANK_BEFORE,
      description:
        "指定した段落の直前に、空の段落を 1 つずつ入れる。修正履歴に残る。段落の途中では割れない。" +
        "本文が「第N条」で始まる段落、自動番号が〔第N〕または〔第N条〕の段落を paragraphs にまとめて渡す。" +
        "章・節・項・号と、文中の「民法第415条」は、利用者がそう言ったときだけ入れる。" +
        "〔1.〕〔（１）〕〔ア〕は、利用者がそれらもと言ったときだけ入れる。" +
        "直前がすでに空行なら足さない。同じ番号は 1 回だけ。空行自体には番号が付かない。",
      parameters: {
        type: "object",
        required: ["paragraphs"],
        properties: {
          paragraphs: {
            type: "array",
            description:
              "空行を直前に入れる段落の番号。添付された本文の行頭、または insert_blocks の結果にある [12] の数字。",
            items: { type: "number" },
          },
        },
      },
    },
  };
}

function insertCommentTool(target: TargetHints): ToolDefinition {
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
          comment: stringParam(
            "コメント本文。判例・条文番号を書くときは未確認と明記する。吹き出しは短いので、指摘そのものを先に書き、前置きは書かない。段落番号や [12] は書かない。"
          ),
          ...target.properties,
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "重要度。既定は medium。",
          },
        },
        required: ["comment", ...target.required],
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

function formatTextTool(target: TargetHints): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_FORMAT_TEXT,
      description:
        "文字書式を変える。本文は変えない。修正履歴に書式変更として残る。" +
        "指定しなかった項目は元のまま。",
      parameters: {
        type: "object",
        ...(target.required.length ? { required: target.required } : {}),
        properties: {
          ...target.properties,
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

function formatParagraphTool(target: TargetHints): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_FORMAT_PARAGRAPH,
      description:
        "段落書式を変える。本文は変えない。修正履歴に書式変更として残る。" +
        "指定しなかった項目は元のまま。余白・罫線は変えられない。" +
        "行間を指定すると、対象段落は行グリッドへの合わせを外す（狭くしても効くようにするため）。" +
        "段落前・段落後の間隔を指定すると、「自動」を外してその値にする。" +
        "左インデントは折り返し（2行目以降）の位置。1行目は正の値で字下げ、負の値でぶら下げ。" +
        "本文12ptの左3字・ぶら下げ2字は、左36、1行目-24。",
      parameters: {
        type: "object",
        ...(target.required.length ? { required: target.required } : {}),
        properties: {
          ...target.properties,
          alignment: {
            type: "string",
            enum: ["left", "center", "right", "justify"],
            description: "揃え",
          },
          firstLineIndent: {
            type: "number",
            description:
              "1行目の位置（pt）。左インデントからの差分。正は字下げ（1行目が右へ）、負はぶら下げ（1行目が左へ出る）。本文12ptでぶら下げ2字なら -24。",
          },
          leftIndent: {
            type: "number",
            description:
              "左インデント（pt）。2行目以降の位置。本文12ptで3字なら 36。ぶら下げのとき、1行目はここより firstLineIndent の分だけ左。",
          },
          spaceBefore: {
            type: "number",
            description: "段落前の間隔（pt）。0 で詰める。指定すると「自動」を外す。",
          },
          spaceAfter: {
            type: "number",
            description: "段落後の間隔（pt）。0 で詰める。指定すると「自動」を外す。",
          },
          lineSpacing: { type: "number", description: "行間（pt）" },
        },
      },
    },
  };
}

function formatListTool(target: TargetHints): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_FORMAT_LIST,
      description:
        "Word の自動番号（リスト番号）を付ける・外す・その段落から 1 に振り直す。" +
        "本文には番号を書き込まない。修正履歴に書式変更として残る。" +
        "continue は直前の番号リストの続き。間に号の本文・空行・箇条書きがあっても、その前の項番号を継ぐ。" +
        "直前にリストが無いとき continue は 1. から始める。" +
        "continue は直前と同じ段のときに使う。段を変えるときは style を付けた apply にする。" +
        listStyleToolDescription() +
        "箇条書き（添付の 〔•〕）に style を付けると番号に変わる。" +
        "既にある項番号の見た目は変えない。変えるときは先に外す。" +
        "through で文書上の区間をまとめて対象にする。空段落は飛ばす。" +
        "level は 0 始まり。項が 0、号が 1、目が 2。" +
        "style を付けた apply は、既定で直前の番号リストに加わる。" +
        "同じ level なら次の番号、深い level なら 1 から始まり、浅い level に戻ると内側は 1 に戻る。" +
        "だから同じ条の項・号・目はこれだけで正しく並ぶ。" +
        "条が変わって番号を 1 から始めるときだけ start を true にする。" +
        "戻り値の番号は、付けたあとに Word が実際に表示している番号。書式の見本ではない。",
      parameters: {
        type: "object",
        required: ["action", ...(target.required.length ? target.required : [])],
        properties: {
          action: {
            type: "string",
            enum: ["apply", "remove", "restart"],
            description:
              "apply は番号を付ける、remove は外す、restart はその段落から 1 に振り直す。",
          },
          ...target.properties,
          through: {
            type: "number",
            description:
              "apply / remove のとき、paragraph（無ければ quote の段落）からこの段落番号までの区間（この番号を含む）。" +
              "番号は添付本文の行頭か insert_blocks の結果の [12]。restart には使わない。",
          },
          style: {
            type: "string",
            enum: listStyleEnum(),
            description: "apply のとき。省略は continue。restart / remove には付けない。",
          },
          level: {
            type: "number",
            description: "リストの段（0 始まり）。省略時 continue は直前の段、新規は 0。",
          },
          start: {
            type: "boolean",
            description:
              "style を付けた apply のとき。true でここから新しい番号を 1 で始める。" +
              "付けるのは条の最初の段落（第 1 項）だけ。号・目や 2 つ目以降の項には付けない。" +
              "号・目は level を深くするだけで 1 から始まる。省略すると直前の番号の続きになる。",
          },
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
  /** 番号付きの本文を添付したターンでは、段落番号で場所を指させる。 */
  numbered?: boolean;
  /** 添付に番号は無いが、このターンの insert_blocks が入れた段落には番号がある。 */
  insertedNumbers?: boolean;
  /** 図形節に [図1] を渡したターンだけ、その番号でテキストボックスを消させる。 */
  shapes?: boolean;
};

/**
 * Tools sent with every chat request. What the document offers decides the list:
 * a tool that would edit an empty selection is left out rather than allowed to
 * fail, and a place to work is asked for in the terms this turn can supply —
 * a paragraph number when the body was numbered, a quote when it was not.
 */
function readIndexedFileTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_READ_INDEXED_FILE,
      description:
        "search_index が返したファイルの全文を読む。url を path にそのまま渡す。検索の抜粋では足りないとき、たとえば契約書の条を確かめるときに使う。" +
        "検索結果に無いパスは読めない。長いファイルは offset で続きを読む。" +
        "各ページの文字が少ない PDF は読めないので、チャットに添付してもらう。",
      parameters: {
        type: "object",
        properties: {
          path: stringParam("search_index の結果の url。ファイルパス。"),
          offset: {
            type: "number",
            description: "続きを読むときの文字位置。最初は省く。",
          },
        },
        required: ["path"],
      },
    },
  };
}

function readParagraphsTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_READ_PARAGRAPHS,
      description:
        "開いている文書のいまの段落を読む。添付はツールを動かす前の状態なので、書き込んだあと、項番号、見出し、重複を確かめるときに使う。" +
        "view が full のときは本文・項番号・スタイル・その段落のコメントを返す。from が必要で、through を省くと from の 1 段落だけ。" +
        "view が marks のときは項番号の一覧だけを、文書の先頭から返す。from を省ける。番号なしの段落から番号を外す必要はない。" +
        "〔（１）〕は Word の項番号、[12] は場所である。返った [12] を、このあとの paragraph に使う。" +
        "続きがあるときは、結果に書いた from からもう一度読む。",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "number",
            description: "読み始める段落番号。添付または直前の読み取り結果の [12]。marks で省くと先頭から。",
          },
          through: {
            type: "number",
            description: "ここまでの段落番号（この番号を含む）。full で省くと from だけ。marks で省くと末尾まで。",
          },
          view: {
            type: "string",
            enum: ["full", "marks"],
            description: "full は本文つき。marks は項番号の一覧。省くと full。",
          },
        },
        required: [],
      },
    },
  };
}

function findInDocumentTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_FIND_IN_DOCUMENT,
      description:
        "開いている文書から、ある語を位置付きで全部出す。書き込みはしない。" +
        "「第6条を準用する」のような相互参照と、その条が本文にあるかの確認に使う。" +
        "自動番号（〔第１条〕）も対象にする。本文に書いていない番号は search では見つからない。" +
        "結果の [12] を、このあとの paragraph に使う。" +
        "件数が多いときは残りと最後の段落番号を返す。続きは after にその番号を渡す。",
      parameters: {
        type: "object",
        properties: {
          q: stringParam("文書から探す語。1 段落に収まる長さ。"),
          after: {
            type: "number",
            description: "この段落番号より後ろだけを見る。続きを取るときに、前回の最後の番号を渡す。",
          },
        },
        required: ["q"],
      },
    },
  };
}

function deleteShapeTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_DELETE_SHAPE,
      description:
        "図形節の [図1] のテキストボックスを削除する。修正履歴に残る。" +
        "shape には [図1] の数字を渡す。段落番号ではない。" +
        "同じ文言が複数あるときは、図形節での出現順のその番号の箱を消す。" +
        "消した番号はもう使えない。中の文字の置換、コメント、挿入はできない。",
      parameters: {
        type: "object",
        required: ["shape"],
        properties: {
          shape: {
            type: "number",
            description: "消すテキストボックスの番号。図形節の [図1] の数字。",
          },
        },
      },
    },
  };
}

function deleteParagraphsTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_DELETE_PARAGRAPHS,
      description:
        "段落そのものを削除する。修正履歴に残る。空の text での置換では消えないので、段落を消すときはこれを使う。" +
        "同じ文言が 2 箇所以上あるときは消さず、それぞれの直前の段落を返す。消したい方の直前の番号を follows に渡してやり直す。" +
        `一度に消せるのは ${MAX_DELETE_PARAGRAPHS} 段落まで。消した番号はもう使えない。`,
      parameters: {
        type: "object",
        required: ["paragraphs"],
        properties: {
          paragraphs: {
            type: "array",
            items: { type: "number" },
            description: "消す段落の番号。添付または read_paragraphs の [12]。",
          },
          follows: {
            type: "number",
            description: "同じ文言が複数あるときだけ。消したい方の直前の段落番号。",
          },
        },
      },
    },
  };
}

export function buildTools(options: ToolSetOptions = {}): ToolDefinition[] {
  const selection = Boolean(options.selection);
  const numbered = Boolean(options.numbered);
  const inserted = !numbered && Boolean(options.insertedNumbers);
  const target = targetHints(selection, numbered, inserted);
  const tools: ToolDefinition[] = [];
  if (options.search) {
    tools.push(searchTool());
  }
  if (options.argos) {
    tools.push(searchIndexTool());
    tools.push(readIndexedFileTool());
  }
  if (options.search || options.argos) {
    tools.push(insertCitationTool());
  }
  tools.push(readParagraphsTool());
  tools.push(findInDocumentTool());
  if (selection) {
    tools.push(getSelectionTool());
    tools.push(replaceSelectionTool());
  }
  tools.push(replaceQuoteTool(target, numbered));
  tools.push(insertBlocksTool(numbered || inserted));
  if (numbered || inserted) {
    tools.push(insertBlankBeforeTool());
    tools.push(deleteParagraphsTool());
  }
  if (options.shapes) {
    tools.push(deleteShapeTool());
  }
  tools.push(insertCommentTool(target));
  tools.push(formatTextTool(target));
  tools.push(formatParagraphTool(target));
  tools.push(formatListTool(target));
  tools.push(setOutlineTool(target));
  return tools;
}

function setOutlineTool(target: TargetHints): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_SET_OUTLINE,
      description:
        "ナビゲーションウィンドウの「見出し」に出す。段落のアウトラインレベルだけを変える。" +
        "スタイル、フォント、太字、配置は変えない。修正履歴に書式変更として残る。" +
        "set の level は 1 から 9。外すときは clear。clear に level は付けない。" +
        "見出し一覧に出る文言は段落全体なので、条の見出しと本文が同じ段落に入っている場所には使わない。" +
        "短い見出し段落だけを対象にする。" +
        "組み込みの見出し 1 から見出し 9 が付いている段落は、スタイルがレベルを固定しているので変えない。" +
        "その見出しから、次の同じかより上位のレベルまでが、この見出しの下に入る。" +
        "through で区間をまとめて対象にする。空段落は飛ばす。",
      parameters: {
        type: "object",
        required: ["action", ...(target.required.length ? target.required : [])],
        properties: {
          action: {
            type: "string",
            enum: ["set", "clear"],
            description: "set は見出しにする。clear は外して本文に戻す。",
          },
          ...target.properties,
          through: {
            type: "number",
            description:
              "paragraph（無ければ quote の段落）からこの段落番号までの区間（この番号を含む）。" +
              "番号は添付本文の行頭か insert_blocks の結果の [12]。",
          },
          level: {
            type: "number",
            description: "set のとき必須。1 から 9 の整数。clear には付けない。",
          },
        },
      },
    },
  };
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

function optionalPositive(
  row: Record<string, unknown>,
  key: string
): number | undefined | { error: string } {
  if (row[key] === undefined || row[key] === null || row[key] === "") {
    return undefined;
  }
  const value = typeof row[key] === "number" ? row[key] : Number(row[key]);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { error: `${key} は正の数にしてください。` };
  }
  return value;
}

function optionalLineSpacing(
  row: Record<string, unknown>
): LineSpacingChars | undefined | { error: string } {
  if (
    row.lineSpacingChars === undefined ||
    row.lineSpacingChars === null ||
    row.lineSpacingChars === ""
  ) {
    return undefined;
  }
  const value =
    typeof row.lineSpacingChars === "number" ? row.lineSpacingChars : Number(row.lineSpacingChars);
  const found = LINE_SPACING_CHARS.find((chars) => chars === value);
  if (found === undefined) {
    return { error: "lineSpacingChars は 1、1.25、1.5、2 のいずれかです。" };
  }
  return found;
}

/**
 * A paragraph number must be a real address. A zero, a fraction or a stray
 * string would otherwise land on a paragraph the model did not mean.
 */
function paragraphNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isInteger(Number(value)) &&
    Number(value) >= 1
  ) {
    return Number(value);
  }
  return undefined;
}

function paragraphListOf(row: Record<string, unknown>): number[] | { error: string } {
  const raw = row.paragraphs;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "paragraphs に、空行を入れる段落の番号を 1 つ以上入れてください。" };
  }
  const numbers: number[] = [];
  for (const item of raw) {
    const number = paragraphNumber(item);
    if (number === undefined) {
      return {
        error: "paragraphs は添付された本文の行頭にある [番号] の数字（1 以上の整数）の配列にしてください。",
      };
    }
    numbers.push(number);
  }
  return numbers;
}

function paragraphOf(
  row: Record<string, unknown>,
  key = "paragraph"
): number | undefined | { error: string } {
  const raw = row[key];
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const value = num(row, key);
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return {
      error: `${key} は添付または読み取り結果の [番号] の数字（1 以上の整数）にしてください。`,
    };
  }
  return value;
}

function throughOf(row: Record<string, unknown>): number | undefined | { error: string } {
  const raw = row.through;
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const value = num(row, "through");
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return {
      error: "through は添付された本文の行頭にある [番号] の数字（1 以上の整数）にしてください。",
    };
  }
  return value;
}

function outlineActionOf(row: Record<string, unknown>): OutlineAction | { error: string } {
  const value = row.action;
  if (value === "set" || value === "clear") {
    return value;
  }
  return { error: 'action は "set" か "clear" にしてください。' };
}

function listActionOf(row: Record<string, unknown>): ListAction | { error: string } {
  const value = row.action;
  // Models send the style name as the action. Continue is apply with the default style.
  if (value === "continue") {
    return "apply";
  }
  if (value === "apply" || value === "remove" || value === "restart") {
    return value;
  }
  return { error: 'action は "apply"、"remove"、"restart" のどれかにしてください。' };
}

function listStyleOf(row: Record<string, unknown>): ListStyle | undefined | { error: string } {
  const value = row.style;
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (isListStyle(value)) {
    return value;
  }
  return {
    error: `style は ${listStyleEnum().map((name) => `"${name}"`).join("、")} のどれかにしてください。`,
  };
}

function isArgError(value: unknown): value is { error: string } {
  return Boolean(value) && typeof value === "object" && "error" in (value as object);
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

function parseReadParagraphs(row: Record<string, unknown>): ParsedTool {
  const from = paragraphOf(row, "from");
  if (isArgError(from)) {
    return { ok: false, error: from.error };
  }
  const through = paragraphOf(row, "through");
  if (isArgError(through)) {
    return { ok: false, error: through.error };
  }
  const rawView = row.view;
  let view: ParagraphReadView | undefined;
  if (rawView !== undefined && rawView !== null && rawView !== "") {
    if (rawView !== "full" && rawView !== "marks") {
      return { ok: false, error: 'view は "full" か "marks" にしてください。' };
    }
    view = rawView;
  }
  if (through !== undefined && from !== undefined && through < from) {
    return { ok: false, error: "through は from と同じか、それより後ろの番号にしてください。" };
  }
  if ((view === undefined || view === "full") && from === undefined) {
    return {
      ok: false,
      error: "full で読むときは from に段落番号を渡してください。番号の一覧は view を marks にしてください。",
    };
  }
  return {
    ok: true,
    call: {
      name: TOOL_READ_PARAGRAPHS,
      args: {
        ...(from === undefined ? {} : { from }),
        ...(through === undefined ? {} : { through }),
        ...(view === undefined ? {} : { view }),
      },
    },
  };
}

function parseFindInDocument(row: Record<string, unknown>): ParsedTool {
  const q = text(row, "q").trim();
  if (!q) {
    return { ok: false, error: "q が空です。探す語を入れてください。" };
  }
  if (q.length > MAX_FIND_CHARS) {
    return {
      ok: false,
      error: `q が ${MAX_FIND_CHARS} 字を超えています。Word の検索の上限です。短くしてください。`,
    };
  }
  if (/[\r\n]/.test(q)) {
    return { ok: false, error: "q に改行は入れられません。1 行の語にしてください。" };
  }
  const after = paragraphOf(row, "after");
  if (isArgError(after)) {
    return { ok: false, error: after.error };
  }
  return {
    ok: true,
    call: {
      name: TOOL_FIND_IN_DOCUMENT,
      args: { q, ...(after === undefined ? {} : { after }) },
    },
  };
}

function parseReadIndexedFile(row: Record<string, unknown>): ParsedTool {
  const path = text(row, "path").trim();
  if (!path) {
    return { ok: false, error: "path が空です。search_index の url をそのまま渡してください。" };
  }
  const raw = row.offset;
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, call: { name: TOOL_READ_INDEXED_FILE, args: { path } } };
  }
  const offset = num(row, "offset");
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) {
    return { ok: false, error: "offset は 0 以上の整数にしてください。" };
  }
  return { ok: true, call: { name: TOOL_READ_INDEXED_FILE, args: { path, offset } } };
}

function parseDeleteParagraphs(row: Record<string, unknown>): ParsedTool {
  const raw = row.paragraphs;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "paragraphs に、消す段落の番号を 1 つ以上入れてください。" };
  }
  if (raw.length > MAX_DELETE_PARAGRAPHS) {
    return {
      ok: false,
      error: `一度に消せるのは ${MAX_DELETE_PARAGRAPHS} 段落までです。`,
    };
  }
  const numbers: number[] = [];
  for (const item of raw) {
    const number = paragraphNumber(item);
    if (number === undefined) {
      return {
        ok: false,
        error: "paragraphs は [番号] の数字（1 以上の整数）の配列にしてください。",
      };
    }
    numbers.push(number);
  }
  const follows = paragraphOf(row, "follows");
  if (isArgError(follows)) {
    return { ok: false, error: follows.error };
  }
  return {
    ok: true,
    call: {
      name: TOOL_DELETE_PARAGRAPHS,
      args: { paragraphs: numbers, ...(follows === undefined ? {} : { follows }) },
    },
  };
}

function parseDeleteShape(row: Record<string, unknown>): ParsedTool {
  const raw = row.shape;
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, error: "shape に、図形節の [図1] の数字を入れてください。" };
  }
  const shape = paragraphNumber(raw);
  if (shape === undefined) {
    return { ok: false, error: "shape は図形節の [図1] の数字（1 以上の整数）にしてください。" };
  }
  return { ok: true, call: { name: TOOL_DELETE_SHAPE, args: { shape } } };
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
      const paragraph = paragraphOf(row);
      if (isArgError(paragraph)) {
        return { ok: false, error: paragraph.error };
      }
      if (!quote && paragraph === undefined) {
        return {
          ok: false,
          error:
            "対象が指定されていません。paragraph に段落番号を渡すか、quote に置き換える本文の引用を入れてください。",
        };
      }
      if (!value.trim()) {
        return { ok: false, error: "text が空です。置換後の本文を入れてください。" };
      }
      return {
        ok: true,
        call: {
          name: TOOL_REPLACE_QUOTE,
          args: { quote, text: value, ...(paragraph === undefined ? {} : { paragraph }) },
        },
      };
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
      const paragraph = paragraphOf(row);
      if (isArgError(paragraph)) {
        return { ok: false, error: paragraph.error };
      }
      const quote = text(row, "quote").trim();
      const blocks: DraftBlock[] = [];
      for (const item of rawBlocks) {
        const record = asRecord(item);
        if (!record) {
          continue;
        }
        const block = normalizeBlock(record);
        if (!block) {
          continue;
        }
        if (!block.text.trim()) {
          return {
            ok: false,
            error:
              "blocks の text が空です。空行は insert_blank_before に、その段落の番号を渡してください。",
          };
        }
        blocks.push(block);
      }
      if (!blocks.length) {
        return {
          ok: false,
          error: "blocks に有効な段落がありません。type と text を入れてください。",
        };
      }
      const fontName = optionalString(row, "fontName")?.trim();
      const bodyPt = optionalPositive(row, "bodyPt");
      if (isArgError(bodyPt)) {
        return { ok: false, error: bodyPt.error };
      }
      const titlePt = optionalPositive(row, "titlePt");
      if (isArgError(titlePt)) {
        return { ok: false, error: titlePt.error };
      }
      const lineSpacingChars = optionalLineSpacing(row);
      if (isArgError(lineSpacingChars)) {
        return { ok: false, error: lineSpacingChars.error };
      }
      return {
        ok: true,
        call: {
          name: TOOL_INSERT_BLOCKS,
          args: {
            blocks,
            ...(at ? { at } : {}),
            ...(quote ? { quote } : {}),
            ...(paragraph === undefined ? {} : { paragraph }),
            ...(fontName ? { fontName } : {}),
            ...(bodyPt === undefined ? {} : { bodyPt }),
            ...(titlePt === undefined ? {} : { titlePt }),
            ...(lineSpacingChars === undefined ? {} : { lineSpacingChars }),
          },
        },
      };
    }
    case TOOL_INSERT_BLANK_BEFORE: {
      const paragraphs = paragraphListOf(row);
      if (isArgError(paragraphs)) {
        return { ok: false, error: paragraphs.error };
      }
      return {
        ok: true,
        call: { name: TOOL_INSERT_BLANK_BEFORE, args: { paragraphs } },
      };
    }
    case TOOL_INSERT_COMMENT: {
      const comment = text(row, "comment");
      if (!comment.trim()) {
        return { ok: false, error: "comment が空です。" };
      }
      const paragraph = paragraphOf(row);
      if (isArgError(paragraph)) {
        return { ok: false, error: paragraph.error };
      }
      return {
        ok: true,
        call: {
          name: TOOL_INSERT_COMMENT,
          args: {
            comment,
            quote: text(row, "quote"),
            severity: severityOf(row),
            ...(paragraph === undefined ? {} : { paragraph }),
          },
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
      const paragraph = paragraphOf(row);
      if (isArgError(paragraph)) {
        return { ok: false, error: paragraph.error };
      }
      const args: FormatTextArgs = {
        quote: text(row, "quote"),
        ...(paragraph === undefined ? {} : { paragraph }),
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
      const paragraph = paragraphOf(row);
      if (isArgError(paragraph)) {
        return { ok: false, error: paragraph.error };
      }
      const args: FormatParagraphArgs = {
        quote: text(row, "quote"),
        ...(paragraph === undefined ? {} : { paragraph }),
        alignment: alignmentOf(row),
        firstLineIndent: num(row, "firstLineIndent"),
        leftIndent: num(row, "leftIndent"),
        spaceBefore: num(row, "spaceBefore"),
        spaceAfter: num(row, "spaceAfter"),
        lineSpacing: num(row, "lineSpacing"),
      };
      if (
        args.alignment === undefined &&
        args.firstLineIndent === undefined &&
        args.leftIndent === undefined &&
        args.spaceBefore === undefined &&
        args.spaceAfter === undefined &&
        args.lineSpacing === undefined
      ) {
        return { ok: false, error: "変更する書式が指定されていません。" };
      }
      if (args.spaceBefore !== undefined && args.spaceBefore < 0) {
        return { ok: false, error: "spaceBefore は 0 以上にしてください。" };
      }
      if (args.spaceAfter !== undefined && args.spaceAfter < 0) {
        return { ok: false, error: "spaceAfter は 0 以上にしてください。" };
      }
      return { ok: true, call: { name: TOOL_FORMAT_PARAGRAPH, args } };
    }
    case TOOL_FORMAT_LIST: {
      const action = listActionOf(row);
      if (isArgError(action)) {
        return { ok: false, error: action.error };
      }
      const paragraph = paragraphOf(row);
      if (isArgError(paragraph)) {
        return { ok: false, error: paragraph.error };
      }
      const through = throughOf(row);
      if (isArgError(through)) {
        return { ok: false, error: through.error };
      }
      const style = listStyleOf(row);
      if (isArgError(style)) {
        return { ok: false, error: style.error };
      }
      const actionWasContinue = row.action === "continue";
      const resolvedStyle = actionWasContinue ? style || "continue" : style;
      const level = num(row, "level");
      if (level !== undefined && (!Number.isInteger(level) || level < 0 || level > 8)) {
        return { ok: false, error: "level は 0 から 8 の整数にしてください。" };
      }
      const start = bool(row, "start");
      if (action === "restart" && (resolvedStyle !== undefined || through !== undefined)) {
        return { ok: false, error: "restart には style も through も付けません。" };
      }
      if (action === "remove" && resolvedStyle !== undefined) {
        return { ok: false, error: "remove には style を付けません。" };
      }
      if (start && (resolvedStyle === undefined || resolvedStyle === "continue")) {
        return {
          ok: false,
          error: "start は style を付けた apply のときだけ使えます。continue は直前の番号の続きです。",
        };
      }
      if (through !== undefined && paragraph === undefined && !text(row, "quote").trim()) {
        return {
          ok: false,
          error: "through を使うときは、区間の先頭を paragraph（または quote）で渡してください。",
        };
      }
      if (through !== undefined && paragraph !== undefined && through < paragraph) {
        return { ok: false, error: "through は paragraph と同じか、それより後ろの番号にしてください。" };
      }
      const args: FormatListArgs = {
        action,
        quote: text(row, "quote"),
        ...(paragraph === undefined ? {} : { paragraph }),
        ...(through === undefined ? {} : { through }),
        ...(resolvedStyle === undefined ? {} : { style: resolvedStyle }),
        ...(level === undefined ? {} : { level }),
        ...(start ? { start } : {}),
      };
      return { ok: true, call: { name: TOOL_FORMAT_LIST, args } };
    }
    case TOOL_SET_OUTLINE: {
      const action = outlineActionOf(row);
      if (isArgError(action)) {
        return { ok: false, error: action.error };
      }
      const paragraph = paragraphOf(row);
      if (isArgError(paragraph)) {
        return { ok: false, error: paragraph.error };
      }
      const through = throughOf(row);
      if (isArgError(through)) {
        return { ok: false, error: through.error };
      }
      const level = num(row, "level");
      if (action === "clear" && level !== undefined) {
        return { ok: false, error: "clear には level を付けません。" };
      }
      if (action === "set" && level === undefined) {
        return { ok: false, error: "set には level（1 から 9）が必要です。" };
      }
      if (level !== undefined && (!Number.isInteger(level) || level < 1 || level > 9)) {
        return { ok: false, error: "level は 1 から 9 の整数にしてください。" };
      }
      if (through !== undefined && paragraph === undefined && !text(row, "quote").trim()) {
        return {
          ok: false,
          error: "through を使うときは、区間の先頭を paragraph（または quote）で渡してください。",
        };
      }
      if (through !== undefined && paragraph !== undefined && through < paragraph) {
        return { ok: false, error: "through は paragraph と同じか、それより後ろの番号にしてください。" };
      }
      const args: SetOutlineArgs = {
        action,
        quote: text(row, "quote"),
        ...(paragraph === undefined ? {} : { paragraph }),
        ...(through === undefined ? {} : { through }),
        ...(level === undefined ? {} : { level }),
      };
      return { ok: true, call: { name: TOOL_SET_OUTLINE, args } };
    }
    case TOOL_READ_PARAGRAPHS:
      return parseReadParagraphs(row);
    case TOOL_FIND_IN_DOCUMENT:
      return parseFindInDocument(row);
    case TOOL_DELETE_PARAGRAPHS:
      return parseDeleteParagraphs(row);
    case TOOL_DELETE_SHAPE:
      return parseDeleteShape(row);
    case TOOL_READ_INDEXED_FILE:
      return parseReadIndexedFile(row);
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
    parts.push(
      args.firstLineIndent < 0
        ? `ぶら下げ ${Math.abs(args.firstLineIndent)}pt`
        : `字下げ ${args.firstLineIndent}pt`
    );
  }
  if (args.leftIndent !== undefined) {
    parts.push(`左インデント ${args.leftIndent}pt`);
  }
  if (args.spaceBefore !== undefined) {
    parts.push(`段落前 ${args.spaceBefore}pt`);
  }
  if (args.spaceAfter !== undefined) {
    parts.push(`段落後 ${args.spaceAfter}pt`);
  }
  if (args.lineSpacing !== undefined) {
    parts.push(`行間 ${args.lineSpacing}pt`);
  }
  return parts;
}

/** Where the chip says the operation went, in whichever terms it was aimed. */
function whereLabel(args: { quote?: string; paragraph?: number }): string {
  if (args.quote?.trim()) {
    return `「${shorten(args.quote, 12)}」に`;
  }
  if (args.paragraph !== undefined) {
    return `段落 ${args.paragraph} に`;
  }
  return "";
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
      return call.args.quote
        ? `「${shorten(call.args.quote, 12)}」を置換`
        : `段落 ${call.args.paragraph} を置換`;
    case TOOL_INSERT_BLOCKS: {
      const count = call.args.blocks.length;
      if (call.args.paragraph !== undefined) {
        return `段落 ${call.args.paragraph} の後ろに ${count} 段落を挿入`;
      }
      if (call.args.quote) {
        return `「${shorten(call.args.quote, 12)}」の後ろに ${count} 段落を挿入`;
      }
      if (call.args.at === "end") {
        return `${count} 段落を末尾に挿入`;
      }
      return call.args.at === "continue" ? `${count} 段落を続きに挿入` : `${count} 段落を挿入`;
    }
    case TOOL_INSERT_BLANK_BEFORE: {
      const numbers = call.args.paragraphs;
      if (numbers.length === 1) {
        return `段落 ${numbers[0]} の直前に空行`;
      }
      return `${numbers.length} 段落の直前に空行`;
    }
    case TOOL_INSERT_COMMENT: {
      const where = whereLabel(call.args);
      return where ? `${where}コメント` : "コメントを追加";
    }
    case TOOL_INSERT_CITATION:
      return call.args.as === "text" ? "出典を本文に挿入" : "出典をコメントに追加";
    case TOOL_FORMAT_TEXT:
      return `文字書式: ${textFormatParts(call.args).join("・")}`;
    case TOOL_FORMAT_PARAGRAPH:
      return `段落書式: ${paragraphFormatParts(call.args).join("・")}`;
    case TOOL_FORMAT_LIST: {
      const action =
        call.args.action === "remove"
          ? "番号を外す"
          : call.args.action === "restart"
            ? "番号を1から"
            : "番号を付ける";
      const notes =
        call.args.action === "apply"
          ? [
              call.args.style && call.args.style !== "continue" ? call.args.style : "",
              call.args.start ? "1 から" : "",
            ].filter(Boolean)
          : [];
      const style = notes.length ? `（${notes.join("・")}）` : "";
      const where = whereLabel({ quote: call.args.quote, paragraph: call.args.paragraph });
      if (call.args.through !== undefined && call.args.paragraph !== undefined) {
        return `${action}${style}（段落 ${call.args.paragraph}〜${call.args.through}）`;
      }
      return where ? `${where}${action}${style}` : `${action}${style}`;
    }
    case TOOL_SET_OUTLINE: {
      const action = call.args.action === "clear" ? "見出しを外す" : `見出し ${call.args.level}`;
      const where = whereLabel({ quote: call.args.quote, paragraph: call.args.paragraph });
      if (call.args.through !== undefined && call.args.paragraph !== undefined) {
        return `${action}（段落 ${call.args.paragraph}〜${call.args.through}）`;
      }
      return where ? `${where}${action}` : action;
    }
    case TOOL_READ_PARAGRAPHS: {
      const view = call.args.view === "marks" ? "番号一覧" : "本文";
      if (call.args.from !== undefined && call.args.through !== undefined) {
        return `段落 ${call.args.from}〜${call.args.through} を読む（${view}）`;
      }
      if (call.args.from !== undefined) {
        return `段落 ${call.args.from} を読む（${view}）`;
      }
      return `文書を読む（${view}）`;
    }
    case TOOL_FIND_IN_DOCUMENT:
      return call.args.after !== undefined
        ? `文書内「${shorten(call.args.q, 16)}」（段落 ${call.args.after} の後ろ）`
        : `文書内「${shorten(call.args.q, 16)}」`;
    case TOOL_READ_INDEXED_FILE:
      return call.args.offset
        ? `資料を読む（${call.args.offset} 字目から）`
        : `資料を読む「${shorten(call.args.path, 24)}」`;
    case TOOL_DELETE_PARAGRAPHS: {
      const numbers = call.args.paragraphs;
      const follows = call.args.follows !== undefined ? `（段落 ${call.args.follows} の次）` : "";
      if (numbers.length === 1) {
        return `段落 ${numbers[0]} を削除${follows}`;
      }
      return `${numbers.length} 段落を削除${follows}`;
    }
    case TOOL_DELETE_SHAPE:
      return `図${call.args.shape} を削除`;
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
