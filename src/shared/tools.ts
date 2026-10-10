import { BLOCK_TYPES, DraftBlock, OUTLINE_LEVEL_COUNT, Severity, normalizeBlock } from "./blocks";
import { FormatSelect, isListFilter, listFilterEnum, replacePatternError } from "./bulkFormat";
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
export const TOOL_APPLY_FORMAT = "apply_format";
export const TOOL_REPLACE_ALL = "replace_all";
export const TOOL_COPY_FORMAT = "copy_format";
export const TOOL_FORMAT_LIST = "format_list";
export const TOOL_SET_OUTLINE = "set_outline_level";

const FORMATTING_TOOLS = new Set<string>([
  TOOL_FORMAT_TEXT,
  TOOL_FORMAT_PARAGRAPH,
  TOOL_APPLY_FORMAT,
  TOOL_COPY_FORMAT,
  TOOL_FORMAT_LIST,
  TOOL_SET_OUTLINE,
]);

/** True for tools that change appearance. `replace_all` is a text edit, so it stays out. */
export function isFormattingTool(name: string): boolean {
  return FORMATTING_TOOLS.has(name);
}
export const TOOL_READ_PARAGRAPHS = "read_paragraphs";
export const TOOL_FIND_IN_DOCUMENT = "find_in_document";
export const TOOL_DELETE_PARAGRAPHS = "delete_paragraphs";
export const TOOL_DELETE_MATCHING = "delete_matching";
export const TOOL_DELETE_SHAPE = "delete_shape";
export const TOOL_REPLACE_PARAGRAPHS = "replace_paragraphs";
export const TOOL_READ_INDEXED_FILE = "read_indexed_file";

/** Word's search string cannot exceed this, and cannot span paragraphs. */
export const MAX_FIND_CHARS = 255;
/** One delete call. A longer list is a runaway, not a review. */
export const MAX_DELETE_PARAGRAPHS = 8;
/** One conditional delete. More than this is refused whole, not cut short. */
export const MAX_DELETE_MATCHING = 200;
/** One replaced span, blank paragraphs included. */
export const MAX_REPLACE_PARAGRAPHS = 400;

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
export type TextFormatFields = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  fontName?: string;
  color?: string;
  highlightColor?: string;
};

export type ParagraphFormatFields = {
  alignment?: ParagraphAlignmentArg;
  firstLineIndent?: number;
  leftIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  lineSpacing?: number;
};

export type FormatTextArgs = TextFormatFields & {
  quote: string;
  paragraph?: number;
  /** Inclusive end of a span that starts at `paragraph` or at `quote`. */
  through?: number;
  /** Explicit paragraph numbers. When set, `paragraph` and `through` are not used. */
  paragraphs?: number[];
};
export type FormatParagraphArgs = ParagraphFormatFields & {
  quote: string;
  paragraph?: number;
  through?: number;
  paragraphs?: number[];
};

export type ApplyFormatArgs = {
  select: FormatSelect;
  format: TextFormatFields & ParagraphFormatFields;
};

export type ReplaceAllArgs = {
  find: string;
  /** Absent leaves the text. An empty string deletes each hit. */
  replace?: string;
  regex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  format?: TextFormatFields;
};

export type CopyFormatWhat = "both" | "character" | "paragraph";

