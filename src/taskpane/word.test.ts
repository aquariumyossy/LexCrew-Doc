import { afterEach, describe, expect, it } from "vitest";
import { mapBlocks } from "../shared/blocks";
import {
  formatList,
  formatParagraph,
  getDocumentStats,
  getSelectionInfo,
  getSelectionText,
  insertCitationText,
  insertBlankBefore,
  insertComment,
  insertDraftParagraphs,
  readAttachment,
  setOutlineLevel,
  readDocumentText,
  replaceQuote,
} from "./word";

/* global globalThis */

type Replacement = { target: string; text: string };

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

type FakeComment = {
  author: string;
  date: Date;
  resolved?: boolean;
  anchor: string;
  content: string;
  replies?: { author: string; date: Date; content: string }[];
};

type FakeChange = { type: string; author: string; date: Date; text: string; where: string };

type WordOptions = {
  selection: string;
  body: string;
  paragraphs?: string[];
  /** Reviewed text per paragraph; defaults to paragraphs without trailing \\r. */
  reviewedParagraphs?: string[];
  markupComments?: FakeComment[];
  markupChanges?: FakeChange[];
  /** Word refusing the call at all, as a tracked move does to getTrackedChanges. */
  commentsFail?: string;
  changesFail?: string;
  /** Sync number after which every sync throws, to lose the extras but not the list. */
  failSyncAfter?: number;
  /** False stands for a Word too old for tracked changes. */
  wordApi16?: boolean;
  /** False stands for a Word too old for getReviewedText. */
  wordApi14?: boolean;
  /** When set, getReviewedText sync throws after this many syncs. */
  reviewedFailAfter?: number;
  /** Parallel to `paragraphs`. null is not a list item; a string is listString. */
  listStrings?: (string | null)[];
  /** False stands for a Word without separateList. */
  wordApiDesktop14?: boolean;
  /** False stands for a Word without listFormat.listTemplate (builtin list styles). */
  wordApiDesktop13?: boolean;
  /** Layout page index Word would report for a hit. Omitted means pages cannot be read. */
  pageIndex?: number;
  /** Per-paragraph tracked changes for resolveTarget deletion checks. */
  paragraphChanges?: FakeChange[][];
};

/**
 * Enough of Word.run for the quote-resolving paths: a selection and a body that
 * each report how many times the needle occurs, and ranges that record what was
 * written to them. Comments and tracked changes are served from plain objects.
 */
type FakeParagraph = {
  text: string;
  isListItem: boolean;
  listString: string;
  /** Which list the paragraph belongs to, and how deep: Word counts per list. */
  listOrNullObject: { id: number };
  listItemOrNullObject: { level: number };
  detachFromList: () => void;
  startNewList: () => unknown;
  outlineLevel: number;
  style: string;
  styleBuiltIn: string;
  outlineWrites: number;
  firstLineIndent: number;
  leftIndent: number;
  spaceBefore: number;
  spaceAfter: number;
  lineUnitBefore: number;
  lineUnitAfter: number;
  restyleOnOutline: boolean;
  ignoreOutline: boolean;
  font: { bold: boolean; name: string; nameFarEast: string; size: number };
};

