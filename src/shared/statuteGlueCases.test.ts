import { describe, expect, it } from "vitest";
import cases from "./statuteGlueCases.json";
import { markUnverified } from "./statuteMark";

describe("statute glue cases", () => {
  it.each(cases)("$id", (row) => {
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
});
