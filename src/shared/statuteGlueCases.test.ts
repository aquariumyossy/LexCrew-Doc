import { describe, expect, it } from "vitest";
import cases from "./statuteGlueCases.json";
import { markUnverified } from "./statuteMark";

describe("statute glue cases", () => {
  it.each(cases)("$id marks every row when nothing was fetched", (row) => {
    const marked = markUnverified(row.text, []);
    const marks = marked.match(/（要確認）/g)?.length ?? 0;
    expect(marks, marked).toBe(row.rows.length);
    if (row.mark) {
      expect(marked).toContain(row.mark);
    }
    if (row.rows.length === 0) {
      expect(marked).toBe(row.text);
    }
  });

  it.each(cases)("$id leaves a fetched row unmarked", (row) => {
    const verified = row.rows.map((item) => ({ names: [item.law], key: item.key }));
    const marked = markUnverified(row.text, verified);
    if (row.keepMark) {
      expect(marked, marked).toContain("（要確認）");
    } else {
      expect(marked, marked).not.toContain("（要確認）");
    }
  });

  it("marks only the unfetched article inside a parenthesis", () => {
    const marked = markUnverified("損害賠償責任を負う（民法第709条、第710条）。", [
      { names: ["民法"], key: "709" },
    ]);
    expect(marked).toContain("第710条（要確認）");
    expect(marked).not.toContain("第709条（要確認）");
  });

  it("leaves a parenthesised 同法 unmarked once both articles were fetched", () => {
    const marked = markUnverified("（民法第709条、同法第710条）", [
      { names: ["民法"], key: "709" },
      { names: ["民法"], key: "710" },
    ]);
    expect(marked).not.toContain("（要確認）");
  });

  it("leaves an inner 同法 unmarked once every cited article was fetched", () => {
    const marked = markUnverified("民法第709条（会社法第2条及び同法第3条を除く。）及び第710条", [
      { names: ["民法"], key: "709" },
      { names: ["会社法"], key: "2" },
      { names: ["会社法"], key: "3" },
      { names: ["民法"], key: "710" },
    ]);
    expect(marked).not.toContain("（要確認）");
  });
});
