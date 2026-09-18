import { mapBlocks, summarizeInsertedBlocks } from "../../shared/blocks";
import { foreignCharToolError } from "../../shared/japaneseHan";
import {
  TOOL_FORMAT_PARAGRAPH,
  TOOL_FORMAT_TEXT,
  TOOL_GET_SELECTION,
  TOOL_INSERT_BLOCKS,
  TOOL_INSERT_CITATION,
  TOOL_INSERT_COMMENT,
  TOOL_REPLACE_QUOTE,
  TOOL_REPLACE_SELECTION,
  TOOL_SEARCH,
  TOOL_SEARCH_INDEX,
  ToolCall,
  parseToolArguments,
} from "../../shared/tools";
import { search, searchArgosIndex } from "../api";
import { Settings } from "../settings";
import {
  formatParagraph,
  formatText,
  getSelectionInfo,
  insertCitationComment,
  insertCitationText,
  insertComment,
  insertDraftParagraphs,
  replaceQuote,
  replaceSelection,
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
};

export type ExecuteOptions = {
  argosPathPrefixes?: string[];
};

function failed(message: string): ToolOutcome {
  return { content: `エラー: ${message}`, ok: false };
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

      case TOOL_REPLACE_SELECTION:
        await replaceSelection(invocation.args.text);
        return { content: "選択範囲を置き換えました（変更履歴に記録）。", ok: true };

      case TOOL_REPLACE_QUOTE:
        await replaceQuote(invocation.args.quote, invocation.args.text);
        return { content: "該当箇所を置き換えました（変更履歴に記録）。", ok: true };

      case TOOL_INSERT_BLOCKS: {
        const specs = mapBlocks(invocation.args.blocks, {
          fontName: settings.fontName,
          bodyPt: settings.bodyPt,
          titlePt: settings.titlePt,
        });
        const at = invocation.args.at ?? (insertBlocksInTurn > 0 ? "continue" : "cursor");
        insertBlocksInTurn += 1;
        const landing = await insertDraftParagraphs(specs, at, invocation.args.quote);
        return {
          content: `${summarizeInsertedBlocks(invocation.args.blocks, landing)}（変更履歴に記録）。`,
          ok: true,
        };
      }

      case TOOL_INSERT_COMMENT:
        await insertComment(
          invocation.args.comment,
          invocation.args.quote,
          invocation.args.severity
        );
        return { content: "コメントを付けました。", ok: true };

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

      case TOOL_FORMAT_TEXT:
        await formatText(invocation.args);
        return { content: "文字書式を変えました（変更履歴に書式変更として記録）。", ok: true };

      case TOOL_FORMAT_PARAGRAPH:
        await formatParagraph(invocation.args);
        return { content: "段落書式を変えました（変更履歴に書式変更として記録）。", ok: true };

      default:
        return failed(`${call.function.name} は実行できません。`);
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : "Word の操作に失敗しました。");
  }
}
