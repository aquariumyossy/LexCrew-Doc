import { describe, expect, it } from "vitest";
import { isQuestionInstruction } from "./questionTurn";

const reported =
  "AIオプションのみの解約を認めない建付けは、現在のクライアントの要望から導き出されたものなの？AIオプションのみ解約できるとした場合の不都合はある？\n本文は修正しないでチャットで答えて";

describe("isQuestionInstruction", () => {
  it("catches the reported question", () => {
    expect(isQuestionInstruction(reported)).toBe(true);
  });

  it("does not catch an ordinary edit", () => {
    expect(isQuestionInstruction("見出しを直して")).toBe(false);
    expect(isQuestionInstruction("第2条を短くして")).toBe(false);
    expect(isQuestionInstruction("この条項を点検してコメントして")).toBe(false);
    expect(isQuestionInstruction("第1条の次に入れて")).toBe(false);
  });

  it("catches question words, の？, and a trailing question mark", () => {
    expect(isQuestionInstruction("なぜこう書いた")).toBe(true);
    expect(isQuestionInstruction("何故ですか")).toBe(true);
    expect(isQuestionInstruction("どうしてこの条にした")).toBe(true);
    expect(isQuestionInstruction("理由を教えて")).toBe(true);
    expect(isQuestionInstruction("導き出されたものなの？")).toBe(true);
    expect(isQuestionInstruction("これは何ですか？")).toBe(true);
    expect(isQuestionInstruction("is this ok?")).toBe(true);
  });

  it("catches an explicit request to answer in chat", () => {
    expect(isQuestionInstruction("本文は変更しないで")).toBe(true);
    expect(isQuestionInstruction("チャットで答えて")).toBe(true);
    expect(isQuestionInstruction("修正しないでください")).toBe(true);
  });

  it("ignores a blank instruction", () => {
    expect(isQuestionInstruction("  ")).toBe(false);
    expect(isQuestionInstruction("")).toBe(false);
  });

  it("does not treat an edit that mentions しないで, 理由, or a request form as a question", () => {
    expect(isQuestionInstruction("書式は変更しないで文言だけ直して")).toBe(false);
    expect(isQuestionInstruction("解除理由を追記して")).toBe(false);
    expect(isQuestionInstruction("理由を本文に書いて")).toBe(false);
    expect(isQuestionInstruction("見出しを太字にしてくれる？")).toBe(false);
    expect(isQuestionInstruction("この条を直してもらえますか？")).toBe(false);
    expect(isQuestionInstruction("対応してもらえますか？")).toBe(false);
    expect(isQuestionInstruction("見出しを整えてくれますか？")).toBe(false);
    expect(isQuestionInstruction("見出しを直してください")).toBe(false);
  });

  it("catches a request to explain unless the main request is an edit", () => {
    expect(isQuestionInstruction("趣旨を教えて")).toBe(true);
    expect(isQuestionInstruction("どういう意味ですか")).toBe(true);
    expect(isQuestionInstruction("説明して")).toBe(true);
    expect(isQuestionInstruction("なんで")).toBe(true);
    expect(isQuestionInstruction("なぜ直してないの？")).toBe(true);
    expect(isQuestionInstruction("説明してから見出しを直して")).toBe(false);
    expect(isQuestionInstruction("趣旨を教えて、文言を直して")).toBe(false);
  });
});
