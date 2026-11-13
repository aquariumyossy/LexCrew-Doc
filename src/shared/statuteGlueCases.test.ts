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
});