export type CopyFormatArgs = {
  /** Sample paragraph number. */
  from?: number;
  /** Sample quote, when this turn has no paragraph numbers. */
  quote: string;
  paragraph?: number;
  through?: number;
  paragraphs?: number[];
  select?: FormatSelect;
  /** Default is both character and paragraph formatting. */
  what?: CopyFormatWhat;
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

export type DeleteMatchingArgs = {
  select: FormatSelect;
};

export type DeleteShapeArgs = {
  /** `[図1]` numbers from this turn's shape section, in the order given. */
  shapes: number[];
};

export type ReplaceParagraphsArgs = {
  paragraph: number;
  through: number;
  blocks: DraftBlock[];
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
  | { name: typeof TOOL_APPLY_FORMAT; args: ApplyFormatArgs }
  | { name: typeof TOOL_REPLACE_ALL; args: ReplaceAllArgs }
  | { name: typeof TOOL_COPY_FORMAT; args: CopyFormatArgs }
  | { name: typeof TOOL_FORMAT_LIST; args: FormatListArgs }
  | { name: typeof TOOL_SET_OUTLINE; args: SetOutlineArgs }
  | { name: typeof TOOL_READ_PARAGRAPHS; args: ReadParagraphsArgs }
  | { name: typeof TOOL_FIND_IN_DOCUMENT; args: FindInDocumentArgs }
  | { name: typeof TOOL_DELETE_PARAGRAPHS; args: DeleteParagraphsArgs }
  | { name: typeof TOOL_DELETE_MATCHING; args: DeleteMatchingArgs }
  | { name: typeof TOOL_DELETE_SHAPE; args: DeleteShapeArgs }
  | { name: typeof TOOL_REPLACE_PARAGRAPHS; args: ReplaceParagraphsArgs }
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
          : "選択があればその中を先に探し、無ければ本文全体から探す。") +
        "同じ文字列を文書中のすべてで置き換えるときは replace_all。",
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

const OUTLINE_BLOCK_HINT =
  "outline は「第１」「１．」「（１）」のように、番号を本文に書いて階層を作る段落。番号は text の先頭に書く（自動番号ではない）。" +
  "level は階層の深さで、0 が第１、1 が１．、2 が（１）、3 が①・ア・「・」などそのほかの印、4 は階層の下の本文。" +
  "0 と 1 は短い見出しだけに使う。文で書く内容は、見出しの下に level 4 の本文として置き、「１．」を付けて見出しにしない。" +
  "字下げ・ぶら下げ・太字は設定の階層レイアウトで付くので、全角空白で位置を合わせない。";

function blocksParam(): Record<string, unknown> {
  return {
    type: "array",
    description: "挿入する段落の並び（文書上の出現順）",
    items: {
      type: "object",
      properties: {
        type: { type: "string", enum: BLOCK_TYPES, description: "段落の種類" },
        text: stringParam("段落の本文"),
        label: stringParam("clause のときの「第○条」など（任意）"),
        level: {
          type: "number",
          description: `outline のときの階層。0 から ${OUTLINE_LEVEL_COUNT - 1}。`,
        },
      },
      required: ["type", "text"],
    },
  };
}

function replaceParagraphsTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_REPLACE_PARAGRAPHS,
      description:
        "段落 paragraph から through までを消し、その位置に blocks を入れる。修正履歴に残る。" +
        "間の空行と、範囲の段落に結び付いた図形節の [図1] のテキストボックスも一緒に消える。" +
        "through の直後の空行に結び付いたテキストボックスは、その空行ごと消える。範囲の外の段落と画像は変えない。" +
        "節や様式の本文をまとめて書き直すとき、テキストボックスの中身を本文に起こすときは、" +
        "insert_blocks・delete_paragraphs・delete_shape を繰り返さず、これを 1 回呼ぶ。" +
        `一度に消せるのは ${MAX_REPLACE_PARAGRAPHS} 段落まで。` +
        "blocks の書き方は insert_blocks と同じ。" +
        OUTLINE_BLOCK_HINT +
        "結果に、消した範囲の先頭と末尾、入れた段落の番号 [12] が返る。",
      parameters: {
        type: "object",
        required: ["paragraph", "through", "blocks"],
        properties: {
          paragraph: {
            type: "number",
            description: "消す範囲の最初の段落番号。添付された本文の行頭の [12]。",
          },
          through: {
            type: "number",
            description: "消す範囲の最後の段落番号（この段落も消える）。",
          },
          blocks: blocksParam(),
        },
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
        OUTLINE_BLOCK_HINT +
        "番号の付け外しと 1 からの振り直しは format_list。" +
        "結果に、入れた段落の番号 [12] が返る。同じターンでその段落を指すときは、quote ではなくその番号を paragraph / through に渡す。" +
        "fontName、bodyPt、titlePt、lineSpacingChars は、利用者がその項目をチャットで指定したときだけ入れる。空欄は設定で埋める指示ではない。行間の pt 指定は format_paragraph に残す。",
      parameters: {
        type: "object",
        properties: {
          blocks: blocksParam(),
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

const BULK_FORMAT_HINT =
  "複数の段落は paragraphs（番号の配列）か、paragraph から through までの区間で 1 回にまとめる。1 段落ずつ繰り返さない。" +
  "段落の中の一部だけを変えるときは quote を使い、through と paragraphs は付けない（付けると段落全体が対象）。" +
  "条件で選ぶときは apply_format。見本から写すときは copy_format。同じ応答で他の書式ツールとまとめて呼ぶ。";

function bulkAddressProperties(target: TargetHints): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(target.properties, "paragraph")) {
    return {};
  }
  return {
    through: {
      type: "number",
      description:
        "paragraph（無ければ quote の段落）からこの段落番号まで（この番号を含む）。段落全体が対象。空段落は飛ばす。paragraphs とは同時に使わない。",
    },
    paragraphs: {
      type: "array",
      items: { type: "number" },
      description:
        "対象にする段落番号。あるときはこの配列だけが対象で、paragraph と through は見ない。段落全体が対象。",
    },
  };
}

const TEXT_FORMAT_PROPERTIES: Record<string, unknown> = {
  bold: { type: "boolean", description: "太字" },
  italic: { type: "boolean", description: "斜体" },
  underline: { type: "boolean", description: "下線" },
  size: { type: "number", description: "文字の大きさ（pt）" },
  fontName: stringParam("フォント名（例: 游明朝）"),
  color: stringParam("文字色。#RRGGBB。"),
  highlightColor: stringParam("蛍光ペン。#RRGGBB。解除は空文字。"),
};

const PARAGRAPH_FORMAT_PROPERTIES: Record<string, unknown> = {
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
};

function selectProperties(): Record<string, unknown> {
  return {
    style: stringParam(
      "スタイル名（見出し 1、標準）または組み込み名（Heading1）。大文字小文字だけは区別しない。"
    ),
    outlineLevel: {
      type: "number",
      description: "ナビゲーションの見出しレベル。1 から 9。",
    },
    text: stringParam("段落本文との部分一致。regex が true のときは正規表現。"),
    regex: { type: "boolean", description: "text を正規表現として扱う。一致は 1 段落の中だけ。" },
    matchCase: {
      type: "boolean",
      description: "true で大文字小文字を区別する。省くと区別しない。",
    },
    empty: {
      type: "boolean",
      description:
        "true は空段落だけ。false は文字のある段落だけ。apply_format で省いたときは空段落に当たらない。",
    },
    list: {
      type: "string",
      enum: listFilterEnum(),
      description: "any は箇条書きか番号、bullet は箇条書き、numbered は番号、none はどちらでもない。",
    },
    tableCell: {
      type: "boolean",
      description: "true は表のセルだけ。false は表の外だけ。表の作成や罫線はできない。",
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
        "指定しなかった項目は元のまま。" +
        BULK_FORMAT_HINT,
      parameters: {
        type: "object",
        ...(target.required.length ? { required: target.required } : {}),
        properties: {
          ...target.properties,
          ...bulkAddressProperties(target),
          ...TEXT_FORMAT_PROPERTIES,
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
        "本文12ptの左3字・ぶら下げ2字は、左36、1行目-24。" +
        BULK_FORMAT_HINT,
      parameters: {
        type: "object",
        ...(target.required.length ? { required: target.required } : {}),
        properties: {
          ...target.properties,
          ...bulkAddressProperties(target),
          ...PARAGRAPH_FORMAT_PROPERTIES,
        },
      },
    },
  };
}

function applyFormatTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_APPLY_FORMAT,
      description:
        "条件に合う段落すべてに、同じ書式を 1 回で当てる。本文は変えない。修正履歴に書式変更として残る。" +
        "select の条件はすべて AND。段落番号を並べない。" +
        "format に文字書式と段落書式を混ぜてよい。指定しなかった項目は元のまま。" +
        "行間を指定すると、対象段落は行グリッドへの合わせを外す。" +
        "空段落は empty を true にしたときだけ対象にする。項目番号だけの空行は、番号の形だけでは当たらない。" +
        "戻りは件数と、当たった先頭と末尾の短い引用。本文全体は返さない。同じ応答で他の書式ツールとまとめて呼ぶ。",
      parameters: {
        type: "object",
        required: ["select", "format"],
        properties: {
          select: {
            type: "object",
            description: "どれも指定が無い呼び出しは、文書全体には当たらず失敗する。",
            properties: selectProperties(),
          },
          format: {
            type: "object",
            description: "当てる書式。文字と段落を同じオブジェクトに入れてよい。",
            properties: { ...TEXT_FORMAT_PROPERTIES, ...PARAGRAPH_FORMAT_PROPERTIES },
          },
        },
      },
    },
  };
}

function replaceAllTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_REPLACE_ALL,
      description:
        "文書全体を検索して、一致した箇所をまとめて置換する。修正履歴に残る。" +
        "段落ごとに replace_quote を繰り返さない。" +
        "find は 1 段落の中だけで探す。regex を true にすると find は正規表現。" +
        "matchCase を省くと大文字小文字を区別しない。" +
        "wholeWord を true にすると、前後が文字・数字・_ でないときだけ一致する。日本語は空白が無くても、隣が文字なら一致しない。" +
        "replace を省くと文字は変えず、format の文字書式だけを一致箇所に当てる。replace が空文字ならその箇所を削除する。" +
        "戻り値は件数だけ。",
      parameters: {
        type: "object",
        required: ["find"],
        properties: {
          find: stringParam("探す文字列。regex が true のときは正規表現。"),
          replace: stringParam("置換後の文字列。省くと文字は変えない。空文字は削除。"),
          regex: { type: "boolean", description: "find を正規表現として扱う。" },
          matchCase: {
            type: "boolean",
            description: "true で大文字小文字を区別する。省くと区別しない。",
          },
          wholeWord: {
            type: "boolean",
            description: "true で語の途中は一致させない。",
          },
          format: {
            type: "object",
            description: "一致箇所に当てる文字書式。段落書式は入れない。",
            properties: TEXT_FORMAT_PROPERTIES,
          },
        },
      },
    },
  };
}