function installWord(options: WordOptions): {
  replacements: Replacement[];
  comments: string[];
  paragraphs: FakeParagraph[];
  levelWrites: Array<{ level: number; format: string }>;
  getTracking: () => string;
} {
  const replacements: Replacement[] = [];
  const comments: string[] = [];

  const stripSpace = (value: string) => value.replace(/[\s\u3000]/g, "");
  const makeRange = (text: string) => ({
    text,
    load: () => undefined,
    insertText: (value: string) => replacements.push({ target: text, text: value }),
    insertComment: (value: string) => comments.push(value),
    // Word's own ignoreSpace is what runs in production; here it only has to
    // prove the second pass happens and the first one is preferred.
    pages:
      options.pageIndex === undefined
        ? undefined
        : { load: () => undefined, items: [{ index: options.pageIndex }] },
    search: (needle: string, options?: { ignoreSpace?: boolean }) => {
      const haystack = options?.ignoreSpace ? stripSpace(text) : text;
      const target = options?.ignoreSpace ? stripSpace(needle) : needle;
      return {
        load: () => undefined,
        items: Array.from({ length: countOccurrences(haystack, target) }, () => makeRange(needle)),
      };
    },
  });

  const getComments = () => {
    if (options.commentsFail) {
      throw new Error(options.commentsFail);
    }
    return {
      load: () => undefined,
      items: (options.markupComments || []).map((comment) => ({
        authorName: comment.author,
        creationDate: comment.date,
        content: comment.content,
        resolved: comment.resolved === true,
        getRange: () => makeRange(comment.anchor),
        replies: {
          load: () => undefined,
          items: (comment.replies || []).map((reply) => ({
            authorName: reply.author,
            creationDate: reply.date,
            content: reply.content,
          })),
        },
      })),
    };
  };

  const getTrackedChanges = () => {
    if (options.changesFail) {
      throw new Error(options.changesFail);
    }
    return {
      load: () => undefined,
      items: (options.markupChanges || []).map((change) => ({
        type: change.type,
        author: change.author,
        date: change.date,
        text: change.text,
        getRange: () => ({
          paragraphs: { getFirst: () => ({ text: change.where, load: () => undefined }) },
        }),
      })),
    };
  };

  // Every rewrite of a list level, which is what restarts its count in Word.
  const levelWrites: Array<{ level: number; format: string }> = [];
  // Stable paragraphs so list operations can find the same object again.
  let nextListId = 1;
  let draftTail: { insertParagraph: (value: string, where: string) => unknown } | null = null;
  const makeParagraph = (
    text: string,
    listString: string | null = null,
    listId: number | null = null,
    index = 0
  ) => {
    const reviewed =
      options.reviewedParagraphs?.[index] ??
      text.replace(/\r$/, "");
    const tracked = options.paragraphChanges?.[index] || [];
    const state = {
      text,
      isListItem: listString !== null,
      listString: listString || "",
      listId: listString !== null ? (listId ?? nextListId++) : (null as number | null),
      level: 0,
      builtinFormat: "",
      builtinStyle: "",
      outlineLevel: 10,
      styleName: "標準",
      styleBuiltIn: "Normal",
      outlineWrites: 0,
      restyleOnOutline: false,
      ignoreOutline: false,
    };
    // Word renders the label once both halves are in, and only prints the
    // counter of a level that has items: a placeholder naming another level
    // leaves a gap where the number should be.
    const makeBuiltinLevel = (index: number) => ({
      set numberStyle(style: string) {
        state.builtinStyle = style;
      },
      set numberFormat(format: string) {
        levelWrites.push({ level: index, format });
        if (index !== state.level) {
          return;
        }
        state.builtinFormat = format;
        const glyph =
          state.builtinStyle === "Aiueo"
            ? "ア"
            : state.builtinStyle === "NumberInCircle"
              ? "①"
              : "１";
        state.listString = format.replace(`%${index + 1}`, glyph).replace(/%\d/g, "");
      },
      set trailingCharacter(_value: string) {
        // Word ignores trailing chars when the format is self-contained.
      },
    });
    const listObject = () => ({
      get isNullObject() {
        return !state.isListItem;
      },
      get id() {
        return state.listId || 0;
      },
      get levelTypes() {
        const glyph = state.listString.trim();
        if (glyph && /^[\uE000-\uF8FF•●○■□◆◇‣·∙\-–—*＊・]$/.test(glyph)) {
          return ["Bullet"];
        }
        return ["Number"];
      },
      load: () => undefined,
      setLevelNumbering: (_level: number, numbering: string, format?: Array<string | number>) => {
        if (format && format[0] === "(") {
          state.listString = `(1)`;
          return;
        }
        if (numbering === "LowerLetter") {
          state.listString = "a.";
          return;
        }
        state.listString = "1.";
      },
      setLevelStartingNumber: (_level: number, start: number) => {
        state.listString = `${start}.`;
      },
    });
    const paragraph: FakeParagraph & {
      load: () => undefined;
      getOoxml: () => { value: string };
      insertText: (value: string) => void;
      insertComment: (value: string) => void;
      search: ReturnType<typeof makeRange>["search"];
      getReviewedText: () => { value: string };
      getTrackedChanges: () => {
        load: () => undefined;
        items: Array<{ type: string; author: string; date: Date; text: string }>;
      };
      getRange: () => unknown;
      paragraphs: { load: () => undefined; items: unknown[] };
      listItemOrNullObject: ReturnType<typeof listObject> & { listString: string; level: number };
      listOrNullObject: ReturnType<typeof listObject>;
      list: ReturnType<typeof listObject>;
      listItem: { level: number };
      attachToList: (id: number, level: number) => void;
      separateList: () => void;
      insertParagraph: (value: string, _where: string) => unknown;
      select: () => undefined;
      alignment: string;
      firstLineIndent: number;
      leftIndent: number;
      font: { bold: boolean; name: string; nameFarEast: string; size: number };
    } = {
      get text() {
        return state.text;
      },
      get isListItem() {
        return state.isListItem;
      },
      get listString() {
        return state.listString;
      },
      load: () => undefined,
      getOoxml: () => ({ value: "" }),
      insertText: (value: string) => replacements.push({ target: state.text, text: value }),
      insertComment: (value: string) => comments.push(value),
      search: makeRange(text).search,
      getReviewedText: () => ({
        value: reviewed,
      }),
      getTrackedChanges: () => ({
        load: () => undefined,
        items: tracked.map((change) => ({
          type: change.type,
          author: change.author,
          date: change.date,
          text: change.text,
        })),
      }),
      getRange: () => ({
        ...makeRange(state.text),
        // Which paragraph this range covers, for compareLocationWith.
        owner: state,
        compareLocationWith: (other: { owner?: unknown }) => ({
          value: other.owner === state ? "Equal" : "Unrelated",
        }),
        insertBookmark: () => {
          draftTail = paragraph;
        },
        listFormat: {
          listTemplate: {
            listLevels: {
              load: () => undefined,
              items: Array.from({ length: 9 }, (_, index) => makeBuiltinLevel(index)),
            },
          },
        },
        paragraphs: {
          load: () => undefined,
          items: [paragraph],
          getFirst: () => paragraph,
          getLast: () => paragraph,
        },
      }),
      paragraphs: { load: () => undefined, items: [] },
      get listItemOrNullObject() {
        return {
          ...listObject(),
          get isNullObject() {
            return !state.isListItem;
          },
          get listString() {
            return state.listString;
          },
          get level() {
            return state.level;
          },
        };
      },
      get listOrNullObject() {
        return listObject();
      },
      get list() {
        return listObject();
      },
      get listItem() {
        return {
          get level() {
            return state.level;
          },
          set level(value: number) {
            state.level = value;
          },
        };
      },
      startNewList: () => {
        state.isListItem = true;
        state.listId = nextListId++;
        state.listString = "1.";
        return listObject();
      },
      attachToList: (id: number, level: number) => {
        state.isListItem = true;
        state.listId = id;
        state.level = level;
        state.listString = state.listString || "1.";
      },
      detachFromList: () => {
        state.isListItem = false;
        state.listId = null;
        state.listString = "";
      },
      separateList: () => {
        state.listId = nextListId++;
        state.listString = "1.";
      },
      insertParagraph: (value: string, where: string) => {
        const created = makeParagraph(`${value}\r`, null);
        created.styleBuiltIn = paragraph.styleBuiltIn;
        created.style = paragraph.style;
        created.firstLineIndent = paragraph.firstLineIndent;
        created.leftIndent = paragraph.leftIndent;
        created.spaceBefore = paragraph.spaceBefore;
        created.spaceAfter = paragraph.spaceAfter;
        created.lineUnitBefore = paragraph.lineUnitBefore;
        created.lineUnitAfter = paragraph.lineUnitAfter;
        if (state.isListItem && state.listId !== null) {
          created.attachToList(state.listId, state.level);
        }
        const index = bodyParagraphs.indexOf(paragraph);
        const at = index < 0 ? bodyParagraphs.length : where === "Before" ? index : index + 1;
        bodyParagraphs.splice(at, 0, created);
        options.paragraphs?.splice(at, 0, value);
        if (options.listStrings) {
          options.listStrings.splice(at, 0, created.isListItem ? created.listString : null);
        }
        return created;
      },
      select: () => undefined,
      alignment: "",
      firstLineIndent: 0,
      leftIndent: 0,
      spaceBefore: 0,
      spaceAfter: 0,
      lineUnitBefore: 0,
      lineUnitAfter: 0,
      font: { bold: false, name: "", nameFarEast: "", size: 12 },
      get outlineLevel() {
        return state.outlineLevel;
      },
      set outlineLevel(value: number) {
        state.outlineWrites += 1;
        if (state.restyleOnOutline) {
          state.styleName = "見出し 1";
        }
        if (!state.ignoreOutline) {
          state.outlineLevel = value;
        }
      },
      get style() {
        return state.styleName;
      },
      set style(value: string) {
        state.styleName = value;
      },
      get styleBuiltIn() {
        return state.styleBuiltIn;
      },
      set styleBuiltIn(value: string) {
        state.styleBuiltIn = value;
      },
      get outlineWrites() {
        return state.outlineWrites;
      },
      get restyleOnOutline() {
        return state.restyleOnOutline;
      },
      set restyleOnOutline(value: boolean) {
        state.restyleOnOutline = value;
      },
      get ignoreOutline() {
        return state.ignoreOutline;
      },
      set ignoreOutline(value: boolean) {
        state.ignoreOutline = value;
      },
    };
    paragraph.paragraphs = { load: () => undefined, items: [paragraph] };
    return paragraph;
  };

  const bodyParagraphs: FakeParagraph[] = [];
  let currentListId: number | null = null;
  for (let index = 0; index < (options.paragraphs || []).length; index += 1) {
    const text = (options.paragraphs || [])[index];
    const mark = options.listStrings ? (options.listStrings[index] ?? null) : null;
    if (mark === null) {
      currentListId = null;
      bodyParagraphs.push(makeParagraph(`${text}\r`, null, null, index));
    } else {
      if (currentListId === null) {
        currentListId = nextListId++;
      }
      bodyParagraphs.push(makeParagraph(`${text}\r`, mark, currentListId, index));
    }
  }

  const syncBodyParagraphs = () => {
    const texts = options.paragraphs;
    if (!texts) {
      return bodyParagraphs;
    }
    const next = texts.map((text, index) => {
      const existing = bodyParagraphs[index];
      if (existing && existing.text.replaceAll("\r", "") === text.replace(/\r$/, "")) {
        return existing;
      }
      const mark = options.listStrings ? (options.listStrings[index] ?? null) : null;
      return makeParagraph(text.endsWith("\r") ? text : `${text}\r`, mark, null, index);
    });
    bodyParagraphs.length = 0;
    bodyParagraphs.push(...next);
    return bodyParagraphs;
  };

  const selectionParagraphs = options.selection.trim()
    ? [
        makeParagraph(
          options.selection,
          options.listStrings && options.paragraphs
            ? (options.listStrings[options.paragraphs.indexOf(options.selection)] ?? null)
            : null
        ),
      ]
    : [];

  const selection = {
    ...makeRange(options.selection),
    getComments,
    getTrackedChanges,
    paragraphs: {
      load: () => undefined,
      get items() {
        return selectionParagraphs;
      },
      getLast: () => selectionParagraphs[0] || bodyParagraphs[bodyParagraphs.length - 1],
      getFirst: () => selectionParagraphs[0] || bodyParagraphs[0],
    },
    insertParagraph: (value: string, _where: string) => {
      const after = selectionParagraphs[0] || bodyParagraphs[bodyParagraphs.length - 1];
      if (after && "insertParagraph" in after) {
        return (after as { insertParagraph: (value: string, where: string) => unknown }).insertParagraph(
          value,
          _where
        );
      }
      const created = makeParagraph(`${value}\r`, null);
      bodyParagraphs.push(created);
      return created;
    },
  };
  const bodyRange = makeRange(options.body);
  const body = {
    ...bodyRange,
    // A hit knows its paragraph, but as Word does: through a proxy of its
    // own, never the object body.paragraphs.items holds.
    search: (needle: string, searchOptions?: { ignoreSpace?: boolean }) => {
      // With no body text given, the body is whatever the paragraphs hold now,
      // inserts included.
      const live = options.body
        ? bodyRange
        : makeRange(syncBodyParagraphs().map((paragraph) => paragraph.text).join(""));
      const hits = live.search(needle, searchOptions).items;
      const dense = (value: string) => value.replace(/[\s\u3000]/g, "");
      const owners = syncBodyParagraphs().filter((paragraph) =>
        (searchOptions?.ignoreSpace ? dense(paragraph.text) : paragraph.text).includes(
          searchOptions?.ignoreSpace ? dense(needle) : needle
        )
      );
      return {
        load: () => undefined,
        items: hits.map((hit, index) => {
          const owner = owners[index];
          const proxies = owner ? [Object.create(owner) as FakeParagraph] : [];
          return {
            ...hit,
            paragraphs: {
              load: () => undefined,
              items: proxies,
              getFirst: () => proxies[0],
              getLast: () => proxies[proxies.length - 1],
            },
          };
        }),
      };
    },
    getOoxml: () => ({ value: "" }),
    paragraphs: {
      load: () => undefined,
      get items() {
        return syncBodyParagraphs();
      },
      getLast: () => {
        const items = syncBodyParagraphs();
        return items[items.length - 1];
      },
      getFirst: () => syncBodyParagraphs()[0],
    },
    getComments,
    getTrackedChanges,
    lists: {
      getByIdOrNullObject: (id: number) => {
        const members = syncBodyParagraphs().filter(
          (paragraph) => paragraph.isListItem && paragraph.listOrNullObject.id === id
        );
        return {
          isNullObject: members.length === 0,
          load: () => undefined,
          levelExistences: Array.from({ length: 9 }, (_, level) =>
            members.some((paragraph) => paragraph.listItemOrNullObject.level === level)
          ),
        };
      },
    },
  };
  let syncs = 0;
  const context = {
    document: {
      changeTrackingMode: "",
      getSelection: () => selection,
      body,
      getBookmarkRangeOrNullObject: () =>
        draftTail
          ? {
              isNullObject: false,
              paragraphs: { getLast: () => draftTail, getFirst: () => draftTail },
            }
          : { isNullObject: true, paragraphs: { getLast: () => null } },
      deleteBookmark: () => {
        draftTail = null;
      },
    },
    sync: async () => {
      syncs += 1;
      if (options.failSyncAfter !== undefined && syncs > options.failSyncAfter) {
        throw new Error("同期に失敗しました");
      }
    },
  };

  (globalThis as unknown as { Word: unknown }).Word = {
    run: (callback: (ctx: unknown) => Promise<unknown>) => callback(context),
    ChangeTrackingMode: { trackAll: "trackAll", off: "off" },
    ChangeTrackingVersion: { current: "Current", original: "Original" },
    InsertLocation: { replace: "Replace", after: "After", before: "Before" },
    BuiltInStyleName: { normal: "Normal" },
    SelectionMode: { end: "End" },
    Alignment: { centered: "Centered", left: "Left", right: "Right", justified: "Justified" },
    ListNumbering: { arabic: "Arabic", lowerLetter: "LowerLetter" },
    ListLevelType: { bullet: "Bullet", number: "Number" },
    LocationRelation: { equal: "Equal" },
  };
  (globalThis as unknown as { Office: unknown }).Office = {
    context: {
      host: "Word",
      requirements: {
        isSetSupported: (name: string, version: string) => {
          if (name === "WordApi" && version === "1.6") {
            return options.wordApi16 !== false;
          }
          if (name === "WordApi" && version === "1.4") {
            return options.wordApi14 !== false;
          }
          if (name === "WordApiDesktop" && version === "1.4") {
            return options.wordApiDesktop14 !== false;
          }
          if (name === "WordApiDesktop" && version === "1.3") {
            return options.wordApiDesktop13 !== false;
          }
          return true;
        },
      },
    },
    HostType: { Word: "Word" },
  };

  return {
    replacements,
    comments,
    paragraphs: bodyParagraphs,
    levelWrites,
    getTracking: () => context.document.changeTrackingMode,
  };
}

