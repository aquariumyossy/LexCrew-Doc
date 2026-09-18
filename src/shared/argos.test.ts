import { describe, expect, it } from "vitest";
import {
  argosButtonLabel,
  argosFolderListLabel,
  collapseArgosScopes,
  joinArgosScopes,
  matchesArgosFilter,
  parseArgosScopes,
} from "./argos";

describe("argos scopes", () => {
  it("joins and parses newline-separated prefixes", () => {
    expect(parseArgosScopes("C:\\a\n\nC:\\b")).toEqual(["C:\\a", "C:\\b"]);
    expect(joinArgosScopes(["C:\\a", "C:\\a\\child", "C:\\b"])).toBe("C:\\a\nC:\\b");
  });

  it("drops children when a parent is selected and caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => `C:\\f${i}`);
    expect(collapseArgosScopes(many)).toHaveLength(8);
    expect(collapseArgosScopes(["C:\\案件", "C:\\案件\\甲"])).toEqual(["C:\\案件"]);
  });

  it("labels the composer button", () => {
    expect(argosButtonLabel("")).toBe("argos");
    expect(argosButtonLabel("C:\\案件A")).toBe("argos: 案件A");
    expect(argosButtonLabel("C:\\案件A\nC:\\案件B")).toBe("argos: 案件A ほか1件");
    expect(argosButtonLabel("mailfolder:user@firm / 受信トレイ")).toBe(
      "argos: 受信トレイ（user@firm）"
    );
  });

  it("builds nested folder labels from the root path", () => {
    const root = { path: "C:\\案件", label: "案件（柴田さん共有）", isRoot: true };
    const child = { path: "C:\\案件\\20130301建築", label: "20130301建築", isRoot: false };
    const grand = {
      path: "C:\\案件\\20130301建築\\201304重要",
      label: "201304重要",
      isRoot: false,
    };
    expect(argosFolderListLabel(root, [root])).toBe("案件（柴田さん共有）");
    expect(argosFolderListLabel(child, [root])).toBe("20130301建築");
    expect(argosFolderListLabel(grand, [root])).toBe("20130301建築 / 201304重要");
  });

  it("filters by folder name on the client", () => {
    const row = { path: "C:\\案件\\契約", label: "契約", isRoot: false };
    expect(matchesArgosFilter(row, "契約")).toBe(true);
    expect(matchesArgosFilter(row, "契約書")).toBe(false);
    expect(matchesArgosFilter(row, "C:\\案件")).toBe(true);
    expect(matchesArgosFilter(row, "")).toBe(true);
  });
});
