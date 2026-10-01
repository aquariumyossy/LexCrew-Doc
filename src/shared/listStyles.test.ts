import { describe, expect, it } from "vitest";
import {
  LIST_STYLE_IDS,
  isBuiltinListStyle,
  isListStyle,
  listLevelNumberFormat,
  listStyleEnum,
  listStyleSpec,
} from "./listStyles";

describe("listStyles", () => {
  it("lists all ten styles", () => {
    expect(LIST_STYLE_IDS).toEqual([
      "continue",
      "arabic",
      "paren",
      "lowerLetter",
      "dai",
      "daiJo",
      "arabicFull",
      "parenFull",
      "aiueo",
      "circled",
    ]);
    expect(listStyleEnum()).toEqual(LIST_STYLE_IDS);
  });

  it("marks Japanese styles as builtin", () => {
    expect(isBuiltinListStyle("dai")).toBe(true);
    expect(isBuiltinListStyle("daiJo")).toBe(true);
    expect(listStyleSpec("daiJo").builtin?.numberFormat).toBe("第%N条");
    expect(isBuiltinListStyle("arabic")).toBe(false);
    expect(listStyleSpec("circled").builtin?.numberStyle).toBe("NumberInCircle");
  });

  it("points the placeholder at the level being formatted", () => {
    const arabicFull = listStyleSpec("arabicFull").builtin!;
    expect(listLevelNumberFormat(arabicFull, 0)).toBe("%1\u3000");
    const daiJo = listStyleSpec("daiJo").builtin!;
    expect(listLevelNumberFormat(daiJo, 0)).toBe("第%1条");
    const parenFull = listStyleSpec("parenFull").builtin!;
    expect(listLevelNumberFormat(parenFull, 0)).toBe("（%1）");
    expect(listLevelNumberFormat(parenFull, 2)).toBe("（%3）");
    expect(listLevelNumberFormat(listStyleSpec("circled").builtin!, 3)).toBe("%4");
  });

  it("rejects unknown style names", () => {
    expect(isListStyle("kanji")).toBe(false);
  });
});