afterEach(() => {
  delete (globalThis as unknown as { Word?: unknown }).Word;
  delete (globalThis as unknown as { Office?: unknown }).Office;
});

/** The three fields every insert_comment call carries. */
function comment(comment: string, quote: string, paragraph?: number) {
  return { comment, quote, severity: "medium" as const, ...(paragraph ? { paragraph } : {}) };
}

describe("quote targeting", () => {
  it("replaces the one match when the quote is unique in the body", async () => {
    const word = installWord({ selection: "", body: "第1条 定義する。第2条 報酬を支払う。" });
    await replaceQuote({ quote: "報酬を支払う", text: "報酬を翌月末までに支払う" });
    expect(word.replacements).toEqual([
      { target: "報酬を支払う", text: "報酬を翌月末までに支払う" },
    ]);
  });

  it("refuses a quote that matches the body twice instead of taking the first", async () => {
    const word = installWord({ selection: "", body: "甲は、乙に対し。第5条 甲は、乙に対し。" });
    await expect(replaceQuote({ quote: "甲は、乙に対し", text: "甲は、丙に対し" })).rejects.toThrow(
      /2 箇所/
    );
    expect(word.replacements).toEqual([]);
  });

  it("refuses a quote that matches the selection twice", async () => {
    installWord({ selection: "本契約は。本契約は。", body: "本契約は。本契約は。" });
    await expect(replaceQuote({ quote: "本契約は", text: "本覚書は" })).rejects.toThrow(
      /選択範囲に 2 箇所/
    );
  });

  it("names the paragraph and length limits so the retry can succeed", async () => {
    installWord({ selection: "", body: "甲。甲。" });
    await expect(replaceQuote({ quote: "甲", text: "乙" })).rejects.toThrow(/255 字まで/);
  });

  it("falls back to a space-insensitive search for a clause label", async () => {
    const word = installWord({ selection: "", body: "第12条　（協議）　甲乙は協議する。" });
    await replaceQuote({ quote: "第12条（協議）", text: "第13条（協議）" });
    expect(word.replacements).toEqual([{ target: "第12条（協議）", text: "第13条（協議）" }]);
  });

  it("prefers an exact match over the space-insensitive one", async () => {
    const word = installWord({ selection: "", body: "第12条（協議）と第12条　（協議）" });
    await replaceQuote({ quote: "第12条（協議）", text: "第13条（協議）" });
    expect(word.replacements).toHaveLength(1);
  });

  it("still reports a quote that is nowhere in the body", async () => {
    installWord({ selection: "", body: "第1条 定義する。" });
    await expect(replaceQuote({ quote: "第9条", text: "第9条" })).rejects.toThrow(/ありません/);
  });

  it("blames the wording rather than the length, which is almost never the reason", async () => {
    installWord({ selection: "", body: "第1条 定義する。" });
    await expect(replaceQuote({ quote: "第9条", text: "第9条" })).rejects.toThrow(/字句どおり/);
  });

  it("offers the nearest paragraphs so the retry can point by number", async () => {
    const body = "第1条（目的）本件は売買である。";
    installWord({ selection: "", body, paragraphs: [body] });
    await readDocumentText(1_000);
    await expect(
      replaceQuote({ quote: "本件は売買契約である", text: "本件は賃貸借である" })
    ).rejects.toThrow(/\[1\] 第1条（目的）/);
  });

  it("says the wording is absent when nothing in the body comes close", async () => {
    const body = "第1条（目的）本件は売買である。";
    installWord({ selection: "", body, paragraphs: [body] });
    await readDocumentText(1_000);
    await expect(replaceQuote({ quote: "反社会的勢力の排除", text: "x" })).rejects.toThrow(
      /無いことを利用者に伝えて/
    );
  });

  it("applies the same check to comments", async () => {
    const word = installWord({ selection: "", body: "解除できる。解除できる。" });
    await expect(insertComment(comment("要検討です。", "解除できる"))).rejects.toThrow(/2 箇所/);
    expect(word.comments).toEqual([]);
  });

  it("asks for a target rather than editing an empty selection", async () => {
    const word = installWord({ selection: "", body: "第1条 定義する。" });
    await expect(insertComment(comment("要検討です。", ""))).rejects.toThrow(
      /対象が指定されていません/
    );
    expect(word.comments).toEqual([]);
  });
});

