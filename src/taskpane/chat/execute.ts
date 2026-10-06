import { mapBlocks, summarizeInsertedBlocks } from "../../shared/blocks";
import { foreignCharToolError } from "../../shared/japaneseHan";
import {
  TOOL_DELETE_PARAGRAPHS,
  TOOL_FIND_IN_DOCUMENT,
  TOOL_FORMAT_LIST,
  TOOL_FORMAT_PARAGRAPH,
  TOOL_FORMAT_TEXT,
  TOOL_GET_SELECTION,
  TOOL_INSERT_BLANK_BEFORE,
  TOOL_INSERT_BLOCKS,
  TOOL_INSERT_CITATION,
  TOOL_INSERT_COMMENT,
  TOOL_READ_INDEXED_FILE,
  TOOL_READ_PARAGRAPHS,
  TOOL_REPLACE_QUOTE,
  TOOL_REPLACE_SELECTION,
  TOOL_SEARCH,
  TOOL_SEARCH_INDEX,
  TOOL_SET_OUTLINE,
  ToolCall,
  parseToolArguments,
} from "../../shared/tools";
import { readArgosFile, search, searchArgosIndex } from "../api";
import { sliceIndexedText } from "../../shared/indexedRead";
import { Settings } from "../settings";
import {
  deleteParagraphs,
  findInDocument,
  formatList,
  formatParagraph,
  formatText,
  getSelectionInfo,
  readParagraphs,
  insertCitationComment,
  insertCitationText,
  insertBlankBefore,
  insertComment,
  insertDraftParagraphs,
  replaceQuote,
  replaceSelection,
  setOutlineLevel,
} from "../word";

/* global AbortSignal */

const MAX_HITS = 5;
const HIT_SNIPPET_CHARS = 300;

/**
 * `insert_blocks` calls in the current user turn. Only picks the default `at`:
 * the first chunk goes to the cursor, later chunks continue from the anchor the
 * previous insert left in the document.
 */
let insertBlocksInTurn = 0;

export function beginToolTurn(): void {
  insertBlocksInTurn = 0;
}

export type ToolOutcome = {
  /** Sent back to the model as the `role: "tool"` content. */
  content: string;
  ok: boolean;
  /** True when the result handed the model paragraph numbers it did not have before. */
  numbered?: boolean;
};

export type ExecuteOptions = {
  argosPathPrefixes?: string[];
  /** Characters this read may return without exceeding the tool-result share. */
  indexedReadChars?: number;
  /** The open document already has body text, so settings are not the default face. */
  hasBody?: boolean;
};

function failed(message: string): ToolOutcome {
  return { content: `エラー: ${message}`, ok: false };
}

/**
 * Where the operation actually landed. A number that pointed at a paragraph the
 * model did not mean, or a quote that widened to the whole paragraph, is invisible
 * in a bare success message and turns up later in the wrong clause.
 */
function withNote(message: string, note: string): string {
  return note ? `${message}${note}` : message;
}

async function runSearch(q: string, settings: Settings, signal: AbortSignal): Promise<ToolOutcome> {
  if (!settings.searxngUrl.trim()) {
    return failed("SearXNG の URL が設定されていません。設定で入れてもらってください。");
  }
  const hits = await search({ searxngUrl: settings.searxngUrl, q }, signal);
  if (!hits.length) {
    return { content: "ヒットなし", ok: true };
  }
  const trimmed = hits.slice(0, MAX_HITS).map((hit) => ({
    title: hit.title,
    url: hit.url,
    content: hit.content.slice(0, HIT_SNIPPET_CHARS),
  }));
  return { content: JSON.stringify(trimmed), ok: true };
}

async function runIndexSearch(
  q: string,
  settings: Settings,
  prefixes: string[],
  signal: AbortSignal
): Promise<ToolOutcome> {
  if (!settings.argosBaseUrl.trim()) {
    return failed(
      "Argos の URL が設定されていません。設定で http://127.0.0.1:17890 を入れてください。"
    );
  }
  const hits = await searchArgosIndex(
    {
      argosBaseUrl: settings.argosBaseUrl,
      argosApiKey: settings.argosApiKey,
      q,
      pathPrefixes: prefixes,
    },
    signal
  );
  if (!hits.length) {
    return { content: "ヒットなし", ok: true };
  }
  const trimmed = hits.slice(0, MAX_HITS).map((hit) => ({
    title: hit.title,
    url: hit.url,
    content: hit.content.slice(0, HIT_SNIPPET_CHARS),
  }));
  return { content: JSON.stringify(trimmed), ok: true };
}

