import { describe, expect, it } from "vitest";
import { wrapListMark } from "../listMark";
import { paragraphListMarks } from "./numbering";

function numbering(levels: string, overrides = ""): string {
  return `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:abstractNum w:abstractNumId="0">
      ${levels}
    </w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/>${overrides}</w:num>
  </w:numbering>`;
}

function level(ilvl: number, fmt: string, text: string, extra = ""): string {
  return `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/>${extra}<w:rPr><w:rFonts w:ascii="Times"/></w:rPr></w:lvl>`;
}

function para(text: string, numId: number | null, ilvl?: number, style?: string): string {
  const ilvlXml = ilvl === undefined ? "" : `<w:ilvl w:val="${ilvl}"/>`;
  const numIdXml = numId === null ? "" : `<w:numId w:val="${numId}"/>`;
  const num = ilvlXml || numIdXml ? `<w:numPr>${ilvlXml}${numIdXml}</w:numPr>` : "";
  const pStyle = style ? `<w:pStyle w:val="${style}"/>` : "";
  const pPr = num || pStyle ? `<w:pPr>${pStyle}${num}</w:pPr>` : "";
  const body = text ? `<w:r><w:t>${text}</w:t></w:r>` : "";
  return `<w:p>${pPr}${body}</w:p>`;
}

function doc(body: string): string {
  return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function labels(body: string, numbers: string, styles = ""): (string | null)[] {
  return paragraphListMarks(doc(body), numbers, styles).map((mark) => (mark ? wrapListMark(mark) : null));
}

const DECIMAL = numbering(level(0, "decimal", "%1."));

describe("paragraphListMarks", () => {
  it("numbers paragraphs that carry numPr directly", () => {
    expect(labels(para("甲", 1, 0) + para("乙", 1, 0), DECIMAL)).toEqual(["〔1.〕", "〔2.〕"]);
  });

  it("reads 第１条 from the paragraph style, including basedOn", () => {
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="jo">
        <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      </w:style>
      <w:style w:type="paragraph" w:styleId="jo2"><w:basedOn w:val="jo"/></w:style>
    </w:styles>`;
    const numbers = numbering(level(0, "decimalFullWidth", "第%1条"));
    expect(labels(para("目的", null, undefined, "jo2"), numbers, styles)).toEqual(["〔第１条〕"]);
  });

  it("restarts a lower level when a higher one advances", () => {
    const numbers = numbering(
      level(0, "decimalFullWidth", "第%1条") + level(1, "decimalFullWidth", "（%2）")
    );
    const body =
      para("目的", 1, 0) + para("項", 1, 1) + para("項", 1, 1) + para("報酬", 1, 0) + para("項", 1, 1);
    expect(labels(body, numbers)).toEqual(["〔第１条〕", "〔（１）〕", "〔（２）〕", "〔第２条〕", "〔（１）〕"]);
  });

  it("shows a bullet as 〔•〕", () => {
    expect(labels(para("項", 1, 0), numbering(level(0, "bullet", "•")))).toEqual(["〔•〕"]);
  });

  it("drops the mark when numId is 0 even if the style numbers the paragraph", () => {
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="jo"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    </w:styles>`;
    expect(labels(para("本文", 0, undefined, "jo"), DECIMAL, styles)).toEqual([null]);
  });

  it("inherits numId from the style and ilvl from the paragraph", () => {
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="jo"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    </w:styles>`;
    const numbers = numbering(level(0, "decimal", "%1.") + level(1, "decimalFullWidth", "（%2）"));
    const body = para("条", null, undefined, "jo") + para("項", null, 1, "jo");
    expect(labels(body, numbers, styles)).toEqual(["〔1.〕", "〔（１）〕"]);
  });

  it("shows no mark for a level whose format is none, and does not consume the parent counter", () => {
    const numbers = numbering(level(0, "decimal", "%1.") + level(1, "none", "%2"));
    const body = para("甲", 1, 0) + para("続き", 1, 1) + para("乙", 1, 0);
    expect(labels(body, numbers)).toEqual(["〔1.〕", null, "〔2.〕"]);
  });

  it("uses startOverride and a level that the override replaces", () => {
    const overridden = numbering(
      level(0, "decimal", "%1."),
      `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="(%1)"/></w:lvl></w:lvlOverride>`
    );
    expect(labels(para("甲", 1, 0), overridden)).toEqual(["〔(5)〕"]);
  });

  it("prints legal numbering as decimals", () => {
    const numbers = numbering(
      level(0, "japaneseCounting", "%1") + level(1, "japaneseCounting", "%1.%2", "<w:isLgl/>")
    );
    expect(labels(para("条", 1, 0) + para("項", 1, 1), numbers)).toEqual(["〔一〕", "〔1.1〕"]);
  });

  it("keeps an ideographic space that belongs to the label", () => {
    expect(labels(para("甲", 1, 0), numbering(level(0, "decimalFullWidth", "%1\u3000")))).toEqual(["〔１　〕"]);
  });

  it("renders kana, circled numbers and letters", () => {
    expect(labels(para("ア", 1, 0), numbering(level(0, "aiueo", "%1")))).toEqual(["〔ア〕"]);
    expect(labels(para("丸", 1, 0), numbering(level(0, "decimalEnclosedCircle", "%1")))).toEqual(["〔①〕"]);
    expect(labels(para("い", 1, 0), numbering(level(0, "iroha", "%1")))).toEqual(["〔イ〕"]);
    expect(labels(para("a", 1, 0), numbering(level(0, "lowerLetter", "%1.")))).toEqual(["〔a.〕"]);
  });

  it("numbers a paragraph inside a table cell", () => {
    const body = `<w:tbl><w:tr><w:tc>${para("甲", 1, 0)}</w:tc></w:tr></w:tbl>`;
    expect(labels(body, DECIMAL)).toEqual(["〔1.〕"]);
  });

  it("returns no marks when numbering.xml is missing", () => {
    expect(paragraphListMarks(doc(para("甲", 1, 0)), "", "")).toEqual([null]);
  });

  it("says the number is unreadable when the format is unknown", () => {
    expect(labels(para("甲", 1, 0), numbering(level(0, "ordinal", "%1")))).toEqual(["〔番号あり〕"]);
  });
});
