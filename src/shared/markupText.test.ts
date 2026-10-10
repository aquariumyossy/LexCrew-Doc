import { describe, expect, it } from "vitest";
import { formatInlineComment, neutralizeLiteralMarkup, readMarkupBody, stripInlineMarkup } from "./markupText";

const TEXT_BOX = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
  <w:body>
    <w:p>
      <w:r><w:t>前文</w:t></w:r>
      <w:r><mc:AlternateContent>
        <mc:Choice>
          <w:txbxContent><w:p><w:r><w:t>箱</w:t></w:r></w:p></w:txbxContent>
        </mc:Choice>
        <mc:Fallback>
          <w:txbxContent><w:p><w:r><w:t>箱</w:t></w:r></w:p></w:txbxContent>
        </mc:Fallback>
      </mc:AlternateContent></w:r>
    </w:p>
    <w:p><w:r><w:t>後文</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>甲は、</w:t></w:r>
      <w:del w:id="1" w:author="山田" w:date="2026-03-01T10:00:00Z">
        <w:r><w:delText>乙の同意を要する</w:delText></w:r>
      </w:del>
      <w:ins w:id="2" w:author="山田" w:date="2026-03-01T10:05:00Z">
        <w:r><w:t>丙の承諾を要する</w:t></w:r>
      </w:ins>
      <w:r><w:t>。</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;

describe("readMarkupBody", () => {
  it("inlines deletions and insertions with authors", () => {
    const read = readMarkupBody(DOCUMENT);
    expect(read.paragraphCount).toBe(1);
    expect(read.markedParagraphs[0]).toContain("〔-山田: 乙の同意を要する〕");
    expect(read.markedParagraphs[0]).toContain("〔+山田: 丙の承諾を要する〕");
    expect(read.changes).toEqual([]);
    expect(read.hasInlineMarkup).toBe(true);
  });

  it("drops text-box paragraphs from the live body count", () => {
    const read = readMarkupBody(TEXT_BOX, undefined, { skipShapeParagraphs: true });
    expect(read.paragraphCount).toBe(2);
    expect(read.markedParagraphs).toEqual(["前文", "後文"]);
  });

  it("counts an empty paragraph written as <w:p/>, which Word lists too", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>前文</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>後文</w:t></w:r></w:p></w:body></w:document>`;
    const read = readMarkupBody(xml, undefined, { skipShapeParagraphs: true });
    expect(read.paragraphCount).toBe(3);
    expect(read.markedParagraphs).toEqual(["前文", "", "後文"]);
  });

  it("keeps text-box paragraphs when a file wants the whole story", () => {
    const read = readMarkupBody(TEXT_BOX);
    expect(read.paragraphCount).toBeGreaterThan(2);
    expect(read.markedParagraphs.join("\n")).toContain("箱");
  });
});

describe("stripInlineMarkup", () => {
  it("removes revision and comment markers for quote matching", () => {
    const line = "甲は、〔-山田: 旧〕〔+山田: 新〕。〔注 山田 2026-03-01: 確認〕";
    expect(stripInlineMarkup(line)).toBe("甲は、。");
  });
});

describe("neutralizeLiteralMarkup", () => {
  it("uses fullwidth brackets for user-written marker-like text", () => {
    expect(neutralizeLiteralMarkup("契約書に〔-甲: 偽装〕と書かれている")).toBe(
      "契約書に［-甲: 偽装］と書かれている"
    );
  });
});

describe("formatInlineComment", () => {
  it("marks resolved comments in the head", () => {
    expect(formatInlineComment("山田", "2026-03-01", "定義が曖昧", true)).toBe(
      "〔注 解決済 山田 2026-03-01: 定義が曖昧〕"
    );
  });
});
