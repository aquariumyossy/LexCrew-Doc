import { describe, expect, it } from "vitest";
import { ChangeNote, CommentNote, MarkupList, emptyMarkup } from "./attachment";
import { MAX_FILE_CHARS } from "./constants";
import {
  CommittedFile,
  FileSource,
  clampFiles,
  commit,
  describeFiles,
  fileCharBudget,
  fileTextChars,
  filesChars,
  isPendingRead,
  isReady,
  mergeFiles,
  sameFile,
  shareOut,
} from "./fileSource";

function file(name: string, body: string, over: Partial<CommittedFile> = {}): CommittedFile {
  return {
    id: name,
    name,
    origin: "text",
    body,
    comments: emptyMarkup<CommentNote>(),
    changes: emptyMarkup<ChangeNote>(),
    truncated: false,
    size: body.length,
    mtime: 1,
    ...over,
  };
}

describe("fileCharBudget", () => {
  it("gives files their own share rather than a slice of the document's", () => {
    // 131,072 tokens * 0.25 * 1.6 chars stays under the ceiling now that the
    // characters-per-token estimate matches what the server actually counts.
    expect(fileCharBudget(131_072)).toBeLessThan(MAX_FILE_CHARS);
    expect(fileCharBudget(131_072)).toBe(52_428);
    expect(fileCharBudget(32_768)).toBe(13_107);
  });

  it("yields to what the rest of the request already takes", () => {
    // A narrow window with a full document attached leaves no room for files.
    expect(fileCharBudget(4_096, 6_600)).toBe(0);
    expect(fileCharBudget(32_768, 40_000)).toBe(1_943);
  });

  it("is zero for a window that makes no sense", () => {
    expect(fileCharBudget(0)).toBe(0);
    expect(fileCharBudget(Number.NaN)).toBe(0);
  });
});

describe("shareOut", () => {
  it("returns the sizes when they all fit", () => {
    expect(shareOut([10, 20], 100)).toEqual([10, 20]);
  });

  it("gives a small file what it needs and the rest to the large one", () => {
    expect(shareOut([10, 500], 100)).toEqual([10, 90]);
  });

  it("splits evenly when every file wants more than its share", () => {
    expect(shareOut([500, 500, 500], 99)).toEqual([33, 33, 33]);
  });

  it("hands nothing out of an empty budget", () => {
    expect(shareOut([10, 20], 0)).toEqual([0, 0]);
  });
});

describe("clampFiles", () => {
  it("leaves the files alone when they fit", () => {
    const files = [file("a.txt", "あ".repeat(10))];
    expect(clampFiles(files, 100)).toBe(files);
  });

  it("cuts the greedy file and marks it, sparing the small one", () => {
    const small = file("小.txt", "あ".repeat(10));
    const large = file("大.txt", "い".repeat(500));
    const [keptSmall, keptLarge] = clampFiles([small, large], 100);
    expect(keptSmall.body).toHaveLength(10);
    expect(keptSmall.truncated).toBe(false);
    expect(keptLarge.body).toHaveLength(90);
    expect(keptLarge.truncated).toBe(true);
    expect(filesChars([keptSmall, keptLarge])).toBeLessThanOrEqual(100);
  });

  it("keeps room for the markup of a cut file", () => {
    const comments: MarkupList<CommentNote> = {
      items: [
        {
          author: "乙",
          date: "2026-03-01",
          resolved: false,
          anchor: "",
          content: "う".repeat(20),
          replies: [],
        },
      ],
      truncated: false,
      error: "",
    };
    const big = file("契約.docx", "あ".repeat(400), { comments });
    const [kept] = clampFiles([big], 200);
    expect(kept.comments.items).toHaveLength(1);
    expect(kept.body.length).toBeLessThan(400);
    expect(fileTextChars(kept)).toBeLessThanOrEqual(200);
  });
});

describe("mergeFiles", () => {
  it("is idempotent, so a retried send leaves one copy", () => {
    const once = mergeFiles([], [file("a.txt", "あ")]);
    const twice = mergeFiles(once, [file("a.txt", "あ")]);
    expect(twice).toHaveLength(1);
  });

  it("replaces a stale read of the same name", () => {
    const kept = mergeFiles([], [file("契約.docx", "旧")]);
    const merged = mergeFiles(kept, [{ ...file("契約.docx", "新"), id: "second", mtime: 2 }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe("新");
    expect(merged[0].id).toBe("second");
  });

  it("keeps different names side by side in the order they arrived", () => {
    const merged = mergeFiles([file("a.txt", "あ")], [file("b.txt", "い")]);
    expect(merged.map((row) => row.name)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("sameFile", () => {
  it("is the same file only when name, size and stamp all match", () => {
    const base = { name: "契約.docx", size: 10, mtime: 100 };
    expect(sameFile(base, { ...base })).toBe(true);
    expect(sameFile(base, { ...base, mtime: 101 })).toBe(false);
    expect(sameFile(base, { ...base, size: 11 })).toBe(false);
    expect(sameFile(base, { ...base, name: "契約_改.docx" })).toBe(false);
  });
});

describe("FileSource states", () => {
  const picked = { size: 10, mtime: 1 };
  const states: FileSource[] = [
    { id: "1", name: "a.pdf", ...picked, status: "extracting" },
    { id: "2", name: "b.pdf", ...picked, status: "ocr", done: 2, total: 5 },
    { id: "3", name: "c.txt", ...picked, status: "error", message: "読めません" },
  ];

  it("knows which file it is before the read finishes", () => {
    // A second drop of the same bytes has to be recognised mid-read.
    expect(states.every((state) => sameFile(state, { ...state }))).toBe(true);
  });

  it("blocks sending only while a file is still being read", () => {
    expect(states.map(isPendingRead)).toEqual([true, true, false]);
  });

  it("commits only a ready file, carrying its identity", () => {
    const ready: FileSource = {
      ...file("d.txt", "あ"),
      status: "ready",
    };
    expect(states.some(isReady)).toBe(false);
    expect(isReady(ready)).toBe(true);
    const committed = commit(ready);
    expect(committed).not.toHaveProperty("status");
    expect(committed.size).toBe(1);
    expect(committed.mtime).toBe(1);
  });
});

describe("describeFiles", () => {
  it("names a single file and counts several", () => {
    expect(describeFiles([{ name: "契約.pdf" }], 1200)).toBe("契約.pdf 1,200 字");
    expect(describeFiles([{ name: "a" }, { name: "b" }], 12400)).toBe(
      "添付ファイル 2 件 12,400 字"
    );
    expect(describeFiles([], 0)).toBe("");
  });
});
