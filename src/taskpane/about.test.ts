import { describe, expect, it } from "vitest";
import { aboutCopy, DISCLAIMER } from "./about";

describe("aboutCopy", () => {
  it("keeps the disclaimer in the overview", () => {
    expect(aboutCopy.overview).toContain(DISCLAIMER);
  });

  it("names each runtime license", () => {
    expect(Object.fromEntries(aboutCopy.licenses.map((row) => [row.name, row.license]))).toEqual({
      JSZip: "MIT",
      "pdf.js": "Apache-2.0",
      "react-markdown": "MIT",
      rusqlite: "MIT",
    });
    expect(aboutCopy.licenses.find((row) => row.name === "JSZip")?.choice).toBe(
      "MIT または GPL-3.0。本アプリは MIT。"
    );
  });

  it("explains features without the inference engine", () => {
    const text = [
      aboutCopy.overview.join("\n"),
      ...aboutCopy.features.map((feature) => `${feature.title}\n${feature.body}`),
    ].join("\n");
    expect(text).not.toMatch(/MTPLX|LLM|推論|SearXNG/);
    expect(aboutCopy.features.map((feature) => feature.title)).toEqual([
      "指示して文書を直す",
      "コメントと変更履歴",
      "参考にする情報",
      "ファイル",
      "履歴",
    ]);
    expect(aboutCopy.features[0]?.body).toContain("表、罫線、ページ余白は変えられません。");
    expect(aboutCopy.features[1]?.body).toContain("コメントへの返信、変更の受入れ・却下はできません。");
  });

  it("credits the developer", () => {
    expect(aboutCopy.credit).toBe("弁護士　吉田秀平");
  });
});
