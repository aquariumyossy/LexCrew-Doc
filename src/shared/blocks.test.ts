import { describe, expect, it } from "vitest";
import {
  DraftBlock,
  InsertPlacement,
  mapBlockToParagraph,
  mapBlocks,
  normalizeBlock,
  specPlainText,
  summarizeInsertedBlocks,
} from "./blocks";
import {
  DEFAULT_BODY_PT,
  DEFAULT_FONT_NAME,
  DEFAULT_TITLE_PT,
  FALLBACK_FONT_NAME,
} from "./constants";

describe("normalizeBlock", () => {
  it("keeps known types and treats unknown types as body", () => {
    expect(normalizeBlock({ type: "title", text: "業務委託契約書" })?.type).toBe("title");
    expect(normalizeBlock({ type: "table", text: "表は将来" })?.type).toBe("body");
  });

  it("returns null when there is no text", () => {
    expect(normalizeBlock({ type: "title" })).toBeNull();
  });

  it("drops a blank label", () => {
    expect(
      normalizeBlock({ type: "clause", text: "秘密を守る。", label: "  " })?.label
    ).toBeUndefined();
  });
});

describe("mapBlockToParagraph", () => {
  const opts = { fontName: DEFAULT_FONT_NAME, bodyPt: DEFAULT_BODY_PT, titlePt: DEFAULT_TITLE_PT };

  it("maps title to centered bold 16pt", () => {
    const spec = mapBlockToParagraph({ type: "title", text: "訴状" }, opts);
    expect(spec.alignment).toBe("center");
    expect(spec.bold).toBe(true);
    expect(spec.fontSize).toBe(16);
    expect(spec.firstLineIndentPt).toBe(0);
    expect(specPlainText(spec)).toBe("訴状");
  });

  it("maps heading to left bold body size", () => {
    const spec = mapBlockToParagraph({ type: "heading", text: "請求の趣旨" }, opts);
    expect(spec.alignment).toBe("left");
    expect(spec.bold).toBe(true);
    expect(spec.fontSize).toBe(12);
  });

  it("maps body with a one-character first-line indent", () => {
    const spec = mapBlockToParagraph({ type: "body", text: "原告は次のとおり請求する。" }, opts);
    expect(spec.firstLineIndentPt).toBe(12);
    expect(spec.leftIndentPt).toBe(0);
    expect(spec.bold).toBe(false);
    expect(spec.lineSpacingPt).toBe(12);
  });

  it("scales line spacing with the paragraph font", () => {
    const body = mapBlockToParagraph(
      { type: "body", text: "原告は次のとおり請求する。" },
      { ...opts, lineSpacingChars: 1.5 }
    );
    const title = mapBlockToParagraph(
      { type: "title", text: "訴状" },
      { ...opts, lineSpacingChars: 1.5 }
    );
    expect(body.lineSpacingPt).toBe(18);
    expect(title.lineSpacingPt).toBe(24);
  });

  it("maps clause with a bold label and no indent", () => {
    const spec = mapBlockToParagraph(
      { type: "clause", text: "本契約の目的は…", label: "第１条" },
      opts
    );
    expect(spec.leftIndentPt).toBe(0);
    expect(spec.firstLineIndentPt).toBe(0);
    expect(spec.runs[0]).toEqual({ text: "第１条", bold: true });
    expect(spec.runs[1].bold).toBe(false);
    expect(specPlainText(spec)).toContain("本契約の目的は");
  });

  it("does not duplicate a label already in the clause text", () => {
    const spec = mapBlockToParagraph(
      { type: "clause", text: "第２条　定義", label: "第２条" },
      opts
    );
    expect(specPlainText(spec)).toBe("第２条　定義");
  });

  it("maps item with a deeper left indent", () => {
    const spec = mapBlockToParagraph({ type: "item", text: "１　甲は乙に委託する。" }, opts);
    expect(spec.leftIndentPt).toBe(12);
    expect(spec.alignment).toBe("left");
  });

  it("maps center and right alignments", () => {
    expect(mapBlockToParagraph({ type: "center", text: "令和７年１月１日" }, opts).alignment).toBe(
      "center"
    );
    expect(
      mapBlockToParagraph({ type: "right", text: "原告訴訟代理人弁護士　山田太郎" }, opts).alignment
    ).toBe("right");
  });

  it("uses ＭＳ 明朝 when asked", () => {
    const spec = mapBlockToParagraph(
      { type: "body", text: "本文" },
      { fontName: FALLBACK_FONT_NAME }
    );
    expect(spec.fontName).toBe(FALLBACK_FONT_NAME);
  });
});

