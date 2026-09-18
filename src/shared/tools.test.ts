import { describe, expect, it } from "vitest";
import {
  TOOL_FORMAT_PARAGRAPH,
  TOOL_FORMAT_TEXT,
  TOOL_INSERT_BLOCKS,
  TOOL_INSERT_COMMENT,
  TOOL_REPLACE_QUOTE,
  TOOL_SEARCH,
  TOOL_SEARCH_INDEX,
  buildTools,
  describeToolCall,
  isToolsUnsupportedError,
  normalizeMaxToolRounds,
  normalizeToolCalls,
  parseToolArguments,
  toolRoundLimitNotice,
  toolRoundPresetLabel,
  UNLIMITED_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS,
  MAX_MAX_TOOL_ROUNDS,
} from "./tools";

describe("buildTools", () => {
  it("omits the search pair when SearXNG is not configured", () => {
    const names = buildTools({ search: false }).map((tool) => tool.function.name);
    expect(names).not.toContain("search");
    expect(names).not.toContain("insert_citation");
    expect(names).toContain("replace_quote");
    expect(names).toContain("format_text");
  });

  it("holds back the selection tools until something is selected", () => {
    const without = buildTools({ selection: false }).map((tool) => tool.function.name);
    expect(without).not.toContain("get_selection");
    expect(without).not.toContain("replace_selection");
    // These reach text by quote, so they work with no selection at all.
    expect(without).toContain("replace_quote");
    expect(without).toContain("insert_blocks");

    const with_ = buildTools({ selection: true }).map((tool) => tool.function.name);
    expect(with_).toContain("get_selection");
    expect(with_).toContain("replace_selection");
  });

  it("requires a quote where the selection used to stand in for one", () => {
    const required = (selection: boolean, name: string) =>
      buildTools({ selection }).find((tool) => tool.function.name === name)?.function.parameters
        .required;

    expect(required(false, TOOL_INSERT_COMMENT)).toEqual(["comment", "quote"]);
    expect(required(true, TOOL_INSERT_COMMENT)).toEqual(["comment"]);
    expect(required(false, TOOL_FORMAT_TEXT)).toEqual(["quote"]);
    expect(required(true, TOOL_FORMAT_TEXT)).toBeUndefined();
    expect(required(false, TOOL_FORMAT_PARAGRAPH)).toEqual(["quote"]);
    expect(required(true, TOOL_FORMAT_PARAGRAPH)).toBeUndefined();
  });

  it("includes search and citation when SearXNG is configured", () => {
    const names = buildTools({ search: true }).map((tool) => tool.function.name);
    expect(names).toContain("search");
    expect(names).toContain("insert_citation");
    expect(names).not.toContain("search_index");
  });

  it("includes search_index and citation when Argos is configured", () => {
    const names = buildTools({ argos: true }).map((tool) => tool.function.name);
    expect(names).toContain("search_index");
    expect(names).toContain("insert_citation");
    expect(names).not.toContain("search");
  });
});

