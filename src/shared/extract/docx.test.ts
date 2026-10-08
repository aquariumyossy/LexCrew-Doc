import { describe, expect, it } from "vitest";
import { extractDocx } from "./docx";
import { decodeXmlText, scanXml, xmlAttr, xmlDate } from "./xml";

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>第1条（目的）</w:t></w:r></w:p>
    <w:p>
      <w:commentRangeStart w:id="1"/>
      <w:r><w:t xml:space="preserve">本契約は、</w:t></w:r>
      <w:ins w:id="5" w:author="乙川" w:date="2026-03-01T10:00:00Z">
        <w:r><w:t>甲乙間の</w:t></w:r>
      </w:ins>
      <w:del w:id="6" w:author="乙川" w:date="2026-03-01T10:05:00Z">
        <w:r><w:delText>丙野との</w:delText></w:r>
      </w:del>
      <w:r><w:t>取引を定める。</w:t></w:r>
      <w:commentRangeEnd w:id="1"/>
      <w:r><w:commentReference w:id="1"/></w:r>
    </w:p>
    <w:p><w:r><w:t>第2条</w:t></w:r><w:r><w:tab/><w:t>報酬は別途定める。</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="1" w:author="丙野" w:date="2026-03-02T09:00:00Z">
    <w:p><w:r><w:t>主体が甲乙だけで足りるか確認してください。</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;

describe("extractDocx", () => {
  const read = extractDocx({ document: DOCUMENT, comments: COMMENTS });

  it("inlines tracked edits in the body when markup is present", () => {
    expect(read.body).toContain("※ 〔-〕削除");
    expect(read.body).toContain("本契約は、");
    expect(read.body).toContain("〔-乙川: 丙野との〕");
    expect(read.body).toContain("〔+乙川: 甲乙間の〕");
    expect(read.body).toContain("〔注 丙野 2026-03-02: 主体が甲乙だけで足りるか確認してください。〕");
    expect(read.origin).toBe("text");
  });

  it("leaves only format changes in the list when edits are inlined", () => {
    expect(read.changes.error).toBe("");
    expect(read.changes.items).toEqual([]);
  });

  it("keeps comments without replies out of the list once they are inlined", () => {
    expect(read.comments.items).toEqual([]);
  });

  it("says a document without comments has none rather than failing", () => {
    const plain = extractDocx({ document: DOCUMENT });
    expect(plain.comments.items).toEqual([]);
    expect(plain.comments.error).toBe("");
    expect(plain.comments.truncated).toBe(false);
  });
});

const NUMBERING = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

function numberedParagraph(text: string, withInsert = false): string {
  const insert = withInsert
    ? `<w:ins w:id="1" w:author="乙川" w:date="2026-03-01T10:00:00Z"><w:r><w:t>追記</w:t></w:r></w:ins>`
    : "";
  return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r>${insert}</w:p>`;
}

describe("extractDocx text boxes", () => {
  const boxed = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:t>前文</w:t></w:r><w:r><w:txbxContent><w:p><w:r><w:t>当事者目録</w:t></w:r></w:p></w:txbxContent></w:r></w:p>
  </w:body></w:document>`;

  it("includes text that sits inside a text box", () => {
    expect(extractDocx({ document: boxed }).body).toContain("当事者目録");
  });

  it("includes text-box text when the file also has a tracked change", () => {
    const marked = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>前文</w:t></w:r><w:ins w:author="甲" w:date="2026-03-01T00:00:00Z"><w:r><w:t>追記</w:t></w:r></w:ins></w:p>
      <w:p><w:r><w:txbxContent><w:p><w:r><w:t>当事者目録</w:t></w:r></w:p></w:txbxContent></w:r></w:p>
    </w:body></w:document>`;
    const read = extractDocx({ document: marked });
    expect(read.body).toContain("当事者目録");
    expect(read.body).toContain("〔+甲: 追記〕");
  });
});

describe("extractDocx list marks", () => {
  it("puts the list label outside the paragraph text", () => {
    const document = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      ${numberedParagraph("甲")}
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:p>
      ${numberedParagraph("乙")}
    </w:body></w:document>`;
    const read = extractDocx({ document, numbering: NUMBERING });
    expect(read.body).toBe("〔1.〕甲\n〔2.〕\n〔3.〕乙");
  });

  it("keeps the label on a paragraph that also has tracked edits", () => {
    const document = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${numberedParagraph("甲", true)}</w:body></w:document>`;
    const read = extractDocx({ document, numbering: NUMBERING });
    expect(read.body).toContain("〔1.〕甲");
    expect(read.body).toContain("〔+乙川: 追記〕");
  });

  it("leaves the body unchanged when the file has no numbering part", () => {
    const document = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${numberedParagraph("甲")}</w:body></w:document>`;
    expect(extractDocx({ document }).body).toBe("甲");
  });
});

describe("scanXml", () => {
  it("decodes entities and keeps text out of attributes", () => {
    const events = [...scanXml(`<a t="x &gt; y">&#x65E5;&amp;本</a>`)];
    expect(events).toEqual([
      { kind: "open", name: "a", attrs: 't="x &gt; y"', empty: false },
      { kind: "text", text: "日&本" },
      { kind: "close", name: "a" },
    ]);
    expect(xmlAttr('t="x &gt; y"', "t")).toBe("x > y");
  });

  it("does not end a tag on a bracket inside an attribute", () => {
    const events = [...scanXml(`<w:t w:val="a>b"/>x`)];
    expect(events[0]).toEqual({ kind: "open", name: "w:t", attrs: 'w:val="a>b"', empty: true });
    expect(events[1]).toEqual({ kind: "text", text: "x" });
  });

  it("skips declarations, comments and unwraps CDATA", () => {
    const events = [...scanXml(`<?xml version="1.0"?><!-- 注 --><p><![CDATA[a<b]]></p>`)];
    expect(events).toEqual([
      { kind: "open", name: "p", attrs: "", empty: false },
      { kind: "text", text: "a<b" },
      { kind: "close", name: "p" },
    ]);
  });

  it("leaves an unknown entity alone instead of guessing", () => {
    expect(decodeXmlText("&unknown;&amp;")).toBe("&unknown;&");
  });

  it("keeps only the day of a Word timestamp", () => {
    expect(xmlDate("2026-03-01T10:00:00Z")).toBe("2026-03-01");
    expect(xmlDate("")).toBe("");
  });
});
