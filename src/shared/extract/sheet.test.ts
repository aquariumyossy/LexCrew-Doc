import { describe, expect, it } from "vitest";
import { extractSheet, readSharedStrings } from "./sheet";

const SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>項目</t></si>
  <si><t>金額</t></si>
  <si><t>着手金</t><rPh sb="0" eb="3"><t>チャクシュキン</t></rPh></si>
  <si><t>報酬金</t></si>
</sst>`;

const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>330000</v></c></row>
    <row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><f>B2*2</f><v>660000</v></c></row>
    <row r="4"/>
    <row r="5"><c r="A5" t="inlineStr"><is><t>備考</t></is></c><c r="B5" t="b"><v>1</v></c></row>
  </sheetData>
</worksheet>`;

describe("extractSheet", () => {
  it("reads cell values through the shared string table", () => {
    const read = extractSheet({ sharedStrings: SHARED, sheets: [{ name: "費用", xml: SHEET }] });
    expect(read.body).toBe(
      ["## 費用", "項目\t金額", "着手金\t330000", "報酬金\t660000", "備考\tTRUE"].join("\n")
    );
  });

  it("leaves furigana out of the cell text", () => {
    expect(readSharedStrings(SHARED)[2]).toBe("着手金");
  });

  it("has no comments or tracked changes to report", () => {
    const read = extractSheet({ sharedStrings: SHARED, sheets: [{ name: "費用", xml: SHEET }] });
    expect(read.comments.items).toEqual([]);
    expect(read.comments.error).toBe("");
    expect(read.changes.items).toEqual([]);
  });

  it("skips a sheet with no rows and names the ones that have them", () => {
    const read = extractSheet({
      sharedStrings: SHARED,
      sheets: [
        { name: "空", xml: `<worksheet><sheetData/></worksheet>` },
        { name: "費用", xml: SHEET },
      ],
    });
    expect(read.body.startsWith("## 費用")).toBe(true);
    expect(read.body).not.toContain("## 空");
  });
});