function copyFormatTool(target: TargetHints): ToolDefinition {
  const numbered = Object.prototype.hasOwnProperty.call(target.properties, "paragraph");
  return {
    type: "function",
    function: {
      name: TOOL_COPY_FORMAT,
      description:
        "見本の段落から、直接の文字書式と段落書式を写す。本文は変えない。修正履歴に書式変更として残る。" +
        "スタイル名は変えない。見本の中で混在している項目は省く。見本自身には書き戻さない。" +
        (numbered
          ? "from は見本の段落番号。写す先は paragraph から through、paragraphs、select のどれか一つ。"
          : "quote は見本の引用。写す先は select。") +
        "what を省くと文字と段落の両方。戻り値は件数だけ。同じ応答で他の書式ツールとまとめて呼ぶ。",
      parameters: {
        type: "object",
        required: numbered ? ["from"] : ["quote"],
        properties: {
          ...(numbered
            ? {
                from: {
                  type: "number",
                  description: "見本の段落番号。添付または insert_blocks の [12]。",
                },
                paragraph: {
                  type: "number",
                  description: "写す先の先頭の段落番号。through と組む。見本の from とは別。",
                },
                through: {
                  type: "number",
                  description: "写す先の末尾の段落番号（この番号を含む）。",
                },
                paragraphs: {
                  type: "array",
                  items: { type: "number" },
                  description: "写す先の段落番号。paragraph / through / select とは同時に使わない。",
                },
              }
            : {}),
          quote: stringParam(
            numbered
              ? "見本を番号で指せないときの引用。from があるときは見ない。"
              : "見本にする段落の引用。添付された本文から字句どおりに写す。"
          ),
          select: {
            type: "object",
            description: "写す先を apply_format と同じ条件で選ぶ。範囲の指定とは同時に使わない。",
            properties: selectProperties(),
          },
          what: {
            type: "string",
            enum: ["both", "character", "paragraph"],
            description: "both は文字と段落。character は文字だけ。paragraph は段落だけ。省くと both。",
          },
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

function deleteMatchingTool(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: TOOL_DELETE_MATCHING,
      description:
        "条件に合う本文の段落を一度に削除する。修正履歴に残る。" +
        "select は apply_format と同じ AND。条件が無い呼び出しは何も消さない。" +
        "text は部分一致。その文字だけの行は、段落全体に合う正規表現にする。" +
        "empty を true にすると空の段落を消す。本文が空の項番号も入る。" +
        "tableCell を省くと表の外だけ消す。セルを消すときは tableCell を true にする。" +
        `一度に消せるのは ${MAX_DELETE_MATCHING} 段落まで。超えたときは消さず件数だけ返す。` +
        "図形の中は消えない。消した番号はもう使えない。残った段落は、本文が同じなら同じ番号のまま。",
      parameters: {
        type: "object",
        required: ["select"],
        properties: {
          select: {
            type: "object",
            description: "どれも指定が無い呼び出しは、何も消さずに失敗する。",
            properties: selectProperties(),
          },
        },
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
        "shapes には [図1] の数字を並べる。段落番号ではない。消す箱が複数あれば 1 回の呼び出しにまとめる。" +
        "同じ文言が複数あるときは、図形節での出現順のその番号の箱を消す。" +
        "消した番号はもう使えない。中の文字の置換、コメント、挿入はできない。" +
        "箱の中身を本文に起こすなら、replace_paragraphs で本文の書き直しと一緒に消す。",
      parameters: {
        type: "object",
        required: ["shapes"],
        properties: {
          shapes: {
            type: "array",
            items: { type: "number" },
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
        "番号が 1 つの段落に決まっていれば、同じ文言がほかにあってもその段落を消す。" +
        "番号ではどれか決まらないときだけ、消したい方の直前の番号を follows に渡す。" +
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
            description: "番号ではどれか決まらないとき。消したい方の直前の段落番号。",
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
  tools.push(replaceAllTool());
  tools.push(insertBlocksTool(numbered || inserted));
  if (numbered || inserted) {
    tools.push(replaceParagraphsTool());
    tools.push(insertBlankBeforeTool());
    tools.push(deleteParagraphsTool());
    tools.push(deleteMatchingTool());
  }
  if (options.shapes) {
    tools.push(deleteShapeTool());
  }
  tools.push(insertCommentTool(target));
  tools.push(formatTextTool(target));
  tools.push(formatParagraphTool(target));
  tools.push(applyFormatTool());
  tools.push(copyFormatTool(target));
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

function alignmentOf(
  row: Record<string, unknown>
): ParagraphAlignmentArg | undefined | { error: string } {
  const value = row.alignment;
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "left" || value === "center" || value === "right" || value === "justify") {
    return value;
  }
  return { error: 'alignment は "left"、"center"、"right"、"justify" のどれかにしてください。' };
}

function optionalParagraphNumbers(
  row: Record<string, unknown>
): number[] | undefined | { error: string } {
  if (!Object.prototype.hasOwnProperty.call(row, "paragraphs")) {
    return undefined;
  }
  const raw = row.paragraphs;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "paragraphs に、対象の段落番号を 1 つ以上入れてください。" };
  }
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const number = paragraphNumber(item);
    if (number === undefined) {
      return {
        error: "paragraphs は添付された本文の行頭にある [番号] の数字（1 以上の整数）の配列にしてください。",
      };
    }
    if (!seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }
  return numbers;
}

/**
 * `paragraphs` wins over `paragraph`, so a schema that still requires `paragraph`
 * can send both and the list is what gets formatted.
 */
function formatAddress(row: Record<string, unknown>): FormatSpan | { error: string } {
  const quote = text(row, "quote");
  const paragraphs = optionalParagraphNumbers(row);
  if (isArgError(paragraphs)) {
    return paragraphs;
  }
  const paragraph = paragraphOf(row);
  if (isArgError(paragraph)) {
    return paragraph;
  }
  const through = throughOf(row);
  if (isArgError(through)) {
    return through;
  }
  if (paragraphs && through !== undefined) {
    return { error: "paragraphs と through は同時に使えません。どちらか一方にしてください。" };
  }
  if (paragraphs) {
    return { quote, paragraphs };
  }
  if (through !== undefined && paragraph === undefined && !quote.trim()) {
    return {
      error: "through を使うときは、区間の先頭を paragraph（または quote）で渡してください。",
    };
  }
  if (through !== undefined && paragraph !== undefined && through < paragraph) {
    return { error: "through は paragraph と同じか、それより後ろの番号にしてください。" };
  }
  return {
    quote,
    ...(paragraph === undefined ? {} : { paragraph }),
    ...(through === undefined ? {} : { through }),
  };
}

type FormatSpan = {
  quote: string;
  paragraph?: number;
  through?: number;
  paragraphs?: number[];
};

function readTextFormat(row: Record<string, unknown>): TextFormatFields | { error: string } {
  const size = num(row, "size");
  if (size !== undefined && size <= 0) {
    return { error: "size は正の数にしてください。" };
  }
  return {
    bold: bool(row, "bold"),
    italic: bool(row, "italic"),
    underline: bool(row, "underline"),
    size,
    fontName: optionalString(row, "fontName"),
    color: optionalString(row, "color"),
    highlightColor: optionalString(row, "highlightColor"),
  };
}

function hasTextFormat(fields: TextFormatFields): boolean {
  return (
    fields.bold !== undefined ||
    fields.italic !== undefined ||
    fields.underline !== undefined ||
    fields.size !== undefined ||
    fields.fontName !== undefined ||
    fields.color !== undefined ||
    fields.highlightColor !== undefined
  );
}

function readParagraphFormat(
  row: Record<string, unknown>
): ParagraphFormatFields | { error: string } {
  const alignment = alignmentOf(row);
  if (isArgError(alignment)) {
    return alignment;
  }
  const spaceBefore = num(row, "spaceBefore");
  const spaceAfter = num(row, "spaceAfter");
  if (spaceBefore !== undefined && spaceBefore < 0) {
    return { error: "spaceBefore は 0 以上にしてください。" };
  }
  if (spaceAfter !== undefined && spaceAfter < 0) {
    return { error: "spaceAfter は 0 以上にしてください。" };
  }
  return {
    alignment,
    firstLineIndent: num(row, "firstLineIndent"),
    leftIndent: num(row, "leftIndent"),
    spaceBefore,
    spaceAfter,
    lineSpacing: num(row, "lineSpacing"),
  };
}

function hasParagraphFormat(fields: ParagraphFormatFields): boolean {
  return (
    fields.alignment !== undefined ||
    fields.firstLineIndent !== undefined ||
    fields.leftIndent !== undefined ||
    fields.spaceBefore !== undefined ||
    fields.spaceAfter !== undefined ||
    fields.lineSpacing !== undefined
  );
}

function omitEmptyFormat<T extends Record<string, unknown>>(fields: T): T {
  const kept = {} as T;
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (fields[key] !== undefined) {
      kept[key] = fields[key];
    }
  }
  return kept;
}

function parseSelect(value: unknown): FormatSelect | { error: string } {
  const row = asRecord(value);
  if (!row) {
    return { error: "select はオブジェクトにしてください。" };
  }
  const select: FormatSelect = {};
  if (row.style !== undefined) {
    const style = text(row, "style").trim();
    if (!style) {
      return { error: "style が空です。" };
    }
    select.style = style;
  }
  if (row.outlineLevel !== undefined && row.outlineLevel !== null && row.outlineLevel !== "") {
    const level = num(row, "outlineLevel");
    if (level === undefined || !Number.isInteger(level) || level < 1 || level > 9) {
      return { error: "outlineLevel は 1 から 9 の整数にしてください。" };
    }
    select.outlineLevel = level;
  }
  if (row.text !== undefined) {
    const sample = text(row, "text");
    if (!sample) {
      return { error: "text が空です。" };
    }
    select.text = sample;
  }
  const regex = bool(row, "regex");
  if (regex) {
    select.regex = true;
  }
  const matchCase = bool(row, "matchCase");
  if (matchCase) {
    select.matchCase = true;
  }
  if (select.regex && select.text === undefined) {
    return { error: "regex を使うときは text に正規表現を入れてください。" };
  }
  if (row.empty !== undefined) {
    const empty = bool(row, "empty");
    if (empty === undefined) {
      return { error: "empty は true か false にしてください。" };
    }
    select.empty = empty;
  }
  if (select.empty === true && select.text !== undefined) {
    return { error: "empty が true のときに text は使えません。" };
  }
  if (row.list !== undefined && row.list !== null && row.list !== "") {
    if (!isListFilter(row.list)) {
      return {
        error: `list は ${listFilterEnum().map((name) => `"${name}"`).join("、")} のどれかにしてください。`,
      };
    }
    select.list = row.list;
  }
  if (row.tableCell !== undefined) {
    const tableCell = bool(row, "tableCell");
    if (tableCell === undefined) {
      return { error: "tableCell は true か false にしてください。" };
    }
    select.tableCell = tableCell;
  }
  if (
    select.style === undefined &&
    select.outlineLevel === undefined &&
    select.text === undefined &&
    select.empty === undefined &&
    select.list === undefined &&
    select.tableCell === undefined
  ) {
    return {
      error: "select に条件がありません。style、outlineLevel、text、empty、list、tableCell のいずれかを入れてください。",
    };
  }
  if (select.regex && select.text) {
    const patternError = replacePatternError(
      { find: select.text, regex: true, matchCase: select.matchCase },
      MAX_FIND_CHARS
    );
    if (patternError && patternError !== "find が空です。") {
      return { error: patternError };
    }
  }
  return select;
}

function parseApplyFormat(row: Record<string, unknown>): ParsedTool {
  const select = parseSelect(row.select);
  if (isArgError(select)) {
    return { ok: false, error: select.error };
  }
  const formatRow = asRecord(row.format);
  if (!formatRow) {
    return { ok: false, error: "format はオブジェクトにしてください。" };
  }
  const textFormat = readTextFormat(formatRow);
  if (isArgError(textFormat)) {
    return { ok: false, error: textFormat.error };
  }
  const paragraphFormat = readParagraphFormat(formatRow);
  if (isArgError(paragraphFormat)) {
    return { ok: false, error: paragraphFormat.error };
  }
  if (!hasTextFormat(textFormat) && !hasParagraphFormat(paragraphFormat)) {
    return { ok: false, error: "変更する書式が指定されていません。" };
  }
  return {
    ok: true,
    call: {
      name: TOOL_APPLY_FORMAT,
      args: { select, format: { ...omitEmptyFormat(textFormat), ...omitEmptyFormat(paragraphFormat) } },
    },
  };
}

function parseReplaceAll(row: Record<string, unknown>): ParsedTool {
  const find = text(row, "find");
  if (!find) {
    return { ok: false, error: "find が空です。" };
  }
  let replace: string | undefined;
  if (row.replace !== undefined && row.replace !== null) {
    if (typeof row.replace !== "string") {
      return { ok: false, error: "replace は文字列にしてください。" };
    }
    replace = row.replace;
  }
  const regex = bool(row, "regex") === true;
  const matchCase = bool(row, "matchCase") === true;
  const wholeWord = bool(row, "wholeWord") === true;
  const patternError = replacePatternError(
    { find, regex, matchCase, wholeWord },
    MAX_FIND_CHARS
  );
  if (patternError) {
    return { ok: false, error: patternError };
  }
  let format: TextFormatFields | undefined;
  if (row.format !== undefined && row.format !== null) {
    const formatRow = asRecord(row.format);
    if (!formatRow) {
      return { ok: false, error: "format はオブジェクトにしてください。" };
    }
    if (
      formatRow.alignment !== undefined ||
      formatRow.firstLineIndent !== undefined ||
      formatRow.leftIndent !== undefined ||
      formatRow.spaceBefore !== undefined ||
      formatRow.spaceAfter !== undefined ||
      formatRow.lineSpacing !== undefined
    ) {
      return { ok: false, error: "replace_all の format は文字書式だけです。" };
    }
    const textFormat = readTextFormat(formatRow);
    if (isArgError(textFormat)) {
      return { ok: false, error: textFormat.error };
    }
    if (!hasTextFormat(textFormat)) {
      return { ok: false, error: "format に文字書式がありません。" };
    }
    format = omitEmptyFormat(textFormat);
  }
  if (replace === undefined && !format) {
    return { ok: false, error: "replace か format のどちらかが必要です。" };
  }
  return {
    ok: true,
    call: {
      name: TOOL_REPLACE_ALL,
      args: {
        find,
        ...(replace === undefined ? {} : { replace }),
        ...(regex ? { regex } : {}),
        ...(matchCase ? { matchCase } : {}),
        ...(wholeWord ? { wholeWord } : {}),
        ...(format ? { format } : {}),
      },
    },
  };
}

function copyWhatOf(row: Record<string, unknown>): CopyFormatWhat | undefined | { error: string } {
  const value = row.what;
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "both" || value === "character" || value === "paragraph") {
    return value;
  }
  return { error: 'what は "both"、"character"、"paragraph" のどれかにしてください。' };
}

function parseCopyFormat(row: Record<string, unknown>): ParsedTool {
  const from = paragraphOf(row, "from");
  if (isArgError(from)) {
    return { ok: false, error: from.error };
  }
  const quote = text(row, "quote");
  if (from === undefined && !quote.trim()) {
    return {
      ok: false,
      error: "見本が指定されていません。from に段落番号を渡すか、quote に見本の引用を入れてください。",
    };
  }
  const what = copyWhatOf(row);
  if (isArgError(what)) {
    return { ok: false, error: what.error };
  }
  const paragraphs = optionalParagraphNumbers(row);
  if (isArgError(paragraphs)) {
    return { ok: false, error: paragraphs.error };
  }
  const paragraph = paragraphOf(row);
  if (isArgError(paragraph)) {
    return { ok: false, error: paragraph.error };
  }
  const through = throughOf(row);
  if (isArgError(through)) {
    return { ok: false, error: through.error };
  }
  let select: FormatSelect | undefined;
  if (row.select !== undefined && row.select !== null) {
    const parsed = parseSelect(row.select);
    if (isArgError(parsed)) {
      return { ok: false, error: parsed.error };
    }
    select = parsed;
  }
  const modes = [Boolean(paragraphs), paragraph !== undefined || through !== undefined, Boolean(select)].filter(
    Boolean
  ).length;
  if (modes === 0) {
    return {
      ok: false,
      error: "写す先がありません。paragraph と through、paragraphs、select のどれか一つを入れてください。",
    };
  }
  if (modes > 1) {
    return {
      ok: false,
      error: "写す先は paragraph と through、paragraphs、select のどれか一つにしてください。",
    };
  }
  if (through !== undefined && paragraph === undefined) {
    return { ok: false, error: "through を使うときは、写す先の先頭を paragraph で渡してください。" };
  }
  if (through !== undefined && paragraph !== undefined && through < paragraph) {
    return { ok: false, error: "through は paragraph と同じか、それより後ろの番号にしてください。" };
  }
  return {
    ok: true,
    call: {
      name: TOOL_COPY_FORMAT,
      args: {
        quote,
        ...(from === undefined ? {} : { from }),
        ...(paragraphs ? { paragraphs } : {}),
        ...(paragraph === undefined || paragraphs ? {} : { paragraph }),
        ...(through === undefined || paragraphs ? {} : { through }),
        ...(select ? { select } : {}),
        ...(what === undefined ? {} : { what }),
      },
    },
  };
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

function parseDeleteMatching(row: Record<string, unknown>): ParsedTool {
  const select = parseSelect(row.select);
  if (isArgError(select)) {
    return { ok: false, error: select.error };
  }
  return { ok: true, call: { name: TOOL_DELETE_MATCHING, args: { select } } };
}

function blocksOf(raw: unknown): DraftBlock[] | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "blocks が配列ではありません。" };
  }
  const blocks: DraftBlock[] = [];
  for (const item of raw) {
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
        error:
          "blocks の text が空です。空行は insert_blank_before に、その段落の番号を渡してください。",
      };
    }
    blocks.push(block);
  }
  if (!blocks.length) {
    return { error: "blocks に有効な段落がありません。type と text を入れてください。" };
  }
  return blocks;
}

function parseReplaceParagraphs(row: Record<string, unknown>): ParsedTool {
  const paragraph = paragraphOf(row);
  if (isArgError(paragraph)) {
    return { ok: false, error: paragraph.error };
  }
  const through = throughOf(row);
  if (isArgError(through)) {
    return { ok: false, error: through.error };
  }
  if (paragraph === undefined || through === undefined) {
    return {
      ok: false,
      error: "paragraph と through に、消す範囲の最初と最後の段落番号を入れてください。",
    };
  }
  if (through < paragraph) {
    return { ok: false, error: "through は paragraph 以上の段落番号にしてください。" };
  }
  const blocks = blocksOf(row.blocks);
  if (isArgError(blocks)) {
    return { ok: false, error: blocks.error };
  }
  return { ok: true, call: { name: TOOL_REPLACE_PARAGRAPHS, args: { paragraph, through, blocks } } };
}

function parseDeleteShape(row: Record<string, unknown>): ParsedTool {
  // A lone `shape` is the older single-box form, still sent from history.
  const raw = row.shapes ?? (row.shape === undefined || row.shape === "" ? undefined : [row.shape]);
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "shapes に、図形節の [図1] の数字を 1 つ以上入れてください。" };
  }
  const shapes: number[] = [];
  for (const item of raw) {
    const shape = paragraphNumber(item);
    if (shape === undefined) {
      return { ok: false, error: "shapes は図形節の [図1] の数字（1 以上の整数）の配列にしてください。" };
    }
    if (!shapes.includes(shape)) {
      shapes.push(shape);
    }
  }
  return { ok: true, call: { name: TOOL_DELETE_SHAPE, args: { shapes } } };
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
      const at = insertAtOf(row);
      if (typeof at === "object") {
        return { ok: false, error: at.error };
      }
      const paragraph = paragraphOf(row);
      if (isArgError(paragraph)) {
        return { ok: false, error: paragraph.error };
      }
      const quote = text(row, "quote").trim();
      const blocks = blocksOf(row.blocks);
      if (isArgError(blocks)) {
        return { ok: false, error: blocks.error };
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
      const address = formatAddress(row);
      if (isArgError(address)) {
        return { ok: false, error: address.error };
      }
      const fields = readTextFormat(row);
      if (isArgError(fields)) {
        return { ok: false, error: fields.error };
      }
      if (!hasTextFormat(fields)) {
        return { ok: false, error: "変更する書式が指定されていません。" };
      }
      return { ok: true, call: { name: TOOL_FORMAT_TEXT, args: { ...address, ...omitEmptyFormat(fields) } } };
    }
    case TOOL_FORMAT_PARAGRAPH: {
      const address = formatAddress(row);
      if (isArgError(address)) {
        return { ok: false, error: address.error };
      }
      const fields = readParagraphFormat(row);
      if (isArgError(fields)) {
        return { ok: false, error: fields.error };
      }
      if (!hasParagraphFormat(fields)) {
        return { ok: false, error: "変更する書式が指定されていません。" };
      }
      return {
        ok: true,
        call: { name: TOOL_FORMAT_PARAGRAPH, args: { ...address, ...omitEmptyFormat(fields) } },
      };
    }
    case TOOL_APPLY_FORMAT:
      return parseApplyFormat(row);
    case TOOL_REPLACE_ALL:
      return parseReplaceAll(row);
    case TOOL_COPY_FORMAT:
      return parseCopyFormat(row);
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
    case TOOL_DELETE_MATCHING:
      return parseDeleteMatching(row);
    case TOOL_DELETE_SHAPE:
      return parseDeleteShape(row);
    case TOOL_REPLACE_PARAGRAPHS:
      return parseReplaceParagraphs(row);
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