describe("paragraph targeting", () => {
  const body = [
    "売買契約書",
    "第1条（目的）本件は売買である。",
    "第2条（代金）代金は100万円とする。",
  ];

  it("works from the number alone, which is what a selectionless turn has", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: [...body] });
    await readDocumentText(1_000);
    const note = await insertComment(comment("代金の支払期日が無い。", "", 3));
    expect(word.comments).toHaveLength(1);
    expect(note).toContain("段落 3");
    expect(note).toContain("第2条（代金）");
    expect(note).not.toContain("ページ目");
  });

  it("adds the layout page only when Word reports one", async () => {
    installWord({ selection: "", body: "", paragraphs: [...body], pageIndex: 4 });
    await readDocumentText(1_000);
    const note = await insertComment(comment("代金の支払期日が無い。", "", 3));
    expect(note).toContain("段落 3");
    expect(note).toContain("文書の4ページ目です。");
  });

  it("follows the paragraph the number named after an insert moved it down", async () => {
    const paragraphs = [...body];
    installWord({ selection: "", body: "", paragraphs });
    await readDocumentText(1_000);
    // What insert_blocks does earlier in the same turn: everything below shifts.
    paragraphs.splice(1, 0, "前文", "（前文つづき）");
    const note = await insertComment(comment("代金の支払期日が無い。", "", 3));
    expect(note).toContain("第2条（代金）");
  });

  it("narrows to the quoted part inside the numbered paragraph", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: [...body] });
    await readDocumentText(1_000);
    await replaceQuote({ paragraph: 3, quote: "100万円", text: "150万円" });
    expect(word.replacements).toEqual([{ target: "100万円", text: "150万円" }]);
  });

  it("comments on the whole paragraph when the narrowing quote misses, and says so", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: [...body] });
    await readDocumentText(1_000);
    const note = await insertComment(comment("賃貸借ではない。", "本件は賃貸借である", 2));
    expect(word.comments).toHaveLength(1);
    expect(note).toContain("引用が段落の中に無かった");
  });

  it("refuses to rewrite a paragraph on a quote that is not in it", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: [...body] });
    await readDocumentText(1_000);
    await expect(
      replaceQuote({ paragraph: 2, quote: "本件は賃貸借である", text: "本件は売買である" })
    ).rejects.toThrow(/この段落の文言は/);
    expect(word.replacements).toEqual([]);
  });

  it("refuses a number whose text is gone once the count no longer matches", async () => {
    const paragraphs = [...body];
    const word = installWord({ selection: "", body: "", paragraphs });
    await readDocumentText(1_000);
    // The paragraph was rewritten and another was added, so counting from the top
    // would land on a different clause.
    paragraphs.splice(1, 0, "前文");
    paragraphs[2] = "第1条（目的）本件は贈与である。";
    await expect(
      replaceQuote({ paragraph: 2, quote: "", text: "第1条（目的）本件は交換である。" })
    ).rejects.toThrow(/段落の数が変わった/);
    expect(word.replacements).toEqual([]);
  });

  it("gives the range of real numbers when the number is not one", async () => {
    installWord({ selection: "", body: "", paragraphs: [...body] });
    await readDocumentText(1_000);
    await expect(insertComment(comment("要検討です。", "", 99))).rejects.toThrow(/1〜3 の範囲/);
  });

  it("takes the label the model copied along with the line as the number", async () => {
    installWord({ selection: "", body: "", paragraphs: [...body] });
    await readDocumentText(1_000);
    const note = await insertComment(comment("要検討です。", "[2]"));
    expect(note).toContain("段落 2");
  });

  it("ignores the label prefix when the model leaves it on a quote", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: [...body] });
    await readDocumentText(1_000);
    await replaceQuote({ paragraph: 3, quote: "[3] 100万円", text: "150万円" });
    expect(word.replacements).toEqual([{ target: "100万円", text: "150万円" }]);
  });
});

describe("readDocumentText", () => {
  const paragraphs = ["売買契約書", "第1条（目的）", "第2条（代金）"];

  it("numbers each paragraph, so the model has an address to point with", async () => {
    installWord({ selection: "", body: "", paragraphs });
    const read = await readDocumentText(1_000);
    expect(read.text).toBe("[1] 売買契約書\n[2] 第1条（目的）\n[3] 第2条（代金）");
    expect(read.paragraphs).toBe(3);
    expect(read.truncated).toBe(false);
  });

  it("leaves blank paragraphs out but still counts them, so numbers stay addresses", async () => {
    installWord({ selection: "", body: "", paragraphs: ["売買契約書", "", "  ", "第1条（目的）"] });
    const read = await readDocumentText(1_000);
    expect(read.text).toBe("[1] 売買契約書\n[4] 第1条（目的）");
    expect(read.paragraphs).toBe(2);
  });

  it("stops at a paragraph boundary when the budget runs out", async () => {
    installWord({ selection: "", body: "", paragraphs });
    const read = await readDocumentText(12);
    expect(read.text).toBe("[1] 売買契約書");
    expect(read.paragraphs).toBe(1);
    expect(read.truncated).toBe(true);
  });

  it("reads nothing when there is no budget left", async () => {
    installWord({ selection: "", body: "", paragraphs });
    const read = await readDocumentText(0);
    expect(read).toEqual({ text: "", paragraphs: 0, truncated: false, listMarks: false });
  });
});

describe("readAttachment", () => {
  const paragraphs = ["第1条（目的）", "第2条（代金）"];

  it("sends the body and the selection together, so the model knows where to look", async () => {
    installWord({ selection: "第2条（代金）", body: "", paragraphs });
    const attachment = await readAttachment("document", 1_000, false);
    expect(attachment.document).toContain("第1条（目的）");
    expect(attachment.focus).toBe("第2条（代金）");
    expect(attachment.paragraphs).toBe(2);
  });

  it("leaves the body out when the user asked for the selection only", async () => {
    installWord({ selection: "第2条（代金）", body: "", paragraphs });
    const attachment = await readAttachment("selection", 1_000, false);
    expect(attachment.document).toBe("");
    expect(attachment.focus).toBe("第2条（代金）");
  });

  it("attaches nothing at all when asked for nothing", async () => {
    installWord({ selection: "第2条（代金）", body: "", paragraphs });
    const attachment = await readAttachment("none", 1_000, true);
    expect(attachment.document).toBe("");
    expect(attachment.focus).toBe("");
    expect(attachment.markup).toBe(false);
  });

  it("charges the selection against the same budget, since both are sent", async () => {
    installWord({ selection: "第2条（代金）", body: "", paragraphs });
    const attachment = await readAttachment("document", 8, false);
    expect(attachment.focus).toBe("第2条（代金）");
    expect(attachment.document).toBe("");
    expect(attachment.truncated).toBe(true);
  });
});

describe("reading comments and tracked changes", () => {
  const paragraphs = ["第1条（目的）", "第2条（代金）"];
  const comment: FakeComment = {
    author: "田中太郎",
    date: new Date(2026, 8, 10),
    anchor: "第2条（代金）",
    content: "分割払いにしたい。",
    replies: [{ author: "佐藤花子", date: new Date(2026, 8, 11), content: "検討します。" }],
  };
  const change: FakeChange = {
    type: "Deleted",
    author: "田中太郎",
    date: new Date(2026, 8, 10),
    text: "無催告で",
    where: "第2条（代金）",
  };

  it("reads a comment with who wrote it, what it points at and the replies", async () => {
    installWord({ selection: "", body: "", paragraphs, markupComments: [comment] });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.comments.items).toHaveLength(1);
    expect(attachment.comments.items[0]).toMatchObject({
      author: "田中太郎",
      date: "2026-09-10",
      resolved: false,
      anchor: "[段落 2]",
      content: "分割払いにしたい。",
    });
    expect(attachment.comments.items[0].replies[0].content).toBe("検討します。");
  });

  it("names the paragraph a deletion sits in, which the body may no longer show", async () => {
    installWord({ selection: "", body: "", paragraphs, markupChanges: [change] });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.changes.items[0]).toMatchObject({
      kind: "delete",
      author: "田中太郎",
      text: "無催告で",
    });
    expect(attachment.changes.items[0].where).toBe("[段落 2]");
  });

  it("maps every tracked change type Word reports", async () => {
    const kinds = ["Added", "Deleted", "Formatted", "None"].map((type) => ({
      ...change,
      type,
    }));
    installWord({ selection: "", body: "", paragraphs, markupChanges: kinds });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.changes.items.map((item) => item.kind)).toEqual([
      "insert",
      "delete",
      "format",
      "other",
    ]);
  });

  it("reads nothing when the user did not ask for markup", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs,
      markupComments: [comment],
      markupChanges: [change],
    });
    const attachment = await readAttachment("document", 10_000, false);
    expect(attachment.markup).toBe(false);
    expect(attachment.comments.items).toHaveLength(0);
    expect(attachment.changes.items).toHaveLength(0);
  });

  it("says tracked changes are unreadable on an older Word instead of reporting none", async () => {
    installWord({ selection: "", body: "", paragraphs, wordApi16: false });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.changes.error).toContain("1.6");
    expect(attachment.changes.items).toHaveLength(0);
  });

  it("keeps the comments when the tracked changes call fails, as a tracked move does", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs,
      markupComments: [comment],
      changesFail: "GeneralException",
    });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.comments.items).toHaveLength(1);
    expect(attachment.changes.error).toBe("GeneralException");
  });

  it("keeps a comment when only its anchor and replies fail to load", async () => {
    installWord({
      selection: "第2条（代金）",
      body: "",
      paragraphs,
      markupComments: [comment],
      // Sync 1 reads the selection, sync 2 the comment list, sync 3 the extras.
      failSyncAfter: 3,
    });
    const attachment = await readAttachment("selection", 10_000, true);
    expect(attachment.comments.items).toHaveLength(1);
    expect(attachment.comments.items[0].content).toBe("分割払いにしたい。");
    expect(attachment.comments.items[0].anchor).toBe("");
    expect(attachment.comments.items[0].replies).toHaveLength(0);
  });

  it("stops reading comments once they fill their slice of the budget", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...comment,
      content: `${index} ${"あ".repeat(200)}`,
    }));
    installWord({ selection: "", body: "", paragraphs, markupComments: many });
    const attachment = await readAttachment("document", 2_000, true);
    expect(attachment.comments.truncated).toBe(true);
    expect(attachment.comments.items.length).toBeLessThan(40);
    expect(attachment.comments.items.length).toBeGreaterThan(0);
  });

  it("shortens a long comment rather than dropping it", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs,
      markupComments: [{ ...comment, content: "あ".repeat(900) }],
    });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.comments.items[0].content).toHaveLength(401);
    expect(attachment.comments.items[0].content.endsWith("…")).toBe(true);
  });
});

