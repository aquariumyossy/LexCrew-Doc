import { describe, expect, it } from "vitest";
import {
  TOOL_FORMAT_PARAGRAPH,
  TOOL_FORMAT_TEXT,
  TOOL_FORMAT_LIST,
  TOOL_SET_OUTLINE,
  TOOL_DELETE_PARAGRAPHS,
  TOOL_FIND_IN_DOCUMENT,
  TOOL_INSERT_BLANK_BEFORE,
  TOOL_INSERT_BLOCKS,
  TOOL_INSERT_COMMENT,
  TOOL_READ_INDEXED_FILE,
  TOOL_READ_PARAGRAPHS,
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
    expect(names).toContain("format_list");
    expect(names).toContain("set_outline_level");
  });

  it("says line spacing drops the line grid so a tighter value can show", () => {
    const tool = buildTools().find((item) => item.function.name === TOOL_FORMAT_PARAGRAPH);
    expect(tool?.function.description).toContain("行グリッド");
    expect(tool?.function.description).toContain("自動");
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
    expect(required(false, TOOL_FORMAT_LIST)).toEqual(["action", "quote"]);
    expect(required(true, TOOL_FORMAT_LIST)).toEqual(["action"]);
    expect(required(false, TOOL_SET_OUTLINE)).toEqual(["action", "quote"]);
    expect(required(true, TOOL_SET_OUTLINE)).toEqual(["action"]);
  });

  it("asks for a paragraph number once the body was attached numbered", () => {
    const tool = (name: string) =>
      buildTools({ selection: false, numbered: true }).find((t) => t.function.name === name)
        ?.function.parameters;

    expect(tool(TOOL_INSERT_COMMENT)?.required).toEqual(["comment", "paragraph"]);
    expect(tool(TOOL_FORMAT_TEXT)?.required).toEqual(["paragraph"]);
    expect(tool(TOOL_FORMAT_LIST)?.required).toEqual(["action", "paragraph"]);
    expect(tool(TOOL_SET_OUTLINE)?.required).toEqual(["action", "paragraph"]);
    expect(tool(TOOL_REPLACE_QUOTE)?.required).toEqual(["paragraph", "text"]);
    const properties = tool(TOOL_INSERT_COMMENT)?.properties as Record<string, unknown>;
    expect(properties.paragraph).toBeDefined();
    expect(properties.quote).toBeDefined();
  });

  it("does not offer numbers when the body was not numbered, so none get invented", () => {
    const properties = (numbered: boolean) =>
      buildTools({ selection: true, numbered }).find(
        (tool) => tool.function.name === TOOL_INSERT_COMMENT
      )?.function.parameters.properties as Record<string, unknown>;

    expect(properties(false).paragraph).toBeUndefined();
    expect(properties(true).paragraph).toBeDefined();
  });

  it("offers the numbers an insert handed out, next to the quote the rest still needs", () => {
    const tool = (name: string) =>
      buildTools({ selection: false, numbered: false, insertedNumbers: true }).find(
        (t) => t.function.name === name
      )?.function.parameters;

    const properties = tool(TOOL_FORMAT_LIST)?.properties as Record<string, unknown>;
    expect(properties.paragraph).toBeDefined();
    expect(properties.quote).toBeDefined();
    expect(properties.through).toBeDefined();
    // Neither is required: inserted paragraphs have numbers, older ones only quotes.
    expect(tool(TOOL_FORMAT_LIST)?.required).toEqual(["action"]);
    expect(tool(TOOL_INSERT_COMMENT)?.required).toEqual(["comment"]);
    const insert = tool("insert_blocks")?.properties as Record<string, unknown>;
    expect(insert.paragraph).toBeDefined();
    expect(tool(TOOL_INSERT_BLANK_BEFORE)?.required).toEqual(["paragraphs"]);
  });

  it("offers blank lines only when a paragraph number exists to point with", () => {
    const names = (options: { numbered?: boolean; insertedNumbers?: boolean }) =>
      buildTools({ selection: false, ...options }).map((tool) => tool.function.name);
    expect(names({})).not.toContain(TOOL_INSERT_BLANK_BEFORE);
    expect(names({})).not.toContain(TOOL_DELETE_PARAGRAPHS);
    expect(names({})).toContain(TOOL_READ_PARAGRAPHS);
    expect(names({})).toContain(TOOL_FIND_IN_DOCUMENT);
    expect(names({ numbered: true })).toContain(TOOL_INSERT_BLANK_BEFORE);
    expect(names({ numbered: true })).toContain(TOOL_DELETE_PARAGRAPHS);
    expect(names({ insertedNumbers: true })).toContain(TOOL_INSERT_BLANK_BEFORE);
    const description = buildTools({ numbered: true }).find(
      (tool) => tool.function.name === TOOL_INSERT_BLANK_BEFORE
    )?.function.description;
    expect(description).toContain("第N条");
    expect(description).toContain("〔第N条〕");
    expect(description).toContain("民法第415条");
  });

  it("makes replace_quote point somewhere even when a selection exists", () => {
    const required = (numbered: boolean) =>
      buildTools({ selection: true, numbered }).find(
        (tool) => tool.function.name === TOOL_REPLACE_QUOTE
      )?.function.parameters.required;

    expect(required(false)).toEqual(["quote", "text"]);
    expect(required(true)).toEqual(["paragraph", "text"]);
  });

  it("includes search and citation when SearXNG is configured", () => {
    const names = buildTools({ search: true }).map((tool) => tool.function.name);
    expect(names).toContain("search");
    expect(names).toContain("insert_citation");
    expect(names).not.toContain("search_index");
    expect(names).not.toContain("read_indexed_file");
  });

  it("includes search_index and citation when Argos is configured", () => {
    const names = buildTools({ argos: true }).map((tool) => tool.function.name);
    expect(names).toContain("search_index");
    expect(names).toContain("read_indexed_file");
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

  it("rejects a full read that does not say where to start", () => {
    const result = parseToolArguments(TOOL_READ_PARAGRAPHS, '{"view":"full"}');
    expect(result.ok).toBe(false);
  });

  it("rejects a find that is too long for Word", () => {
    const result = parseToolArguments(TOOL_FIND_IN_DOCUMENT, JSON.stringify({ q: "あ".repeat(256) }));
    expect(result.ok).toBe(false);
  });

  it("reads an indexed file only from a path and a non-negative offset", () => {
    expect(parseToolArguments(TOOL_READ_INDEXED_FILE, '{"path":"  "}').ok).toBe(false);
    expect(parseToolArguments(TOOL_READ_INDEXED_FILE, '{"path":"C:\\\\a.txt","offset":-1}').ok).toBe(
      false
    );
    expect(parseToolArguments(TOOL_READ_INDEXED_FILE, '{"path":"C:\\\\a.txt","offset":0}')).toEqual({
      ok: true,
      call: { name: TOOL_READ_INDEXED_FILE, args: { path: "C:\\a.txt", offset: 0 } },
    });
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

  it("takes a paragraph number in place of the quote", () => {
    const result = parseToolArguments(TOOL_REPLACE_QUOTE, '{"paragraph":12,"text":"乙"}');
    expect(result).toEqual({
      ok: true,
      call: { name: TOOL_REPLACE_QUOTE, args: { quote: "", text: "乙", paragraph: 12 } },
    });
  });

  it("refuses a replace that points at nothing at all", () => {
    const result = parseToolArguments(TOOL_REPLACE_QUOTE, '{"text":"乙"}');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/paragraph/);
  });

  it("rejects a paragraph number that cannot be an address", () => {
    for (const args of ['{"comment":"確認","paragraph":0}', '{"comment":"確認","paragraph":2.5}']) {
      const result = parseToolArguments(TOOL_INSERT_COMMENT, args);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/1 以上の整数/);
    }
  });

  it("reads a number the model sent as a string, which some servers do", () => {
    const result = parseToolArguments(TOOL_INSERT_COMMENT, '{"comment":"確認","paragraph":"12"}');
    expect(result.ok === true && result.call.args).toMatchObject({ paragraph: 12 });
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

  it("rejects a blank block and points at insert_blank_before", () => {
    const result = parseToolArguments(
      TOOL_INSERT_BLOCKS,
      '{"blocks":[{"type":"body","text":"第1条"},{"type":"body","text":" "}]}'
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("insert_blank_before");
  });

  it("parses the paragraphs a blank line goes before", () => {
    const result = parseToolArguments(TOOL_INSERT_BLANK_BEFORE, '{"paragraphs":[2,"4",2]}');
    expect(result).toEqual({
      ok: true,
      call: { name: TOOL_INSERT_BLANK_BEFORE, args: { paragraphs: [2, 4, 2] } },
    });
    expect(parseToolArguments(TOOL_INSERT_BLANK_BEFORE, '{"paragraphs":[]}').ok).toBe(false);
    expect(parseToolArguments(TOOL_INSERT_BLANK_BEFORE, '{"paragraphs":[0]}').ok).toBe(false);
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

  it("keeps paragraph spacing of zero, which is how the model packs lines", () => {
    const result = parseToolArguments(
      TOOL_FORMAT_PARAGRAPH,
      '{"quote":"甲","spaceBefore":0,"spaceAfter":0}'
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.call.name === TOOL_FORMAT_PARAGRAPH) {
      expect(result.call.args.spaceBefore).toBe(0);
      expect(result.call.args.spaceAfter).toBe(0);
    }
  });

  it("rejects negative paragraph spacing", () => {
    expect(parseToolArguments(TOOL_FORMAT_PARAGRAPH, '{"spaceBefore":-1}').ok).toBe(false);
    expect(parseToolArguments(TOOL_FORMAT_PARAGRAPH, '{"spaceAfter":-2}').ok).toBe(false);
  });

  it("parses format_list apply with a span", () => {
    const result = parseToolArguments(
      TOOL_FORMAT_LIST,
      '{"action":"apply","paragraph":12,"through":14,"style":"paren"}'
    );
    expect(result).toEqual({
      ok: true,
      call: {
        name: TOOL_FORMAT_LIST,
        args: {
          action: "apply",
          quote: "",
          paragraph: 12,
          through: 14,
          style: "paren",
        },
      },
    });
  });

  it("treats action continue as apply that joins the previous list", () => {
    const result = parseToolArguments(
      TOOL_FORMAT_LIST,
      '{"action":"continue","paragraph":45,"style":"continue"}'
    );
    expect(result).toEqual({
      ok: true,
      call: {
        name: TOOL_FORMAT_LIST,
        args: {
          action: "apply",
          quote: "",
          paragraph: 45,
          style: "continue",
        },
      },
    });
  });

  it("parses Japanese list styles", () => {
    const result = parseToolArguments(
      TOOL_FORMAT_LIST,
      '{"action":"apply","paragraph":3,"style":"dai"}'
    );
    expect(result).toEqual({
      ok: true,
      call: {
        name: TOOL_FORMAT_LIST,
        args: { action: "apply", quote: "", paragraph: 3, style: "dai" },
      },
    });
    expect(parseToolArguments(TOOL_FORMAT_LIST, '{"action":"apply","style":"kanji"}').ok).toBe(
      false
    );
  });

  it("parses start, which begins the count again at a 条", () => {
    const result = parseToolArguments(
      TOOL_FORMAT_LIST,
      '{"action":"apply","paragraph":7,"style":"arabicFull","start":true}'
    );
    expect(result).toEqual({
      ok: true,
      call: {
        name: TOOL_FORMAT_LIST,
        args: { action: "apply", quote: "", paragraph: 7, style: "arabicFull", start: true },
      },
    });
  });

  it("refuses start without a style, since continue is the previous count", () => {
    expect(parseToolArguments(TOOL_FORMAT_LIST, '{"action":"apply","paragraph":7,"start":true}').ok).toBe(
      false
    );
    expect(
      parseToolArguments(
        TOOL_FORMAT_LIST,
        '{"action":"continue","paragraph":7,"style":"continue","start":true}'
      ).ok
    ).toBe(false);
  });

  it("lets a span start at a quoted paragraph, and refuses one that starts nowhere", () => {
    const fromQuote = parseToolArguments(
      TOOL_FORMAT_LIST,
      '{"action":"apply","quote":"品名　○○","through":7,"style":"parenFull","level":1}'
    );
    expect(fromQuote.ok).toBe(true);
    const nowhere = parseToolArguments(TOOL_FORMAT_LIST, '{"action":"apply","through":7}');
    expect(nowhere).toMatchObject({ ok: false, error: expect.stringMatching(/paragraph（または quote）/) });
  });

  it("refuses restart with a style or a span", () => {
    expect(
      parseToolArguments(TOOL_FORMAT_LIST, '{"action":"restart","paragraph":12,"style":"arabic"}')
        .ok
    ).toBe(false);
    expect(
      parseToolArguments(TOOL_FORMAT_LIST, '{"action":"restart","paragraph":12,"through":14}').ok
    ).toBe(false);
  });

  it("refuses a through that sits before the start", () => {
    const result = parseToolArguments(
      TOOL_FORMAT_LIST,
      '{"action":"apply","paragraph":14,"through":12}'
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/後ろ/);
  });

  it("parses set_outline_level and refuses a clear that also carries a level", () => {
    const set = parseToolArguments(
      TOOL_SET_OUTLINE,
      '{"action":"set","paragraph":12,"through":14,"level":2}'
    );
    expect(set).toEqual({
      ok: true,
      call: {
        name: TOOL_SET_OUTLINE,
        args: { action: "set", quote: "", paragraph: 12, through: 14, level: 2 },
      },
    });
    expect(parseToolArguments(TOOL_SET_OUTLINE, '{"action":"set","paragraph":12}').ok).toBe(false);
    expect(parseToolArguments(TOOL_SET_OUTLINE, '{"action":"clear","paragraph":12,"level":1}').ok).toBe(
      false
    );
    expect(parseToolArguments(TOOL_SET_OUTLINE, '{"action":"set","paragraph":12,"level":0}').ok).toBe(
      false
    );
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

  it("shows the paragraph the model pointed at, so the chip is checkable", () => {
    expect(describeToolCall(TOOL_INSERT_COMMENT, '{"comment":"確認","paragraph":12}')).toBe(
      "段落 12 にコメント"
    );
    expect(describeToolCall(TOOL_REPLACE_QUOTE, '{"paragraph":12,"text":"乙"}')).toBe(
      "段落 12 を置換"
    );
    expect(
      describeToolCall(
        TOOL_INSERT_BLOCKS,
        '{"paragraph":12,"blocks":[{"type":"body","text":"あ"}]}'
      )
    ).toBe("段落 12 の後ろに 1 段落を挿入");
    expect(describeToolCall(TOOL_INSERT_BLANK_BEFORE, '{"paragraphs":[4]}')).toBe(
      "段落 4 の直前に空行"
    );
    expect(describeToolCall(TOOL_INSERT_BLANK_BEFORE, '{"paragraphs":[4,9]}')).toBe(
      "2 段落の直前に空行"
    );
  });

  it("spells out the formatting that was applied", () => {
    expect(describeToolCall(TOOL_FORMAT_TEXT, '{"bold":true,"size":12}')).toBe(
      "文字書式: 太字・12pt"
    );
    expect(describeToolCall(TOOL_FORMAT_PARAGRAPH, '{"alignment":"center"}')).toBe(
      "段落書式: 中央揃え"
    );
    expect(describeToolCall(TOOL_FORMAT_PARAGRAPH, '{"spaceBefore":0,"spaceAfter":0}')).toBe(
      "段落書式: 段落前 0pt・段落後 0pt"
    );
    expect(
      describeToolCall(TOOL_FORMAT_PARAGRAPH, '{"leftIndent":36,"firstLineIndent":-24}')
    ).toBe("段落書式: ぶら下げ 24pt・左インデント 36pt");
    expect(describeToolCall(TOOL_FORMAT_PARAGRAPH, '{"firstLineIndent":12}')).toBe(
      "段落書式: 字下げ 12pt"
    );
    expect(describeToolCall(TOOL_FORMAT_LIST, '{"action":"apply","paragraph":12}')).toBe(
      "段落 12 に番号を付ける"
    );
    expect(
      describeToolCall(TOOL_FORMAT_LIST, '{"action":"remove","paragraph":12,"through":14}')
    ).toBe("番号を外す（段落 12〜14）");
    expect(describeToolCall(TOOL_FORMAT_LIST, '{"action":"restart","paragraph":12}')).toBe(
      "段落 12 に番号を1から"
    );
    expect(
      describeToolCall(TOOL_FORMAT_LIST, '{"action":"apply","paragraph":12,"style":"dai"}')
    ).toBe("段落 12 に番号を付ける（dai）");
    expect(describeToolCall(TOOL_SET_OUTLINE, '{"action":"set","paragraph":12,"level":1}')).toBe(
      "段落 12 に見出し 1"
    );
    expect(
      describeToolCall(TOOL_SET_OUTLINE, '{"action":"clear","paragraph":12,"through":14}')
    ).toBe("見出しを外す（段落 12〜14）");
    expect(describeToolCall(TOOL_READ_PARAGRAPHS, '{"from":12,"view":"marks"}')).toBe(
      "段落 12 を読む（番号一覧）"
    );
    expect(describeToolCall(TOOL_FIND_IN_DOCUMENT, '{"q":"第6条を準用する"}')).toBe(
      "文書内「第6条を準用する」"
    );
    expect(describeToolCall(TOOL_DELETE_PARAGRAPHS, '{"paragraphs":[14]}')).toBe(
      "段落 14 を削除"
    );
    expect(
      describeToolCall(TOOL_READ_INDEXED_FILE, '{"path":"C:\\\\案件\\\\委託基本契約書.docx"}')
    ).toBe("資料を読む「C:\\案件\\委託基本契約書.docx」");
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
