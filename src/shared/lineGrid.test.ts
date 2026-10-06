import { describe, expect, it } from "vitest";
import { patchParagraphFormat, readParagraphLineSpacing, unsetParagraphLineGrid } from "./lineGrid";

const SNAP_ON = '<w:snapToGrid w:val="1"/>';
const SNAP_OFF = '<w:snapToGrid w:val="0"/>';

function documentXml(body: string): string {
  return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function pkg(document: string, styles?: string): string {
  const stylePart = styles
    ? `<pkg:part pkg:name="/word/styles.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"><pkg:xmlData>${styles}</pkg:xmlData></pkg:part>`
    : "";
  return `<?xml version="1.0" standalone="yes"?><pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage"><pkg:part pkg:name="/word/document.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"><pkg:xmlData>${document}</pkg:xmlData></pkg:part>${stylePart}</pkg:package>`;
}

describe("unsetParagraphLineGrid", () => {
  it("inserts snapToGrid off when the paragraph has no pPr", () => {
    const xml = documentXml("<w:p><w:r><w:t>本文</w:t></w:r></w:p>");
    const result = unsetParagraphLineGrid(xml);
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(`<w:pPr>${SNAP_OFF}</w:pPr>`);
    expect(result.ooxml).toContain("本文");
  });

  it("expands an empty pPr instead of leaving the grid on", () => {
    const xml = documentXml("<w:p><w:pPr/><w:r><w:t>本文</w:t></w:r></w:p>");
    const result = unsetParagraphLineGrid(xml);
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(`<w:pPr>${SNAP_OFF}</w:pPr>`);
    expect(result.ooxml).not.toContain("<w:pPr/>");
  });

  it("turns an explicit on into off", () => {
    const xml = documentXml(`<w:p><w:pPr>${SNAP_ON}<w:spacing w:line="240"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`);
    const result = unsetParagraphLineGrid(xml);
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(SNAP_OFF);
    expect(result.ooxml).not.toContain(SNAP_ON);
    expect(result.ooxml).toContain('<w:spacing w:line="240"/>');
  });

  it("leaves already-off paragraphs unchanged", () => {
    const xml = documentXml(`<w:p><w:pPr>${SNAP_OFF}</w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`);
    const result = unsetParagraphLineGrid(xml);
    expect(result.changed).toBe(false);
    expect(result.ooxml).toBe(xml);
  });

  it("treats val omitted as on, because that is the OOXML default", () => {
    const xml = documentXml("<w:p><w:pPr><w:snapToGrid/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>");
    const result = unsetParagraphLineGrid(xml);
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(SNAP_OFF);
    expect(result.ooxml).not.toMatch(/<w:snapToGrid\s*\/>/);
  });

  it("does not touch snapToGrid inside rPr", () => {
    const xml = documentXml(
      `<w:p><w:pPr><w:rPr>${SNAP_ON}</w:rPr></w:pPr><w:r><w:rPr>${SNAP_ON}</w:rPr><w:t>本文</w:t></w:r></w:p>`
    );
    const result = unsetParagraphLineGrid(xml);
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(`<w:pPr>${SNAP_OFF}<w:rPr>${SNAP_ON}</w:rPr></w:pPr>`);
    expect(result.ooxml).toContain(`<w:r><w:rPr>${SNAP_ON}</w:rPr>`);
  });

  it("does not rewrite snapToGrid recorded under pPrChange", () => {
    const xml = documentXml(
      `<w:p><w:pPr>${SNAP_ON}<w:pPrChange><w:pPr>${SNAP_ON}</w:pPr></w:pPrChange></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = unsetParagraphLineGrid(xml);
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(`<w:pPrChange><w:pPr>${SNAP_ON}</w:pPr></w:pPrChange>`);
    expect(result.ooxml.match(/w:snapToGrid w:val="0"/g)?.length).toBe(1);
  });

  it("does not edit styles.xml in a Flat OPC package", () => {
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="a"><w:pPr>${SNAP_ON}</w:pPr></w:style></w:styles>`;
    const wrapped = pkg(documentXml("<w:p><w:r><w:t>本文</w:t></w:r></w:p>"), styles);
    const result = unsetParagraphLineGrid(wrapped);
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(styles);
    expect(result.ooxml).toContain(`<w:pPr>${SNAP_OFF}</w:pPr>`);
  });

  it("expands an empty paragraph without dropping its attributes", () => {
    const xml = documentXml('<w:p w14:paraId="A1"/>');
    const result = unsetParagraphLineGrid(xml);
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain('<w:p w14:paraId="A1">');
    expect(result.ooxml).toContain(SNAP_OFF);
    expect(result.ooxml).toContain("</w:p>");
  });
});

describe("patchParagraphFormat auto spacing", () => {
  it("turns Auto after-spacing off and writes the point value in twips", () => {
    const xml = documentXml(
      `<w:p><w:pPr><w:spacing w:afterAutospacing="1" w:beforeAutospacing="1" w:line="240"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = patchParagraphFormat(xml, { spaceAfterPt: 0 });
    expect(result.changed).toBe(true);
    expect(result.autoSpacing).toBe(true);
    expect(result.lineGrid).toBe(false);
    expect(result.ooxml).toContain('w:afterAutospacing="0"');
    expect(result.ooxml).toContain('w:after="0"');
    expect(result.ooxml).toContain('w:beforeAutospacing="1"');
    expect(result.ooxml).toContain('w:line="240"');
    expect(result.ooxml).not.toContain("snapToGrid");
  });

  it("sets before spacing without leaving Auto on", () => {
    const xml = documentXml("<w:p><w:r><w:t>本文</w:t></w:r></w:p>");
    const result = patchParagraphFormat(xml, { spaceBeforePt: 6 });
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain('w:beforeAutospacing="0"');
    expect(result.ooxml).toContain('w:before="120"');
  });

  it("leaves matching Auto-off spacing unchanged", () => {
    const xml = documentXml(
      `<w:p><w:pPr><w:spacing w:afterAutospacing="0" w:after="0"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = patchParagraphFormat(xml, { spaceAfterPt: 0 });
    expect(result.changed).toBe(false);
    expect(result.ooxml).toBe(xml);
  });

  it("does not rewrite spacing recorded under pPrChange", () => {
    const xml = documentXml(
      `<w:p><w:pPr><w:spacing w:afterAutospacing="1"/><w:pPrChange><w:pPr><w:spacing w:afterAutospacing="1"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = patchParagraphFormat(xml, { spaceAfterPt: 0 });
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(
      `<w:pPrChange><w:pPr><w:spacing w:afterAutospacing="1"/></w:pPr></w:pPrChange>`
    );
  });

  it("can drop the line grid and Auto spacing in one pass", () => {
    const xml = documentXml(
      `<w:p><w:pPr>${SNAP_ON}<w:spacing w:beforeAutospacing="1" w:afterAutospacing="1"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = patchParagraphFormat(xml, {
      unsetLineGrid: true,
      spaceBeforePt: 0,
      spaceAfterPt: 0,
    });
    expect(result.lineGrid).toBe(true);
    expect(result.autoSpacing).toBe(true);
    expect(result.ooxml).toContain(SNAP_OFF);
    expect(result.ooxml).not.toContain(SNAP_ON);
    expect(result.ooxml).toContain('w:beforeAutospacing="0"');
    expect(result.ooxml).toContain('w:afterAutospacing="0"');
  });
});

describe("patchParagraphFormat indent", () => {
  it("writes left indent and a hanging first line in twips and character units", () => {
    const xml = documentXml(
      `<w:p><w:pPr><w:ind w:left="200" w:leftChars="100" w:firstLine="240" w:firstLineChars="200" w:right="100"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = patchParagraphFormat(xml, {
      indent: { leftPt: 36, firstLinePt: -24, fontPt: 12 },
    });
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain('w:left="720"');
    expect(result.ooxml).toContain('w:leftChars="300"');
    expect(result.ooxml).toContain('w:hanging="480"');
    expect(result.ooxml).toContain('w:hangingChars="200"');
    expect(result.ooxml).toContain('w:right="100"');
    expect(result.ooxml).not.toContain("firstLine");
  });

  it("does not clear leftChars when only the first line is set", () => {
    const xml = documentXml(
      `<w:p><w:pPr><w:ind w:leftChars="300" w:hanging="240" w:hangingChars="100"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = patchParagraphFormat(xml, { indent: { firstLinePt: 12, fontPt: 12 } });
    expect(result.ooxml).toContain('w:leftChars="300"');
    expect(result.ooxml).toContain('w:firstLine="240"');
    expect(result.ooxml).toContain('w:firstLineChars="100"');
    expect(result.ooxml).not.toContain("hanging");
  });

  it("uses the paragraph font size for character units", () => {
    const xml = documentXml("<w:p><w:r><w:t>本文</w:t></w:r></w:p>");
    const result = patchParagraphFormat(xml, { indent: { leftPt: 21, fontPt: 10.5 } });
    expect(result.ooxml).toContain('w:left="420"');
    expect(result.ooxml).toContain('w:leftChars="200"');
  });

  it("does not rewrite indent recorded under pPrChange", () => {
    const xml = documentXml(
      `<w:p><w:pPr><w:ind w:firstLineChars="100"/><w:pPrChange><w:pPr><w:ind w:firstLineChars="100"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = patchParagraphFormat(xml, { indent: { firstLinePt: -12, fontPt: 12 } });
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(
      `<w:pPrChange><w:pPr><w:ind w:firstLineChars="100"/></w:pPr></w:pPrChange>`
    );
    expect(result.ooxml.match(/w:hanging=/g)?.length).toBe(1);
  });

  it("leaves an indent that already matches", () => {
    const xml = documentXml(
      `<w:p><w:pPr><w:ind w:left="720" w:leftChars="300" w:hanging="480" w:hangingChars="200"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    const result = patchParagraphFormat(xml, {
      indent: { leftPt: 36, firstLinePt: -24, fontPt: 12 },
    });
    expect(result.changed).toBe(false);
    expect(result.ooxml).toBe(xml);
  });
});

describe("readParagraphLineSpacing", () => {
  it("reads an explicit snap-off and the line rule", () => {
    const xml = documentXml(
      `<w:p><w:pPr>${SNAP_OFF}<w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`
    );
    expect(readParagraphLineSpacing(xml)).toEqual({
      snapOff: true,
      line: "360",
      lineRule: "auto",
    });
  });

  it("treats a missing snap flag as still on the grid", () => {
    const xml = documentXml(`<w:p><w:pPr><w:spacing w:line="240" w:lineRule="exact"/></w:pPr><w:r><w:t>本文</w:t></w:r></w:p>`);
    expect(readParagraphLineSpacing(xml).snapOff).toBe(false);
  });

  it("copies the sample line rule onto a paragraph and turns the grid off", () => {
    const xml = documentXml("<w:p><w:r><w:t>続き</w:t></w:r></w:p>");
    const result = patchParagraphFormat(xml, {
      unsetLineGrid: true,
      lineCopy: { line: "360", lineRule: "auto" },
    });
    expect(result.changed).toBe(true);
    expect(result.ooxml).toContain(SNAP_OFF);
    expect(result.ooxml).toContain('w:line="360"');
    expect(result.ooxml).toContain('w:lineRule="auto"');
  });
});
