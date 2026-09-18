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

  it("keeps insertions in the body and leaves deletions out", () => {
    expect(read.body).toBe(
      ["第1条（目的）", "本契約は、甲乙間の取引を定める。", "第2条\t報酬は別途定める。"].join("\n")
    );
    expect(read.body).not.toContain("丙野との");
    expect(read.origin).toBe("text");
  });

  it("reports both edits as notes placed in their paragraph", () => {
    expect(read.changes.error).toBe("");
    expect(read.changes.items).toEqual([
      {
        kind: "insert",
        author: "乙川",
        date: "2026-03-01",
        text: "甲乙間の",
        where: "本契約は、甲乙間の取引を定める。",
      },
      {
        kind: "delete",
        author: "乙川",
        date: "2026-03-01",
        text: "丙野との",
        where: "本契約は、甲乙間の取引を定める。",
      },
    ]);
  });

  it("anchors a comment to the text its range covers", () => {
    expect(read.comments.items).toHaveLength(1);
    const note = read.comments.items[0];
    expect(note.author).toBe("丙野");
    expect(note.date).toBe("2026-03-02");
    expect(note.content).toBe("主体が甲乙だけで足りるか確認してください。");
    expect(note.anchor).toBe("本契約は、甲乙間の取引を定める。");
    // Threading lives in a part we do not read, so a note claims no replies.
    expect(note.replies).toEqual([]);
  });

  it("says a document without comments has none rather than failing", () => {
    const plain = extractDocx({ document: DOCUMENT });
    expect(plain.comments.items).toEqual([]);
    expect(plain.comments.error).toBe("");
    expect(plain.comments.truncated).toBe(false);
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