describe("mapBlocks", () => {
  it("maps a sequence in order", () => {
    const specs = mapBlocks([
      { type: "title", text: "契約書" },
      { type: "right", text: "甲" },
    ]);
    expect(specs.map((s) => s.type)).toEqual(["title", "right"]);
  });
});

describe("summarizeInsertedBlocks", () => {
  it("names the first and last clauses so the next insert can continue", () => {
    const summary = summarizeInsertedBlocks([
      { type: "title", text: "業務委託契約書" },
      { type: "clause", text: "定義する。", label: "第1条" },
      { type: "item", text: "1 本件業務とは…" },
      { type: "clause", text: "支払う。", label: "第6条" },
    ]);
    expect(summary).toContain("4 段落");
    expect(summary).toContain("第1条〜第6条");
    expect(summary).toContain('at を "continue"');
  });

  it("falls back to the title when there are no clauses", () => {
    const summary = summarizeInsertedBlocks([{ type: "title", text: "訴状" }]);
    expect(summary).toContain("「訴状」");
  });

  it("reports where the insert landed so the next chunk can follow it", () => {
    const blocks: DraftBlock[] = [{ type: "clause", text: "支払う。", label: "第6条" }];
    const at = (placement: InsertPlacement) =>
      summarizeInsertedBlocks(blocks, { placement, after: "" });
    expect(at("continue")).toContain("直前に挿入した段落の続き");
    expect(at("end")).toContain("文書の末尾");
    expect(at("cursor")).toContain("カーソル位置");
    expect(at("quote")).toContain("引用した段落の後ろ");
  });

  it("names the paragraph the text now follows so a misplaced insert is visible", () => {
    const summary = summarizeInsertedBlocks(
      [{ type: "clause", text: "反社会的勢力の排除", label: "第14条" }],
      { placement: "cursor", after: "受託者が本契約について現に受領した報酬の総額を上限とします。" }
    );
    expect(summary).toContain(
      "前の段落は「受託者が本契約について現に受領した報酬の総額を上…」です"
    );
    expect(summary).toContain("意図と違う場所なら");
  });

  it("lists the numbers handed out for the new paragraphs, so the turn can point at them", () => {
    const summary = summarizeInsertedBlocks(
      [
        { type: "clause", text: "売主は買主に売り渡す。", label: "第1条" },
        { type: "item", text: "品名　○○" },
      ],
      {
        placement: "cursor",
        after: "",
        numbers: [
          { number: 2, text: "第1条　売主は買主に売り渡す。" },
          { number: 3, text: "品名　○○" },
        ],
      }
    );
    expect(summary).toContain("（変更履歴に記録）。");
    expect(summary).toContain("paragraph / through");
    expect(summary).toContain("\n[2] 第1条　売主は買主に売り渡す。\n[3] 品名　○○");
  });

  it("quotes the tail so the model can anchor the next call", () => {
    const summary = summarizeInsertedBlocks(
      [{ type: "clause", text: "乙は、甲に対し、報酬を支払う。", label: "第6条" }],
      { placement: "continue", after: "" }
    );
    expect(summary).toContain("末尾は「乙は、甲に対し、報酬を支払う。」");
  });
});