describe("formatParagraph line grid", () => {
  function installFormatWord(
    ooxml: string,
    extras?: { listItem?: boolean; fontPt?: number }
  ): {
    tracking: string[];
    inserted: string[];
    failInsert: () => void;
  } {
    const tracking: string[] = [];
    const inserted: string[] = [];
    let insertShouldFail = false;
    const paragraph: {
      text: string;
      load: () => void;
      lineSpacing?: number;
      alignment?: string;
      isListItem: boolean;
      font: { size: number; load: () => void };
      getOoxml: () => { value: string };
      getReviewedText: () => { value: string };
      insertOoxml: (xml: string) => void;
      getRange: () => { paragraphs: { load: () => void; items: unknown[] } };
    } = {
      text: "第1条 定義する。\r",
      load: () => undefined,
      isListItem: Boolean(extras?.listItem),
      font: { size: extras?.fontPt ?? 12, load: () => undefined },
      getOoxml: () => ({ value: ooxml }),
      getReviewedText: () => ({ value: "第1条 定義する。" }),
      insertOoxml: (xml: string) => {
        if (insertShouldFail) {
          throw new Error("insertOoxml failed");
        }
        inserted.push(xml);
      },
      getRange: () => ({
        paragraphs: {
          load: () => undefined,
          items: [paragraph],
        },
      }),
    };

    const context = {
      document: {
        set changeTrackingMode(value: string) {
          tracking.push(value);
        },
        body: {
          paragraphs: { load: () => undefined, items: [paragraph] },
        },
        getSelection: () => ({ text: "", load: () => undefined }),
      },
      sync: async () => undefined,
    };

    (globalThis as unknown as { Word: unknown }).Word = {
      run: (callback: (ctx: unknown) => Promise<unknown>) => callback(context),
      ChangeTrackingMode: { trackAll: "TrackAll", off: "Off" },
      ChangeTrackingVersion: { current: "Current", original: "Original" },
      InsertLocation: { replace: "Replace" },
      Alignment: { centered: "Centered", left: "Left", right: "Right", justified: "Justified" },
    };
    (globalThis as unknown as { Office: unknown }).Office = {
      context: {
        host: "Word",
        requirements: { isSetSupported: () => true },
      },
      HostType: { Word: "Word" },
    };
    return {
      tracking,
      inserted,
      failInsert: () => {
        insertShouldFail = true;
      },
    };
  }

  it("rewrites OOXML when line spacing is set, with tracking off for the rewrite", async () => {
    const ooxml = "<w:p><w:r><w:t>第1条 定義する。</w:t></w:r></w:p>";
    const { tracking, inserted } = installFormatWord(ooxml);
    await readDocumentText(1_000);
    const note = await formatParagraph({ quote: "", paragraph: 1, lineSpacing: 16 });
    expect(note).toContain("行グリッドへの合わせは外しました");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain("snapToGrid");
    expect(inserted[0]).toContain("第1条 定義する。");
    expect(tracking).toEqual(["TrackAll", "Off", "TrackAll"]);
  });

  it("does not rewrite OOXML when only alignment is set", async () => {
    const { inserted } = installFormatWord("<w:p><w:r><w:t>第1条 定義する。</w:t></w:r></w:p>");
    await readDocumentText(1_000);
    const note = await formatParagraph({ quote: "", paragraph: 1, alignment: "center" });
    expect(note).not.toContain("行グリッド");
    expect(inserted).toHaveLength(0);
  });

  it("turns Auto paragraph spacing off when spaceAfter is set", async () => {
    const ooxml =
      '<w:p><w:pPr><w:spacing w:afterAutospacing="1" w:beforeAutospacing="1"/></w:pPr><w:r><w:t>第1条 定義する。</w:t></w:r></w:p>';
    const { inserted } = installFormatWord(ooxml);
    await readDocumentText(1_000);
    const note = await formatParagraph({ quote: "", paragraph: 1, spaceAfter: 0 });
    expect(note).toContain("自動間隔を外して指定値にしました");
    expect(note).not.toContain("行グリッド");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain('w:afterAutospacing="0"');
    expect(inserted[0]).toContain('w:after="0"');
  });

  it("keeps going and restores tracking when the OOXML rewrite fails", async () => {
    const { tracking, failInsert } = installFormatWord(
      "<w:p><w:r><w:t>第1条 定義する。</w:t></w:r></w:p>"
    );
    await readDocumentText(1_000);
    failInsert();
    const note = await formatParagraph({ quote: "", paragraph: 1, lineSpacing: 12 });
    expect(note).toContain("行グリッドを外せなかった");
    expect(tracking[tracking.length - 1]).toBe("TrackAll");
  });

  it("writes a hanging indent in twips and character units", async () => {
    const ooxml =
      '<w:p><w:pPr><w:ind w:left="200" w:leftChars="100" w:firstLine="240" w:firstLineChars="200"/></w:pPr><w:r><w:t>第1条 定義する。</w:t></w:r></w:p>';
    const { inserted } = installFormatWord(ooxml, { fontPt: 12 });
    await readDocumentText(1_000);
    const note = await formatParagraph({
      quote: "",
      paragraph: 1,
      leftIndent: 36,
      firstLineIndent: -24,
    });
    expect(note).not.toContain("番号の位置");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain('w:left="720"');
    expect(inserted[0]).toContain('w:leftChars="300"');
    expect(inserted[0]).toContain('w:hanging="480"');
    expect(inserted[0]).toContain('w:hangingChars="200"');
    expect(inserted[0]).not.toContain("firstLine");
  });

  it("says list numbering keeps the number position", async () => {
    const { inserted } = installFormatWord("<w:p><w:r><w:t>第1条 定義する。</w:t></w:r></w:p>", {
      listItem: true,
    });
    await readDocumentText(1_000);
    const note = await formatParagraph({ quote: "", paragraph: 1, firstLineIndent: -24 });
    expect(note).toContain("番号の位置はリストが持っている");
    expect(inserted[0]).toContain('w:hanging="480"');
    expect(inserted[0]).not.toContain("w:left");
  });
});

