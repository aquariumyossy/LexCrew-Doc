import { describe, expect, it } from "vitest";
import { guriLightTheme } from "./theme";
import { uiFontScale } from "./uiFont";

describe("uiFontScale", () => {
  it("uses KURU's 12, 14, and 16px roots", () => {
    expect(uiFontScale("small")).toBe(0.8571428571428571);
    expect(uiFontScale("medium")).toBe(1);
    expect(uiFontScale("large")).toBe(1.1428571428571428);
  });
});

describe("guriLightTheme", () => {
  it("scales the base font with the screen size variable", () => {
    expect(guriLightTheme.fontSizeBase300).toBe("calc(14px * var(--guri-ui-scale, 1))");
    expect(guriLightTheme.lineHeightBase300).toBe("calc(20px * var(--guri-ui-scale, 1))");
    expect(guriLightTheme.colorNeutralForeground1).toBe("#0e344e");
  });
});