describe("parseToolArguments", () => {
  it("rejects malformed JSON so the model can retry", () => {
    const result = parseToolArguments(TOOL_SEARCH, "{not json");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/JSON/);
  });

  it("rejects unknown tool names", () => {
    const result = parseToolArguments("delete_everything", "{}");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("delete_everything");
  });

  it("parses search arguments", () => {
    const result = parseToolArguments(TOOL_SEARCH, '{"q":"民法 第415条"}');
    expect(result).toEqual({ ok: true, call: { name: TOOL_SEARCH, args: { q: "民法 第415条" } } });
  });

  it("parses search_index arguments", () => {
    const result = parseToolArguments(TOOL_SEARCH_INDEX, '{"q":"民法 555条"}');
    expect(result).toEqual({
      ok: true,
      call: { name: TOOL_SEARCH_INDEX, args: { q: "民法 555条" } },
    });
  });

  it("requires both quote and text for replace_quote", () => {
    expect(parseToolArguments(TOOL_REPLACE_QUOTE, '{"quote":"甲"}').ok).toBe(false);
    const result = parseToolArguments(TOOL_REPLACE_QUOTE, '{"quote":"甲","text":"乙"}');
    expect(result).toEqual({
      ok: true,
      call: { name: TOOL_REPLACE_QUOTE, args: { quote: "甲", text: "乙" } },
    });
  });

  it("defaults comment severity to medium and allows an empty quote", () => {
    const result = parseToolArguments(TOOL_INSERT_COMMENT, '{"comment":"確認してください"}');
    expect(result).toEqual({
      ok: true,
      call: {
        name: TOOL_INSERT_COMMENT,
        args: { comment: "確認してください", quote: "", severity: "medium" },
      },
    });
  });

  it("drops malformed blocks but keeps usable ones", () => {
    const result = parseToolArguments(
      TOOL_INSERT_BLOCKS,
      '{"blocks":[{"type":"title","text":"訴　状"},"nope",{"text":"本文"}]}'
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.call.name === TOOL_INSERT_BLOCKS) {
      expect(result.call.args.blocks).toEqual([
        { type: "title", text: "訴　状", label: undefined },
        { type: "body", text: "本文", label: undefined },
      ]);
      expect(result.call.args.at).toBeUndefined();
    }
  });

  it("accepts at=end for a split draft continuation", () => {
    const result = parseToolArguments(
      TOOL_INSERT_BLOCKS,
      '{"at":"end","blocks":[{"type":"clause","text":"支払う。","label":"第7条"}]}'
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.call.name === TOOL_INSERT_BLOCKS) {
      expect(result.call.args.at).toBe("end");
    }
  });

  it("keeps a quote so the blocks can go after a named clause", () => {
    const result = parseToolArguments(
      TOOL_INSERT_BLOCKS,
      '{"quote":"前二項による解除は、","blocks":[{"type":"clause","text":"反社会的勢力の排除","label":"第14条"}]}'
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.call.name === TOOL_INSERT_BLOCKS) {
      expect(result.call.args.quote).toBe("前二項による解除は、");
      expect(result.call.args.at).toBeUndefined();
    }
  });

  it("accepts at=continue so a split draft follows the previous chunk", () => {
    const result = parseToolArguments(
      TOOL_INSERT_BLOCKS,
      '{"at":"continue","blocks":[{"type":"clause","text":"支払う。","label":"第7条"}]}'
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.call.name === TOOL_INSERT_BLOCKS) {
      expect(result.call.args.at).toBe("continue");
    }
  });

  it("rejects an unknown insert position", () => {
    expect(
      parseToolArguments(
        TOOL_INSERT_BLOCKS,
        '{"at":"start","blocks":[{"type":"body","text":"あ"}]}'
      ).ok
    ).toBe(false);
  });

  it("fails when no formatting field is given", () => {
    expect(parseToolArguments(TOOL_FORMAT_TEXT, '{"quote":"甲"}').ok).toBe(false);
    expect(parseToolArguments(TOOL_FORMAT_PARAGRAPH, "{}").ok).toBe(false);
  });

  it("keeps only the formatting fields that were sent", () => {
    const result = parseToolArguments(TOOL_FORMAT_TEXT, '{"quote":"甲","bold":true,"size":14}');
    expect(result.ok).toBe(true);
    if (result.ok && result.call.name === TOOL_FORMAT_TEXT) {
      expect(result.call.args.bold).toBe(true);
      expect(result.call.args.size).toBe(14);
      expect(result.call.args.italic).toBeUndefined();
    }
  });

  it("rejects a non-positive font size", () => {
    expect(parseToolArguments(TOOL_FORMAT_TEXT, '{"size":0}').ok).toBe(false);
  });

  it("rejects an unknown alignment instead of guessing", () => {
    const result = parseToolArguments(TOOL_FORMAT_PARAGRAPH, '{"alignment":"middle"}');
    expect(result.ok).toBe(false);
  });
});

