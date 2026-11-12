import { describe, expect, it } from "vitest";
import { AttachmentScope } from "../../shared/attachment";
import { MeterSelection, MeterSource } from "../word";
import { assembleMeterAttachment, createMeterSession } from "./meterSession";

function source(document: string, budget = 1_000): MeterSource {
  return {
    scope: "document",
    markup: false,
    budget,
    selection: { text: "", listMarks: false, paragraphs: 0, reviewedFallback: false },
    comments: { items: [], truncated: false, error: "" },
    changes: { items: [], truncated: false, error: "" },
    document,
    paragraphs: document.split("\n").length,
    truncated: false,
    listMarks: false,
    reviewedFallback: false,
    inlineMarkup: false,
  };
}

function selection(text: string): MeterSelection {
  return { text, listMarks: false, paragraphs: 1, reviewedFallback: false };
}

describe("assembleMeterAttachment", () => {
  it("gives the selection the budget first and keeps the rest of the cached body", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `[${index + 1}] 本文${index}`);
    const cached = source(lines.join("\n"), 200);
    const open = assembleMeterAttachment(cached, selection(""), 200);
    expect(open.document).toBe(cached.document);
    const focused = assembleMeterAttachment(cached, selection("選".repeat(80)), 200);
    expect(focused.focus).toHaveLength(80);
    expect(focused.document.length).toBeLessThan(open.document.length);
    expect(focused.document).toContain("[1]");
    expect(focused.truncated).toBe(true);
  });
});

describe("createMeterSession", () => {
  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("does not read the body again when the selection changes", async () => {
    let sources = 0;
    let selections = 0;
    const session = createMeterSession({
      readSource: async () => {
        sources += 1;
        return source("[1] 甲は乙に委託する。");
      },
      readSelection: async () => {
        selections += 1;
        return selection("乙");
      },
    });
    const first = await session.requestBody("document", 1_000, false);
    expect(first.document).toContain("甲は乙");
    expect(sources).toBe(1);
    const next = await session.selectionChanged();
    expect(sources).toBe(1);
    expect(selections).toBe(1);
    expect(next?.focus).toBe("乙");
    expect(next?.document).toContain("甲は乙");
  });

  it("runs one body read at a time and keeps only the latest request", async () => {
    const pending: Array<{ budget: number; resolve: (source: MeterSource) => void }> = [];
    let active = 0;
    let maxActive = 0;
    const session = createMeterSession({
      readSource: (scope: AttachmentScope, budget: number) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred<MeterSource>();
        pending.push({
          budget,
          resolve: (value) => {
            active -= 1;
            gate.resolve(value);
          },
        });
        return gate.promise;
      },
      readSelection: async () => selection(""),
    });
    const first = session.requestBody("document", 1, false);
    const second = session.requestBody("document", 2, false);
    const third = session.requestBody("document", 3, false);
    expect(pending).toHaveLength(1);
    expect(pending[0].budget).toBe(1);
    pending[0].resolve(source("[1] 最初"));
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    expect(pending[1].budget).toBe(3);
    pending[1].resolve(source("[1] 最新"));
    const results = await Promise.all([first, second, third]);
    expect(maxActive).toBe(1);
    expect(results.map((attachment) => attachment.document)).toEqual([
      "[1] 最新",
      "[1] 最新",
      "[1] 最新",
    ]);
  });

  it("reads the body again when the document budget changes", async () => {
    const budgets: number[] = [];
    const session = createMeterSession({
      readSource: async (_scope, budget) => {
        budgets.push(budget);
        return source(`[1] 予算${budget}`, budget);
      },
      readSelection: async () => selection(""),
    });
    await session.requestBody("document", 100, false);
    await session.requestBody("document", 200, false);
    expect(budgets).toEqual([100, 200]);
  });
});
