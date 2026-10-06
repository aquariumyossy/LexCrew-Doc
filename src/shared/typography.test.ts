import { describe, expect, it } from "vitest";
import { resolveInsertFormats, SampledParagraph, SettingsFormat } from "./typography";

const settings: SettingsFormat = {
  fontName: "游明朝",
  bodyPt: 12,
  titlePt: 16,
  lineSpacingChars: 1,
};

function face(partial: Partial<SampledParagraph> & Pick<SampledParagraph, "text">): SampledParagraph {
  return {
    text: partial.text,
    name: partial.name ?? "游明朝",
    nameFarEast: partial.nameFarEast ?? partial.name ?? "游明朝",
    sizePt: partial.sizePt ?? 12,
    centered: partial.centered ?? false,
    heading: partial.heading ?? false,
    inTable: partial.inTable ?? false,
    spacing: partial.spacing ?? { kind: "keep" },
  };
}

describe("resolveInsertFormats", () => {
  it("uses settings when the document has no body and no request", () => {
    const resolved = resolveInsertFormats({}, [], 0, settings, false);
    expect(resolved.body.font).toEqual({ write: true, name: "游明朝", nameFarEast: "游明朝" });
    expect(resolved.body.size).toEqual({ write: true, pt: 12 });
    expect(resolved.title.size).toEqual({ write: true, pt: 16 });
    expect(resolved.body.spacing).toEqual({ kind: "exact", pt: 12 });
    expect(resolved.title.spacing).toEqual({ kind: "exact", pt: 16 });
    expect(resolved.body.applyIndent).toBe(true);
  });

  it("lets a requested size win and keeps the nearby font and spacing", () => {
    const samples = [
      face({
        text: "前文",
        name: "游ゴシック",
        nameFarEast: "游ゴシック",
        sizePt: 10.5,
        spacing: { kind: "keep" },
      }),
    ];
    const resolved = resolveInsertFormats({ bodyPt: 14 }, samples, 0, settings, true);
    expect(resolved.body.font).toEqual({ write: true, name: "游ゴシック", nameFarEast: "游ゴシック" });
    expect(resolved.body.size).toEqual({ write: true, pt: 14 });
    expect(resolved.body.spacing).toEqual({ kind: "keep" });
    expect(resolved.body.applyIndent).toBe(false);
  });

  it("turns a requested character line spacing into exact points and drops the sample grid", () => {
    const samples = [
      face({
        text: "前文",
        sizePt: 12,
        spacing: { kind: "copy", line: "360", lineRule: "auto" },
      }),
    ];
    const resolved = resolveInsertFormats({ lineSpacingChars: 1.5 }, samples, 0, settings, true);
    expect(resolved.body.spacing).toEqual({ kind: "exact", pt: 18 });
    expect(resolved.title.spacing).toEqual({ kind: "exact", pt: 18 });
  });

  it("leaves unread fields unset when the document has text but no face", () => {
    const resolved = resolveInsertFormats({}, [], 0, settings, true);
    expect(resolved.body.font).toEqual({ write: false });
    expect(resolved.body.size).toEqual({ write: false });
    expect(resolved.body.spacing).toEqual({ kind: "keep" });
    expect(resolved.body.applyIndent).toBe(false);
  });

  it("writes a requested size even when the face cannot be read", () => {
    const resolved = resolveInsertFormats({ bodyPt: 14 }, [], 0, settings, true);
    expect(resolved.body.font).toEqual({ write: false });
    expect(resolved.body.size).toEqual({ write: true, pt: 14 });
    expect(resolved.title.size).toEqual({ write: false });
  });

  it("uses the title face for the body font, and settings for the body size, when that is the only sample", () => {
    const samples = [
      face({ text: "訴状", sizePt: 18, centered: true, name: "游明朝", spacing: { kind: "keep" } }),
    ];
    const resolved = resolveInsertFormats({}, samples, 0, settings, true);
    expect(resolved.body.font).toEqual({ write: true, name: "游明朝", nameFarEast: "游明朝" });
    expect(resolved.body.size).toEqual({ write: true, pt: 12 });
    expect(resolved.title.size).toEqual({ write: true, pt: 18 });
    expect(resolved.body.spacing).toEqual({ kind: "keep" });
  });

  it("prefers the nearer body paragraph behind the anchor", () => {
    const samples = [
      face({ text: "遠い", name: "ＭＳ 明朝", sizePt: 12 }),
      face({ text: "近い", name: "游ゴシック", sizePt: 11 }),
      face({ text: "見出し", name: "游明朝", sizePt: 12, heading: true }),
    ];
    const resolved = resolveInsertFormats({}, samples, 2, settings, true);
    expect(resolved.body.font).toEqual({ write: true, name: "游ゴシック", nameFarEast: "游ゴシック" });
    expect(resolved.body.size).toEqual({ write: true, pt: 11 });
  });

  it("copies an east-asian name into the ascii slot when that slot is empty", () => {
    const samples = [face({ text: "本文", name: "", nameFarEast: "游明朝", sizePt: 12 })];
    const resolved = resolveInsertFormats({}, samples, 0, settings, true);
    expect(resolved.body.font).toEqual({ write: true, name: "游明朝", nameFarEast: "游明朝" });
  });

  it("does not treat a table cell or a centered line as the body face", () => {
    const samples = [
      face({ text: "表", name: "ＭＳ ゴシック", sizePt: 9, inTable: true }),
      face({ text: "日付", name: "游明朝", sizePt: 12, centered: true }),
      face({ text: "原告は請求する。", name: "游明朝", sizePt: 10.5 }),
    ];
    const resolved = resolveInsertFormats({}, samples, 0, settings, true);
    expect(resolved.body.size).toEqual({ write: true, pt: 10.5 });
    expect(resolved.title.size).toEqual({ write: true, pt: 12 });
  });
});