describe("describeToolCall", () => {
  it("labels the operation in Japanese", () => {
    expect(describeToolCall(TOOL_SEARCH, '{"q":"民法 第415条"}')).toBe("検索「民法 第415条」");
    expect(describeToolCall(TOOL_SEARCH_INDEX, '{"q":"民法 555条"}')).toBe("索引「民法 555条」");
    expect(describeToolCall(TOOL_INSERT_COMMENT, '{"comment":"確認"}')).toBe("コメントを追加");
    expect(describeToolCall(TOOL_INSERT_BLOCKS, '{"blocks":[{"type":"body","text":"あ"}]}')).toBe(
      "1 段落を挿入"
    );
    expect(
      describeToolCall(TOOL_INSERT_BLOCKS, '{"at":"end","blocks":[{"type":"body","text":"あ"}]}')
    ).toBe("1 段落を末尾に挿入");
    expect(
      describeToolCall(
        TOOL_INSERT_BLOCKS,
        '{"at":"continue","blocks":[{"type":"body","text":"あ"}]}'
      )
    ).toBe("1 段落を続きに挿入");
    expect(
      describeToolCall(
        TOOL_INSERT_BLOCKS,
        '{"quote":"前二項による解除は、","blocks":[{"type":"body","text":"あ"}]}'
      )
    ).toBe("「前二項による解除は、」の後ろに 1 段落を挿入");
  });

  it("spells out the formatting that was applied", () => {
    expect(describeToolCall(TOOL_FORMAT_TEXT, '{"bold":true,"size":12}')).toBe(
      "文字書式: 太字・12pt"
    );
    expect(describeToolCall(TOOL_FORMAT_PARAGRAPH, '{"alignment":"center"}')).toBe(
      "段落書式: 中央揃え"
    );
  });

  it("says so when the arguments cannot be read", () => {
    expect(describeToolCall(TOOL_SEARCH, "{broken")).toContain("引数を読めませんでした");
  });
});

describe("isToolsUnsupportedError", () => {
  it("recognises servers without function calling", () => {
    expect(isToolsUnsupportedError("tools is not supported by this model")).toBe(true);
    expect(isToolsUnsupportedError("unknown field: tool_choice")).toBe(true);
  });

  it("leaves unrelated failures alone", () => {
    expect(isToolsUnsupportedError("MTPLX に接続できませんでした。")).toBe(false);
    expect(isToolsUnsupportedError("context length exceeded")).toBe(false);
  });
});

describe("max tool rounds", () => {
  it("treats 0 as unlimited and clamps the rest", () => {
    expect(normalizeMaxToolRounds(undefined)).toBe(MAX_TOOL_ROUNDS);
    expect(normalizeMaxToolRounds(null)).toBe(MAX_TOOL_ROUNDS);
    expect(normalizeMaxToolRounds(-1)).toBe(MAX_TOOL_ROUNDS);
    expect(normalizeMaxToolRounds(UNLIMITED_TOOL_ROUNDS)).toBe(UNLIMITED_TOOL_ROUNDS);
    expect(normalizeMaxToolRounds(2)).toBe(2);
    expect(normalizeMaxToolRounds(9999)).toBe(MAX_MAX_TOOL_ROUNDS);
  });

  it("labels presets and explains a hit cap", () => {
    expect(toolRoundPresetLabel(8)).toBe("8（既定）");
    expect(toolRoundPresetLabel(0)).toBe("制限なし");
    expect(toolRoundLimitNotice(8)).toContain("上限の 8 回");
    expect(toolRoundLimitNotice(8)).toContain("ツール往復の上限");
  });
});

describe("normalizeToolCalls", () => {
  it("keeps well-formed calls and skips the rest", () => {
    const calls = normalizeToolCalls([
      { id: "a1", type: "function", function: { name: "search", arguments: '{"q":"民法"}' } },
      { function: { name: "" } },
      "nope",
      { function: { name: "get_selection" } },
    ]);
    expect(calls).toEqual([
      { id: "a1", type: "function", function: { name: "search", arguments: '{"q":"民法"}' } },
      { id: "call_3", type: "function", function: { name: "get_selection", arguments: "" } },
    ]);
  });

  it("returns an empty list when the field is missing", () => {
    expect(normalizeToolCalls(undefined)).toEqual([]);
  });
});