function fileNameOf(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

async function runIndexedRead(
  path: string,
  offset: number,
  settings: Settings,
  limit: number,
  signal: AbortSignal
): Promise<ToolOutcome> {
  if (!settings.argosBaseUrl.trim()) {
    return failed(
      "Argos の URL が設定されていません。設定で http://127.0.0.1:17890 を入れてください。"
    );
  }
  if (limit <= 0) {
    return failed("ツール結果の枠が足りません。この読み取りは次のターンでやり直してください。");
  }
  const file = await readArgosFile({ path }, signal);
  const { readBuffer } = await import("../files/read");
  let read;
  try {
    read = await readBuffer(file.name || fileNameOf(path), file.bytes);
  } catch (error) {
    return failed(error instanceof Error ? error.message : "資料を読めませんでした。");
  }
  if (read.status === "scan") {
    return {
      content: "各ページの文字が少なすぎます。このファイルをチャットに添付すると OCR で読めます。",
      ok: true,
    };
  }
  const note = read.text.truncated ? "抽出は6万字で打ち切っています。\n" : "";
  const sliced = sliceIndexedText(read.text.body, offset, limit - note.length);
  return { content: `${note}${sliced}`, ok: true };
}

/**
 * Run one tool call. Failures come back as tool content rather than exceptions
 * so the model can correct itself within the same turn.
 */
export async function executeToolCall(
  call: ToolCall,
  settings: Settings,
  signal: AbortSignal,
  extras: ExecuteOptions = {}
): Promise<ToolOutcome> {
  const parsed = parseToolArguments(call.function.name, call.function.arguments);
  if (parsed.ok === false) {
    return failed(parsed.error);
  }
  const foreign = foreignCharToolError(parsed.call);
  if (foreign) {
    return failed(foreign);
  }

  try {
    const invocation = parsed.call;
    switch (invocation.name) {
      case TOOL_SEARCH:
        return await runSearch(invocation.args.q, settings, signal);

      case TOOL_SEARCH_INDEX:
        return await runIndexSearch(
          invocation.args.q,
          settings,
          extras.argosPathPrefixes || [],
          signal
        );

      case TOOL_GET_SELECTION: {
        const info = await getSelectionInfo();
        if (!info.text.trim()) {
          return { content: "選択範囲はありません。", ok: true };
        }
        return {
          content: `${info.paragraphs} 段落 / ${info.text.length} 字\n${info.text}`,
          ok: true,
        };
      }

      case TOOL_REPLACE_SELECTION: {
        const note = await replaceSelection(invocation.args.text);
        return { content: withNote("選択範囲を置き換えました（変更履歴に記録）。", note), ok: true };
      }

      case TOOL_REPLACE_QUOTE: {
        const note = await replaceQuote(invocation.args);
        return {
          content: withNote("該当箇所を置き換えました（変更履歴に記録）。", note),
          ok: true,
        };
      }

      case TOOL_INSERT_BLOCKS: {
        const specs = mapBlocks(invocation.args.blocks, {
          fontName: settings.fontName,
          bodyPt: settings.bodyPt,
          titlePt: settings.titlePt,
          lineSpacingChars: settings.lineSpacingChars,
        });
        const at = invocation.args.at ?? (insertBlocksInTurn > 0 ? "continue" : "cursor");
        insertBlocksInTurn += 1;
        const landing = await insertDraftParagraphs(
          specs,
          at,
          invocation.args.quote,
          invocation.args.paragraph,
          {
            hasBody: extras.hasBody === true,
            user: {
              fontName: invocation.args.fontName,
              bodyPt: invocation.args.bodyPt,
              titlePt: invocation.args.titlePt,
              lineSpacingChars: invocation.args.lineSpacingChars,
            },
            settings: {
              fontName: settings.fontName,
              bodyPt: settings.bodyPt,
              titlePt: settings.titlePt,
              lineSpacingChars: settings.lineSpacingChars,
            },
          }
        );
        return {
          content: summarizeInsertedBlocks(invocation.args.blocks, landing),
          ok: true,
          // The new paragraphs now have numbers; the next round's tools must offer them.
          numbered: Boolean(landing?.numbers?.length),
        };
      }

      case TOOL_INSERT_BLANK_BEFORE: {
        const note = await insertBlankBefore(invocation.args.paragraphs);
        return { content: note, ok: true };
      }

      case TOOL_INSERT_COMMENT: {
        const note = await insertComment(invocation.args);
        return { content: withNote("コメントを付けました。", note), ok: true };
      }

      case TOOL_INSERT_CITATION: {
        const hit = {
          title: invocation.args.title,
          url: invocation.args.url,
          content: invocation.args.snippet,
        };
        if (invocation.args.as === "text") {
          await insertCitationText(hit);
          return { content: "出典を本文に入れました（変更履歴に記録）。", ok: true };
        }
        await insertCitationComment(hit);
        return { content: "出典をコメントに入れました。", ok: true };
      }

      case TOOL_FORMAT_TEXT: {
        const note = await formatText(invocation.args);
        return {
          content: withNote("文字書式を変えました（変更履歴に書式変更として記録）。", note),
          ok: true,
        };
      }

      case TOOL_FORMAT_PARAGRAPH: {
        const note = await formatParagraph(invocation.args);
        return {
          content: withNote("段落書式を変えました（変更履歴に書式変更として記録）。", note),
          ok: true,
        };
      }

      case TOOL_FORMAT_LIST: {
        const note = await formatList(invocation.args);
        return {
          content: withNote("リスト番号を変えました（変更履歴に書式変更として記録）。", note),
          ok: true,
        };
      }

      case TOOL_SET_OUTLINE: {
        const note = await setOutlineLevel(invocation.args);
        return { content: note, ok: true };
      }

      case TOOL_READ_PARAGRAPHS: {
        const read = await readParagraphs(invocation.args);
        return { content: read.text, ok: true, numbered: read.numbered };
      }

      case TOOL_FIND_IN_DOCUMENT: {
        const read = await findInDocument(invocation.args);
        return { content: read.text, ok: true, numbered: read.numbered };
      }

      case TOOL_DELETE_PARAGRAPHS: {
        const note = await deleteParagraphs(invocation.args);
        return { content: note, ok: true };
      }

      case TOOL_READ_INDEXED_FILE:
        return await runIndexedRead(
          invocation.args.path,
          invocation.args.offset ?? 0,
          settings,
          extras.indexedReadChars ?? 0,
          signal
        );

      default:
        return failed(`${call.function.name} は実行できません。`);
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : "Word の操作に失敗しました。");
  }
}