describe("list marks on the attachment", () => {
  it("shows the live list string beside the address, and remembers only the body", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。", "第1条（目的）"],
      listStrings: ["1.", null],
    });
    const read = await readDocumentText(1_000);
    expect(read.text).toBe("[1] 〔1.〕甲は乙に委託する。\n[2] 第1条（目的）");
    expect(read.listMarks).toBe(true);
  });

  it("says the number exists when Word would not give the string", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
      listStrings: [""],
    });
    const read = await readDocumentText(1_000);
    expect(read.text).toBe("[1] 〔番号あり〕甲は乙に委託する。");
  });

  it("marks the selection the model sees, but leaves the caret check unmarked", async () => {
    installWord({
      selection: "甲は乙に委託する。",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
      listStrings: ["1."],
    });
    expect(await getSelectionText()).toBe("甲は乙に委託する。");
    const info = await getSelectionInfo();
    expect(info.text).toBe("〔1.〕甲は乙に委託する。");
  });

  it("strips a copied wrapper so replace still searches the body", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
      listStrings: ["1."],
    });
    await readDocumentText(1_000);
    await replaceQuote({
      paragraph: 1,
      quote: "[1] 〔1.〕甲は乙に委託する。",
      text: "丙は丁に委託する。",
    });
    expect(word.replacements).toEqual([
      { target: "甲は乙に委託する。", text: "丙は丁に委託する。" },
    ]);
  });

  it("strips a copied live mark when that paragraph's string is known", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
      listStrings: ["1."],
    });
    await readDocumentText(1_000);
    await replaceQuote({ paragraph: 1, quote: "1. 甲は乙に委託する。", text: "丙は丁に委託する。" });
    expect(word.replacements).toEqual([
      { target: "甲は乙に委託する。", text: "丙は丁に委託する。" },
    ]);
  });

  it("does not guess a live mark when the paragraph is unknown", async () => {
    installWord({
      selection: "",
      body: "甲は乙に委託する。",
      paragraphs: ["甲は乙に委託する。"],
      listStrings: ["1."],
    });
    await readDocumentText(1_000);
    await expect(
      replaceQuote({ quote: "1. 甲は乙に委託する。", text: "丙は丁に委託する。" })
    ).rejects.toThrow(/ありません/);
  });

  it("drops a list prefix the model wrote into the replacement", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
      listStrings: ["1."],
    });
    await readDocumentText(1_000);
    await replaceQuote({
      paragraph: 1,
      quote: "甲は乙に委託する。",
      text: "1. 丙は丁に委託する。",
    });
    expect(word.replacements).toEqual([
      { target: "甲は乙に委託する。", text: "丙は丁に委託する。" },
    ]);
  });

  it("keeps the list mark on a near-miss candidate", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に対し本件業務を委託する。"],
      listStrings: ["1."],
    });
    await readDocumentText(1_000);
    await expect(
      replaceQuote({ quote: "甲は乙に対し本件業務を委任する", text: "x" })
    ).rejects.toThrow(/\[1\] 〔1.〕甲は乙に対し本件業務を委託する。/);
  });

  it("flags the attachment when a selected list item is the only text sent", async () => {
    installWord({
      selection: "甲は乙に委託する。",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
      listStrings: ["1."],
    });
    const attachment = await readAttachment("selection", 1_000, false);
    expect(attachment.listMarks).toBe(true);
    expect(attachment.focus).toContain("〔1.〕");
  });
});

describe("list character meter", () => {
  it("adds a list-mark allowance on top of the paragraph labels", async () => {
    const paragraphs = ["甲は委託する。", "乙は受託する。"];
    installWord({
      selection: "",
      body: `${paragraphs.join("\r")}\r`,
      paragraphs,
      listStrings: ["1.", "2."],
    });
    const stats = await getDocumentStats();
    expect(stats.attachChars).toBe(stats.chars + 2 * 6 + 2 * 8);
  });
});

