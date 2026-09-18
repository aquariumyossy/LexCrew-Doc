import { describe, expect, it } from "vitest";
import { MAX_ATTACHED_FILES, MAX_IMAGE_BYTES, MAX_PDF_BYTES } from "./constants";
import { ACCEPTED_EXTENSIONS, fileKind, rejectReason, tooManyFiles } from "./fileExtract";

describe("fileKind", () => {
  it("reads the extension whatever its case", () => {
    expect(fileKind("契約.DOCX")).toBe("docx");
    expect(fileKind("費用.xlsx")).toBe("sheet");
    expect(fileKind("訴状.pdf")).toBe("pdf");
    expect(fileKind("メモ.md")).toBe("text");
    expect(fileKind("控え.JPG")).toBe("image");
  });

  it("has no kind for a name without one", () => {
    expect(fileKind("README")).toBeNull();
    expect(fileKind("")).toBeNull();
  });

  it("offers every kind it can read to the file picker", () => {
    expect(ACCEPTED_EXTENSIONS).toContain(".docx");
    expect(ACCEPTED_EXTENSIONS).not.toContain(".xls");
  });
});

describe("rejectReason", () => {
  it("accepts a file it can read", () => {
    expect(rejectReason({ name: "契約.docx", size: 1024 })).toBe("");
  });

  it("tells the user what to save an old Office file as", () => {
    expect(rejectReason({ name: "契約.doc", size: 1024 })).toContain(".docx");
    expect(rejectReason({ name: "費用.xls", size: 1024 })).toContain(".xlsx");
    expect(rejectReason({ name: "訴状.jtd", size: 1024 })).toContain("PDF");
  });

  it("refuses a form it has no reader for", () => {
    expect(rejectReason({ name: "録音.mp3", size: 1024 })).toContain("読めません");
  });

  it("refuses an empty file before reading it", () => {
    expect(rejectReason({ name: "空.txt", size: 0 })).toBe("中身が空です。");
  });

  it("holds images to a tighter cap than documents", () => {
    expect(rejectReason({ name: "写.png", size: MAX_IMAGE_BYTES + 1 })).toContain("8MB");
    expect(rejectReason({ name: "写.png", size: MAX_IMAGE_BYTES })).toBe("");
    expect(rejectReason({ name: "訴状.pdf", size: MAX_IMAGE_BYTES + 1 })).toBe("");
    expect(rejectReason({ name: "訴状.pdf", size: MAX_PDF_BYTES + 1 })).toContain("20MB");
  });
});

describe("tooManyFiles", () => {
  it("counts what is already attached, committed or not", () => {
    expect(tooManyFiles(MAX_ATTACHED_FILES - 1, 1)).toBe(false);
    expect(tooManyFiles(MAX_ATTACHED_FILES - 1, 2)).toBe(true);
  });
});
