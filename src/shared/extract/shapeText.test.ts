import { describe, expect, it } from "vitest";
import {
  AnchoredShape,
  BodyParagraphFact,
  fitShapeText,
  pickShapeByText,
  readShapeBlocks,
  SHAPE_NOTE,
  shapesInSpan,
} from "./shapeText";

const BOX = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
  <w:body>
    <w:p>
      <w:r><w:t>前文</w:t></w:r>
      <w:r>
        <mc:AlternateContent>
          <mc:Choice Requires="wps">
            <w:drawing><wps:txbx><w:txbxContent>
              <w:p><w:r><w:t>箱</w:t><w:tab/><w:t>甲</w:t></w:r></w:p>
              <w:p><w:r><w:t>乙</w:t><w:br/><w:t>丙</w:t></w:r></w:p>
              <w:p>
                <w:r><w:del w:author="甲"><w:r><w:delText>削除</w:delText></w:r></w:del></w:r>
                <w:moveFrom w:author="甲"><w:r><w:t>移動元</w:t></w:r></w:moveFrom>
                <w:r><w:t>残す</w:t></w:r>
              </w:p>
              <w:tbl><w:tr><w:tc><w:p><w:r><w:t>セル</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:txbxContent></wps:txbx></w:drawing>
          </mc:Choice>
          <mc:Fallback>
            <w:pict><v:textbox><w:txbxContent>
              <w:p><w:r><w:t>箱</w:t><w:tab/><w:t>甲</w:t></w:r></w:p>
              <v:textpath string="予備"/>
            </w:txbxContent></v:textbox></w:pict>
          </mc:Fallback>
        </mc:AlternateContent>
      </w:r>
    </w:p>
    <w:p><w:pPr><w:framePr/></w:pPr><w:r><w:t>枠</w:t></w:r></w:p>
    <w:p><w:r><w:t>後文</w:t></w:r></w:p>
  </w:body>
</w:document>`;

function shape(lines: string[], anchor: number | null = null): AnchoredShape {
  return { lines, anchor };
}

function fact(text: string, extra: Partial<BodyParagraphFact> = {}): BodyParagraphFact {
  return { text, hasDrawing: false, markDeleted: false, ...extra };
}

describe("readShapeBlocks", () => {
  it("reads a text box once, keeping tabs, breaks and table cells", () => {
    expect(readShapeBlocks(BOX)).toEqual({
      bodyParagraphs: 3,
      blocks: [shape(["箱\t甲", "乙\n丙", "残す", "セル"], 1)],
      paragraphs: [fact("前文"), fact("枠"), fact("後文")],
    });
  });

  it("reads a legacy word-art string that is not in the fallback copy", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:pict><v:shape><v:textpath string="アート"/></v:shape></w:pict></w:r></w:p></w:body></w:document>`;
    expect(readShapeBlocks(xml)).toEqual({
      bodyParagraphs: 1,
      blocks: [shape(["アート"], 1)],
      paragraphs: [fact("")],
    });
  });
});

describe("body paragraph facts", () => {
  const facts = (body: string) => readShapeBlocks(`<w:document><w:body>${body}</w:body></w:document>`).paragraphs;

  it("leaves a text box anchor without text of its own and without a drawing", () => {
    const anchor = `<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>箱</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent><w:p><w:r><w:t>箱</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    expect(facts(anchor)).toEqual([fact("")]);
  });

  it("marks a picture paragraph, inline or legacy", () => {
    const inline = `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const legacy = `<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId4"/></v:shape></w:pict></w:r></w:p>`;
    expect(facts(inline + legacy)).toEqual([fact("", { hasDrawing: true }), fact("", { hasDrawing: true })]);
  });

  it("does not count a picture that is itself a tracked deletion", () => {
    const xml = `<w:p><w:del><w:r><w:drawing><pic:pic/></w:drawing></w:r></w:del></w:p>`;
    expect(facts(xml)).toEqual([fact("")]);
  });

  it("marks a paragraph whose mark is deleted and keeps only the text that stays", () => {
    const xml = `<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="甲"/></w:rPr></w:pPr><w:del><w:r><w:delText>消えた</w:delText></w:r></w:del><w:ins><w:r><w:t>足した</w:t></w:r></w:ins></w:p><w:p/>`;
    expect(facts(xml)).toEqual([fact("足した", { markDeleted: true }), fact("")]);
  });

  it("does not read a run's own deletion as the paragraph mark", () => {
    const xml = `<w:p><w:r><w:rPr><w:del/></w:rPr><w:t>本文</w:t></w:r></w:p>`;
    expect(facts(xml)).toEqual([fact("本文")]);
  });
});