describe("formatList", () => {
  it("starts an arabic list and reports the mark that landed", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
    });
    await readDocumentText(1_000);
    const note = await formatList({ action: "apply", paragraph: 1, style: "arabic", quote: "" });
    expect(word.paragraphs[0].isListItem).toBe(true);
    expect(note).toContain("〔1.〕");
  });

  it("refuses to restyle a list that already has a number", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
      listStrings: ["ア"],
    });
    await readDocumentText(1_000);
    await expect(
      formatList({ action: "apply", paragraph: 1, style: "arabic", quote: "" })
    ).rejects.toThrow(/既に項番号/);
  });

  it("continues the previous list and leaves an already-attached item alone", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。", "乙は受託する。"],
      listStrings: ["1.", "2."],
    });
    await readDocumentText(1_000);
    const note = await formatList({ action: "apply", paragraph: 2, quote: "" });
    expect(word.paragraphs[1].isListItem).toBe(true);
    expect(note).toContain("〔2.〕");
  });

  it("attaches a plain paragraph to the list above it", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。", "乙は受託する。"],
      listStrings: ["1.", null],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 2, quote: "" });
    expect(word.paragraphs[1].isListItem).toBe(true);
  });

  it("continues the previous list across 号 paragraphs that are not list items", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: [
        "甲及び乙は、各自、自己が次の各号のいずれにも該当しないことを表明する。",
        "① 暴力団",
        "② 暴力主義的な行動",
        "甲又は乙が前項各号のいずれかに該当するに至ったとき解除できる。",
      ],
      listStrings: ["1.", null, null, null],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 4, style: "continue", quote: "" });
    expect(word.paragraphs[3].isListItem).toBe(true);
    expect(word.paragraphs[1].isListItem).toBe(false);
    expect(word.paragraphs[2].isListItem).toBe(false);
  });

  it("turns a bullet into a numbered list instead of refusing", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["暴力団、暴力団準構成員その他暴力主義的な団体"],
      listStrings: ["\uF0B7"],
    });
    await readDocumentText(1_000);
    const note = await formatList({ action: "apply", paragraph: 1, style: "paren", quote: "" });
    expect(word.paragraphs[0].isListItem).toBe(true);
    expect(word.paragraphs[0].listString).toBe("(1)");
    expect(note).toContain("〔(1)〕");
  });

  it("refuses to restart a bullet", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs: ["暴力団、暴力団準構成員その他暴力主義的な団体"],
      listStrings: ["•"],
    });
    await readDocumentText(1_000);
    await expect(formatList({ action: "restart", paragraph: 1, quote: "" })).rejects.toThrow(
      /箇条書き/
    );
  });

  it("refuses to continue a paragraph that belongs to another list", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。", "乙は受託する。"],
      listStrings: ["1.", "1."],
    });
    await readDocumentText(1_000);
    word.paragraphs[1].detachFromList();
    word.paragraphs[1].startNewList();
    await expect(formatList({ action: "apply", paragraph: 2, quote: "" })).rejects.toThrow(
      /別のリスト/
    );
  });

  it("removes numbering", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。"],
      listStrings: ["1."],
    });
    await readDocumentText(1_000);
    const note = await formatList({ action: "remove", paragraph: 1, quote: "" });
    expect(word.paragraphs[0].isListItem).toBe(false);
    expect(note).toContain("（なし）");
  });

  it("skips blank paragraphs in a through span", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。", "", "乙は受託する。"],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 1, through: 3, style: "arabic", quote: "" });
    expect(word.paragraphs[0].isListItem).toBe(true);
    expect(word.paragraphs[1].isListItem).toBe(false);
    expect(word.paragraphs[2].isListItem).toBe(true);
  });

  it("refuses a through span that walks a non-empty paragraph the attachment dropped", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。", "乙は受託する。", "丙は保証する。"],
    });
    await readDocumentText(20);
    await expect(
      formatList({ action: "apply", paragraph: 1, through: 3, style: "arabic", quote: "" })
    ).rejects.toThrow(/添付に無い/);
  });

  it("restarts from one with separateList when Desktop 1.4 is there", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。", "乙は受託する。"],
      listStrings: ["1.", "2."],
    });
    await readDocumentText(1_000);
    const note = await formatList({ action: "restart", paragraph: 2, quote: "" });
    expect(word.paragraphs[1].listString).toBe("1.");
    expect(note).not.toContain("アラビア数字");
  });

  it("starts a dai list via the desktop list-level path", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
    });
    await readDocumentText(1_000);
    const note = await formatList({ action: "apply", paragraph: 1, style: "dai", quote: "" });
    expect(word.paragraphs[0].isListItem).toBe(true);
    expect(word.paragraphs[0].listString).toBe("第１");
    expect(note).toContain("〔第１〕");
  });

  it("starts a daiJo list", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["本契約において使用する用語の意義は、次のとおりとする。"],
    });
    await readDocumentText(1_000);
    const note = await formatList({ action: "apply", paragraph: 1, style: "daiJo", quote: "" });
    expect(word.paragraphs[0].isListItem).toBe(true);
    expect(word.paragraphs[0].listString).toBe("第１条");
    expect(note).toContain("〔第１条〕");
  });

  it("starts a parenFull list", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 1, style: "parenFull", quote: "" });
    expect(word.paragraphs[0].listString).toBe("（１）");
  });

  it("joins the numbering above, so a 号 keeps counting past its 目", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: [
        "内金は、本契約締結時に支払う。",
        "振込手数料は甲の負担とする。",
        "残金は、引渡しと引換えに支払う。",
      ],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 1, style: "parenFull", start: true, quote: "" });
    await formatList({ action: "apply", paragraph: 2, style: "circled", level: 1, quote: "" });
    const note = await formatList({ action: "apply", paragraph: 3, style: "parenFull", quote: "" });
    const [gou1, moku, gou2] = word.paragraphs;
    expect(moku.listOrNullObject.id).toBe(gou1.listOrNullObject.id);
    expect(gou2.listOrNullObject.id).toBe(gou1.listOrNullObject.id);
    expect(moku.listItemOrNullObject.level).toBe(1);
    expect(gou2.listItemOrNullObject.level).toBe(0);
    expect(note).toContain("直前の 〔①〕 に続けました");
  });

  it("joins the numbering above when the paragraph is pointed at by quote, not number", async () => {
    // The paragraph a quote finds is a proxy of the range's own; it is not the
    // object in body.paragraphs.items, so indexOf saw -1 and no paragraph above.
    const paragraphs = ["本件目的物の売買代金は、金＿円とする。", "品名　業務用ミシン", "数量　１台"];
    const word = installWord({ selection: "", body: paragraphs.join(""), paragraphs });
    await readDocumentText(1_000);
    await formatList({ action: "apply", quote: "本件目的物の売買代金は", style: "arabicFull", start: true });
    await formatList({ action: "apply", quote: "品名　業務用ミシン", style: "parenFull", level: 1 });
    const note = await formatList({ action: "apply", quote: "数量　１台", style: "parenFull", level: 1 });
    const [kou, gou1, gou2] = word.paragraphs;
    expect(gou1.listOrNullObject.id).toBe(kou.listOrNullObject.id);
    expect(gou2.listOrNullObject.id).toBe(kou.listOrNullObject.id);
    expect(gou2.listItemOrNullObject.level).toBe(1);
    expect(note).toContain("直前の 〔（１）〕 に続けました");
  });

  it("runs a through span from a quoted paragraph when no number was given", async () => {
    const paragraphs = ["売買代金は次のとおり。", "品名　○○", "数量　○○"];
    const word = installWord({ selection: "", body: paragraphs.join(""), paragraphs });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 1, quote: "", style: "arabicFull", start: true });
    const note = await formatList({
      action: "apply",
      quote: "品名　○○",
      through: 3,
      style: "parenFull",
      level: 1,
    });
    const [kou, gou1, gou2] = word.paragraphs;
    expect(gou1.listOrNullObject.id).toBe(kou.listOrNullObject.id);
    expect(gou2.listOrNullObject.id).toBe(kou.listOrNullObject.id);
    expect(note).toContain("2 段落");
  });

  it("continues by quote too, so the second 項 reads ２ rather than １", async () => {
    const paragraphs = ["甲は乙に売り渡す。", "前項の目的物は別紙のとおり。"];
    const word = installWord({ selection: "", body: paragraphs.join(""), paragraphs });
    await readDocumentText(1_000);
    await formatList({ action: "apply", quote: "甲は乙に売り渡す", style: "arabicFull", start: true });
    const note = await formatList({ action: "apply", quote: "前項の目的物は別紙のとおり", style: "continue" });
    expect(word.paragraphs[1].listOrNullObject.id).toBe(word.paragraphs[0].listOrNullObject.id);
    expect(note).toContain("直前の 〔１　〕 に続けました");
  });

  it("leaves a level alone once it is in use, so its count is not restarted", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: [
        "第1項とする。",
        "第2項とする。",
        "第1号とする。",
        "第2号とする。",
      ],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 1, style: "arabicFull", start: true, quote: "" });
    await formatList({ action: "apply", paragraph: 2, style: "arabicFull", quote: "" });
    await formatList({ action: "apply", paragraph: 3, style: "parenFull", level: 1, quote: "" });
    await formatList({ action: "apply", paragraph: 4, style: "parenFull", level: 1, quote: "" });
    expect(word.levelWrites).toEqual([
      { level: 0, format: "%1\u3000" },
      { level: 1, format: "（%2）" },
    ]);
  });

  it("refuses continue onto a level that has no numbering yet, instead of handing back a bullet", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs: ["労務費　金〇〇円", "本件代金は、次の各号の区分に従い支払う。"],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 1, style: "circled", level: 2, start: true, quote: "" });
    await expect(
      formatList({ action: "apply", paragraph: 2, style: "continue", level: 0, quote: "" })
    ).rejects.toThrow(/style を付けた apply/);
  });

  it("starts a list of its own where a 条 begins the count again", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["第2条の第1項とする。", "第3条の第1項とする。"],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 1, style: "arabicFull", start: true, quote: "" });
    await formatList({ action: "apply", paragraph: 2, style: "arabicFull", start: true, quote: "" });
    expect(word.paragraphs[1].listOrNullObject.id).not.toBe(
      word.paragraphs[0].listOrNullObject.id
    );
  });

  it("points at start when restart is asked of a paragraph with no number", async () => {
    installWord({ selection: "", body: "", paragraphs: ["甲は乙に委託する。"] });
    await readDocumentText(1_000);
    await expect(
      formatList({ action: "restart", paragraph: 1, quote: "" })
    ).rejects.toThrow(/start/);
  });

  it("keeps the number in a parenFull list nested under 号", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
    });
    await readDocumentText(1_000);
    await formatList({ action: "apply", paragraph: 1, style: "parenFull", level: 2, quote: "" });
    expect(word.paragraphs[0].listString).toBe("（１）");
  });

  it("refuses builtin styles when WordApiDesktop 1.3 is missing", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は乙に委託する。"],
      wordApiDesktop13: false,
    });
    await readDocumentText(1_000);
    await expect(
      formatList({ action: "apply", paragraph: 1, style: "dai", quote: "" })
    ).rejects.toThrow(/Word デスクトップ/);
  });

  it("rebuilds the tail when separateList is missing", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。", "乙は受託する。"],
      listStrings: ["1.", "2."],
      wordApiDesktop14: false,
    });
    await readDocumentText(1_000);
    const note = await formatList({ action: "restart", paragraph: 2, quote: "" });
    expect(word.paragraphs[1].isListItem).toBe(true);
    expect(note).toContain("アラビア数字");
  });
});

describe("numbers handed out by an insert", () => {
  const specs = (...texts: string[]) => mapBlocks(texts.map((text) => ({ type: "item" as const, text })));

  it("numbers the new paragraphs of an empty document by position, and a span can use them", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: [""] });
    await readDocumentText(1_000);
    const landing = await insertDraftParagraphs(
      specs("売買代金は次のとおり。", "品名　○○", "数量　○○", "合計金額　○○円"),
      "cursor"
    );
    // The empty first paragraph keeps number 1, as it would in the attachment.
    expect(landing.numbers).toEqual([
      { number: 2, text: "売買代金は次のとおり。" },
      { number: 3, text: "品名　○○" },
      { number: 4, text: "数量　○○" },
      { number: 5, text: "合計金額　○○円" },
    ]);

    await formatList({ action: "apply", paragraph: 2, quote: "", style: "arabicFull", start: true });
    const note = await formatList({
      action: "apply",
      paragraph: 3,
      through: 5,
      quote: "",
      style: "parenFull",
      level: 1,
    });
    const [, kou, gou1, gou2, gou3] = word.paragraphs;
    expect([gou1, gou2, gou3].map((p) => p.listOrNullObject.id)).toEqual(
      [kou, kou, kou].map((p) => p.listOrNullObject.id)
    );
    expect([gou1, gou2, gou3].map((p) => p.listItemOrNullObject.level)).toEqual([1, 1, 1]);
    expect(note).toContain("3 段落");
  });

  it("continues past the attached numbers when the insert lands above attached paragraphs", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["第1条とする。", "第2条とする。", "第3条とする。"],
    });
    await readDocumentText(1_000);
    const landing = await insertDraftParagraphs(specs("第1条の2とする。"), "cursor", "", 1);
    // Position 2 is already the attached 第2条's number, so the new one gets 4.
    expect(landing.numbers).toEqual([{ number: 4, text: "第1条の2とする。" }]);
    expect(word.paragraphs[1].text.replaceAll("\r", "")).toBe("第1条の2とする。");

    await formatList({ action: "apply", paragraph: 4, quote: "", style: "arabic" });
    expect(word.paragraphs[1].isListItem).toBe(true);
    // The old numbers still reach the paragraphs they were handed out for.
    await formatList({ action: "apply", paragraph: 2, quote: "", style: "arabic" });
    expect(word.paragraphs[2].isListItem).toBe(true);
    expect(word.paragraphs[2].text.replaceAll("\r", "")).toBe("第2条とする。");
  });

  it("keeps the insert when numbering fails, and hands out nothing", async () => {
    installWord({ selection: "", body: "", paragraphs: [""] });
    await readDocumentText(1_000);
    const landing = await insertDraftParagraphs(specs(""), "cursor");
    expect(landing.numbers).toBeUndefined();
  });
});