function textFormatParts(args: TextFormatFields): string[] {
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

function formatSpanLabel(args: {
  paragraph?: number;
  through?: number;
  paragraphs?: number[];
}): string {
  if (args.paragraphs && args.paragraphs.length > 1) {
    return `（${args.paragraphs.length} 段落）`;
  }
  if (args.paragraphs && args.paragraphs.length === 1) {
    return `（段落 ${args.paragraphs[0]}）`;
  }
  if (args.through !== undefined && args.paragraph !== undefined) {
    return `（段落 ${args.paragraph}〜${args.through}）`;
  }
  return "";
}

function paragraphFormatParts(args: ParagraphFormatFields): string[] {
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
      return `文字書式: ${textFormatParts(call.args).join("・")}${formatSpanLabel(call.args)}`;
    case TOOL_FORMAT_PARAGRAPH:
      return `段落書式: ${paragraphFormatParts(call.args).join("・")}${formatSpanLabel(call.args)}`;
    case TOOL_APPLY_FORMAT: {
      const parts = [
        ...textFormatParts(call.args.format),
        ...paragraphFormatParts(call.args.format),
      ];
      return `条件で書式: ${parts.join("・")}`;
    }
    case TOOL_REPLACE_ALL:
      return call.args.replace === undefined
        ? `一括書式「${shorten(call.args.find, 12)}」`
        : `一括置換「${shorten(call.args.find, 12)}」`;
    case TOOL_COPY_FORMAT: {
      const dest = call.args.paragraphs
        ? `${call.args.paragraphs.length} 段落`
        : call.args.through !== undefined && call.args.paragraph !== undefined
          ? `段落 ${call.args.paragraph}〜${call.args.through}`
          : "条件に合う段落";
      const from = call.args.from !== undefined ? `段落 ${call.args.from} から` : "見本から";
      return `${from} ${dest}へ書式を写す`;
    }
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
    case TOOL_DELETE_MATCHING:
      return "条件に合う段落を削除";
    case TOOL_DELETE_PARAGRAPHS: {
      const numbers = call.args.paragraphs;
      const follows = call.args.follows !== undefined ? `（段落 ${call.args.follows} の次）` : "";
      if (numbers.length === 1) {
        return `段落 ${numbers[0]} を削除${follows}`;
      }
      return `${numbers.length} 段落を削除${follows}`;
    }
    case TOOL_DELETE_SHAPE:
      return `${call.args.shapes.map((shape) => `図${shape}`).join("、")} を削除`;
    case TOOL_REPLACE_PARAGRAPHS:
      return `段落 ${call.args.paragraph}〜${call.args.through} を ${call.args.blocks.length} 段落に置き換え`;
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