describe("fitShapeText", () => {
  it("numbers each shape and drops a block that does not fit", () => {
    const blocks = [shape(["当事者目録"]), shape(["長い本文".repeat(20)])];
    const first = `${SHAPE_NOTE}\n[図1]\n当事者目録`;
    const fitted = fitShapeText(blocks, first.length, "…（この先は長いので添付していません）");
    expect(fitted.text).toContain("[図1]\n当事者目録");
    expect(fitted.text).toContain(SHAPE_NOTE);
    expect(fitted.text).not.toContain("長い本文");
    expect(fitted.text).not.toContain("[図2]");
    expect(fitted.shown).toEqual(["当事者目録"]);
    expect(fitted.truncated).toBe(true);
  });

  it("numbers a second shape when both fit", () => {
    const fitted = fitShapeText([shape(["甲"], 2), shape(["乙"], 4)], 10_000, "");
    expect(fitted.text).toContain("[図1]\n甲");
    expect(fitted.text).toContain("[図2]\n乙");
    expect(fitted.shown).toEqual(["甲", "乙"]);
  });
});

function picked<T>(result: { ok: true; shape: T } | { ok: false }): T {
  if (!result.ok) {
    throw new Error("expected a shape");
  }
  return result.shape;
}

describe("pickShapeByText", () => {
  const shown = ["甲", "乙", "甲"];
  const shapes = [{ text: "甲\r" }, { text: "乙\r" }, { text: "甲\u0007\r" }];

  it("picks the only shape whose text matches", () => {
    expect(picked(pickShapeByText(shown, shapes, 2))).toBe(shapes[1]);
  });

  it("picks the same occurrence when the text is repeated", () => {
    expect(picked(pickShapeByText(shown, shapes, 1))).toBe(shapes[0]);
    expect(picked(pickShapeByText(shown, shapes, 3))).toBe(shapes[2]);
  });

  it("keeps a later duplicate on the shape that is still there", () => {
    const live = [shapes[1], shapes[2]];
    expect(picked(pickShapeByText(shown, live, 3, new Set([1])))).toBe(shapes[2]);
  });

  it("walks into a group and ignores the group's own text", () => {
    const group = { text: "甲\n乙", children: [{ text: "乙" }] };
    expect(picked(pickShapeByText(["乙"], [group], 1))).toBe(group.children[0]);
  });

  it("reports a number that was not shown", () => {
    expect(pickShapeByText(shown, shapes, 4)).toEqual({ ok: false, reason: "unknown" });
  });

  it("reports a word-art string the shape collection does not carry", () => {
    expect(pickShapeByText(["アート"], [{ text: "" }], 1)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("shapesInSpan", () => {
  // Paragraphs 2, 4, 6 and 9 are numbered; boxes sit on 1, 3, 5, 7 and 8.
  const anchors = [1, 3, 5, 7, 8, null];
  const numbered = [2, 4, 6, 9];

  it("takes boxes in the span and on the blanks up to the next numbered paragraph", () => {
    expect(shapesInSpan(anchors, 2, 4, numbered)).toEqual({ shapes: [2, 3], lastAnchor: 5 });
    expect(shapesInSpan(anchors, 6, 6, numbered)).toEqual({ shapes: [4, 5], lastAnchor: 8 });
  });

  it("leaves the blanks before the span alone", () => {
    expect(shapesInSpan(anchors, 2, 2, numbered)).toEqual({ shapes: [2], lastAnchor: 3 });
  });

  it("does not reach past the span when nothing numbered follows it", () => {
    expect(shapesInSpan(anchors, 9, 9, numbered)).toEqual({ shapes: [], lastAnchor: 9 });
    expect(shapesInSpan([3, 10], 2, 3, [2, 3])).toEqual({ shapes: [1], lastAnchor: 3 });
  });
});