describe("insert after a list", () => {
  it("drops numbering from a body paragraph that Word would have continued", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。"],
      listStrings: ["1."],
    });
    await readDocumentText(1_000);
    await insertDraftParagraphs(mapBlocks([{ type: "body", text: "前文を入れる。" }]), "cursor", "", 1);
    expect(word.paragraphs[1].isListItem).toBe(false);
    expect(word.paragraphs[1].text.replaceAll("\r", "")).toBe("前文を入れる。");
  });

  it("lets an item keep the numbering Word continued", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["甲は委託する。"],
      listStrings: ["1."],
    });
    await readDocumentText(1_000);
    await insertDraftParagraphs(mapBlocks([{ type: "item", text: "乙は受託する。" }]), "cursor", "", 1);
    expect(word.paragraphs[1].isListItem).toBe(true);
  });

  it("drops numbering from a citation inserted after a list item", async () => {
    const word = installWord({
      selection: "甲は委託する。",
      body: "",
      paragraphs: ["甲は委託する。"],
      listStrings: ["1."],
    });
    await insertCitationText({ title: "民法", url: "http://example.test", content: "第415条" });
    expect(word.paragraphs[word.paragraphs.length - 1].isListItem).toBe(false);
  });
});

describe("setOutlineLevel", () => {
  it("sets the outline level and leaves the style and font", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["請求の趣旨", "甲は委託する。"],
    });
    word.paragraphs[0].font.bold = true;
    word.paragraphs[0].font.name = "游明朝";
    await readDocumentText(1_000);
    const note = await setOutlineLevel({ action: "set", paragraph: 1, level: 1, quote: "" });
    expect(note).toContain("「請求の趣旨」をレベル 1 の見出しにしました");
    expect(note).toContain("変更履歴に書式変更として記録");
    expect(word.paragraphs[0].outlineLevel).toBe(1);
    expect(word.paragraphs[0].style).toBe("標準");
    expect(word.paragraphs[0].styleBuiltIn).toBe("Normal");
    expect(word.paragraphs[0].font.bold).toBe(true);
    expect(word.paragraphs[0].font.name).toBe("游明朝");
    expect(word.paragraphs[1].outlineLevel).toBe(10);
    expect(word.getTracking()).toBe("trackAll");
    expect(word.paragraphs[0].outlineWrites).toBe(1);

    const again = await setOutlineLevel({ action: "set", paragraph: 1, level: 1, quote: "" });
    expect(again).toContain("すでにレベル 1");
    expect(word.paragraphs[0].outlineWrites).toBe(1);
  });

  it("clears a heading back to body text", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: ["請求の趣旨"] });
    await readDocumentText(1_000);
    await setOutlineLevel({ action: "set", paragraph: 1, level: 2, quote: "" });
    const note = await setOutlineLevel({ action: "clear", paragraph: 1, quote: "" });
    expect(note).toContain("ナビゲーションの見出しから外しました");
    expect(word.paragraphs[0].outlineLevel).toBe(10);
    expect(word.paragraphs[0].style).toBe("標準");
  });

  it("skips a built-in heading style and still sets the others in the span", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["請求の趣旨", "", "第1章"],
    });
    word.paragraphs[2].style = "見出し 1";
    word.paragraphs[2].styleBuiltIn = "Heading1";
    word.paragraphs[2].outlineLevel = 1;
    const writesBefore = word.paragraphs[2].outlineWrites;
    await readDocumentText(1_000);
    const note = await setOutlineLevel({
      action: "set",
      paragraph: 1,
      through: 3,
      level: 1,
      quote: "",
    });
    expect(word.paragraphs[0].outlineLevel).toBe(1);
    expect(word.paragraphs[1].outlineLevel).toBe(10);
    expect(word.paragraphs[2].outlineLevel).toBe(1);
    expect(word.paragraphs[2].style).toBe("見出し 1");
    expect(word.paragraphs[2].outlineWrites).toBe(writesBefore);
    expect(note).toContain("レベル 1 の見出しにしました");
    expect(note).toContain("組み込みの見出しスタイルがレベルを固定しているので変えていません");
  });

  it("reports a style rename instead of calling the edit a success", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: ["請求の趣旨"] });
    await readDocumentText(1_000);
    word.paragraphs[0].restyleOnOutline = true;
    await expect(setOutlineLevel({ action: "set", paragraph: 1, level: 1, quote: "" })).rejects.toThrow(
      /スタイル名が「標準」から「見出し 1」に変わりました/
    );
  });

  it("says the paragraph is not a navigation heading when the level does not stick", async () => {
    const word = installWord({ selection: "", body: "", paragraphs: ["請求の趣旨"] });
    await readDocumentText(1_000);
    word.paragraphs[0].ignoreOutline = true;
    await expect(setOutlineLevel({ action: "set", paragraph: 1, level: 1, quote: "" })).rejects.toThrow(
      /ナビゲーションに出ていません/
    );
  });
});

describe("insertBlankBefore", () => {
  function texts(word: { paragraphs: { text: string }[] }): string[] {
    return word.paragraphs.map((paragraph) => paragraph.text.replace(/\r/g, ""));
  }

  it("puts one blank line before each article and leaves the list intact", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["第1条（目的）", "第2条（代金）"],
      listStrings: ["第１条", "第２条"],
    });
    await readDocumentText(1_000);
    const first = word.paragraphs[0];
    const second = word.paragraphs[1];
    const listId = first.listOrNullObject.id;
    first.styleBuiltIn = "Heading1";
    first.style = "見出し 1";
    first.firstLineIndent = 12;
    first.leftIndent = 36;
    first.spaceBefore = 18;
    first.spaceAfter = 6;
    first.lineUnitBefore = 1;
    const note = await insertBlankBefore([1, 2, 2]);
    expect(texts(word)).toEqual(["", "第1条（目的）", "", "第2条（代金）"]);
    expect(word.paragraphs[0].isListItem).toBe(false);
    expect(word.paragraphs[0].styleBuiltIn).toBe("Normal");
    expect(word.paragraphs[0].firstLineIndent).toBe(0);
    expect(word.paragraphs[0].leftIndent).toBe(0);
    expect(word.paragraphs[0].spaceBefore).toBe(0);
    expect(word.paragraphs[0].spaceAfter).toBe(0);
    expect(word.paragraphs[0].lineUnitBefore).toBe(0);
    expect(word.paragraphs[2].isListItem).toBe(false);
    expect(first.isListItem).toBe(true);
    expect(first.listOrNullObject.id).toBe(listId);
    expect(first.styleBuiltIn).toBe("Heading1");
    expect(first.firstLineIndent).toBe(12);
    expect(first.leftIndent).toBe(36);
    expect(first.spaceBefore).toBe(18);
    expect(first.lineUnitBefore).toBe(1);
    expect(second.listOrNullObject.id).toBe(listId);
    expect(second.listString).toBe("第２条");
    expect(note).toContain("2 箇所の直前に空行を入れました");
    expect(note).toContain("第1条（目的）");
    expect(note).toContain("第2条（代金）");
    expect(word.getTracking()).toBe("trackAll");
  });

  it("skips a paragraph that already has a blank line above it", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["前文", "", "第1条（目的）"],
    });
    await readDocumentText(1_000);
    const note = await insertBlankBefore([3]);
    expect(texts(word)).toEqual(["前文", "", "第1条（目的）"]);
    expect(note).toContain("空行は入れていません");
    expect(note).toContain("足していません");
  });

  it("refuses a number that was not handed out and inserts nothing", async () => {
    const word = installWord({
      selection: "",
      body: "",
      paragraphs: ["前文", "", "第1条（目的）"],
    });
    await readDocumentText(1_000);
    await expect(insertBlankBefore([2, 3])).rejects.toThrow(/添付にありません/);
    expect(texts(word)).toEqual(["前文", "", "第1条（目的）"]);
  });
});

