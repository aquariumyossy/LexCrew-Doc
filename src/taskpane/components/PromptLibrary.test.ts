import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FluentProvider } from "@fluentui/react-components";
import { describe, expect, it } from "vitest";
import { SavedPrompt } from "../savedPrompts";
import { guriLightTheme } from "../theme";
import { FileAttachButton } from "./FileAttachBar";
import { PromptLibrary, PromptLibraryPanel, PromptLibraryPanelProps } from "./PromptLibrary";

function row(partial: Partial<SavedPrompt> & Pick<SavedPrompt, "id" | "title" | "body">): SavedPrompt {
  return { updatedAt: 1, ...partial };
}

function markup(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(FluentProvider, { theme: guriLightTheme }, node)
  );
}

function panel(overrides: Partial<PromptLibraryPanelProps> = {}): string {
  const props: PromptLibraryPanelProps = {
    prompts: [],
    composerText: "",
    mode: "list",
    draftTitle: "",
    pending: null,
    tooLong: false,
    onDraftTitle: () => undefined,
    onStartSave: () => undefined,
    onCommitSave: () => undefined,
    onCancelName: () => undefined,
    onPick: () => undefined,
    onConfirmRecall: () => undefined,
    onCancelConfirm: () => undefined,
    onDelete: () => undefined,
    ...overrides,
  };
  return markup(React.createElement(PromptLibraryPanel, props));
}

describe("prompt library", () => {
  it("names the notepad button on the composer", () => {
    const html = markup(
      React.createElement(PromptLibrary, {
        text: "",
        disabled: false,
        onRecall: () => undefined,
      })
    );
    expect(html).toContain('aria-label="プロンプトの保存と呼出"');
    expect(html).toContain('title="プロンプトの保存と呼出"');
  });

  it("names the clip button", () => {
    const html = markup(
      React.createElement(FileAttachButton, { disabled: false, onPick: () => undefined })
    );
    expect(html).toContain('aria-label="ファイルを添付"');
    expect(html).toContain('title="ファイルを添付"');
  });

  it("lists saved prompts newest first, with the body line under a different name", () => {
    const html = panel({
      composerText: "下書き",
      prompts: [
        row({ id: "new", title: "点検", body: "条項を直して\n続き" }),
        row({ id: "old", title: "起案", body: "請求の趣旨を書いて" }),
      ],
    });
    expect(html).toContain("この文章を保存");
    expect(html).not.toContain("保存したプロンプトはまだありません。");
    expect(html.indexOf("点検")).toBeLessThan(html.indexOf("起案"));
    expect(html).toContain("条項を直して");
    expect(html).toContain("請求の趣旨を書いて");
    expect(html).toContain('aria-label="点検 を削除"');
    expect(html).not.toContain("disabled");
  });

  it("hides the body line when it repeats the name, and says the list is empty", () => {
    const named = panel({
      prompts: [row({ id: "a", title: "点検", body: "点検" })],
    });
    expect(named.split("点検").length - 1).toBe(2);
    const empty = panel();
    expect(empty).toContain("保存したプロンプトはまだありません。");
    expect(empty).toContain("disabled");
  });

  it("says when the draft is too long to save", () => {
    const html = panel({ composerText: "あ", tooLong: true });
    expect(html).toContain("2万字を超えるので保存できません。");
  });

  it("asks before replacing a draft, and offers a name field before saving", () => {
    const confirm = panel({
      mode: "confirm",
      pending: row({ id: "a", title: "点検", body: "条項を直して" }),
    });
    expect(confirm).toContain("今の文章を置き換えます");
    expect(confirm).toContain("点検");
    expect(confirm).toContain("呼び出す");
    expect(confirm).toContain("戻る");
    const naming = panel({ mode: "name", draftTitle: "条項の点検" });
    expect(naming).toContain("条項の点検");
    expect(naming).toContain("保存");
    expect(naming).toContain("戻る");
    expect(naming).not.toContain("この文章を保存");
  });
});
