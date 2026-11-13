import { describe, expect, it } from "vitest";
import { checkRequest, emptyCheckMessage, jumpTarget, rowLabel, type StatuteHit } from "./statuteCheck";

const hit = (over: Partial<StatuteHit> = {}): StatuteHit => ({
  citation: "民法第415条第1項",
  status: "match",
  label: "一致",
  reason: "",
  diff: "",
  articleText: "債務者がその債務の本旨に従った履行をしないとき",
  asOf: "2026-11-11",
  source: "e-Gov法令検索",
  offlineNote: "",
  anchor: "民法第415条第1項",
  occurrence: 0,
  ...over,
});

describe("条文照合 button", () => {
  it("checks the selection when there is one, otherwise the whole document", () => {
    expect(checkRequest("民法第415条", "前文", true)).toEqual({
      text: "民法第415条",
      scope: "selection",
      online: true,
    });
    expect(checkRequest("   ", "前文の民法第1条", false)).toEqual({
      text: "前文の民法第1条",
      scope: "document",
      online: false,
    });
  });

  it("labels each row and jumps to that occurrence", () => {
    expect(rowLabel(hit())).toBe("民法第415条第1項：一致");
    expect(rowLabel(hit({ citation: "民法第999条", label: "番号違い", status: "number" }))).toBe(
      "民法第999条：番号違い"
    );
    expect(rowLabel(hit({ citation: "民法附則第1条", label: "要確認", status: "review" }))).toBe(
      "民法附則第1条：要確認"
    );
    const second = hit({ anchor: "民法第1条", occurrence: 1 });
    expect(jumpTarget(second)).toEqual({ anchor: "民法第1条", occurrence: 1 });
    expect(emptyCheckMessage("document")).toContain("文書");
    expect(emptyCheckMessage("selection")).toContain("選択範囲");
  });

  it("keeps the fetched article, its date, and the source on the row", () => {
    const row = hit({ offlineNote: "改正確認できず（オフライン）" });
    expect(row.articleText).toContain("債務者");
    expect(row.asOf).toBe("2026-11-11");
    expect(row.source).toBe("e-Gov法令検索");
    expect(row.offlineNote).toBe("改正確認できず（オフライン）");
  });
});
