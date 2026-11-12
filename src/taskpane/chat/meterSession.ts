import {
  Attachment,
  AttachmentScope,
  ChangeNote,
  CommentNote,
  EMPTY_ATTACHMENT,
  MarkupList,
  ShapeRead,
  changeChars,
  commentChars,
  emptyMarkup,
  markupCharBudget,
} from "../../shared/attachment";
import { SHAPES_MARKER } from "../../shared/prompts";
import { renderedShapeBody } from "../../shared/extract/shapeText";
import type { MeterSelection, MeterSource } from "../word";

function usedChars<T>(list: MarkupList<T>, cost: (item: T) => number): number {
  return list.items.reduce((total, item) => total + cost(item), 0);
}

/** A prefix of a list already read at a larger budget. */
function takeItems<T>(
  list: MarkupList<T>,
  budget: number,
  cost: (item: T) => number
): MarkupList<T> {
  if (list.error) {
    return { items: [...list.items], truncated: list.truncated, error: list.error };
  }
  if (budget <= 0) {
    return { items: [], truncated: list.items.length > 0 || list.truncated, error: "" };
  }
  const items: T[] = [];
  let used = 0;
  for (const item of list.items) {
    const weight = cost(item);
    if (used + weight > budget && items.length) {
      return { items, truncated: true, error: "" };
    }
    items.push(item);
    used += weight;
  }
  return { items, truncated: list.truncated || used > budget, error: "" };
}

function trimLines(text: string, budget: number): { text: string; truncated: boolean } {
  if (!text) {
    return { text: "", truncated: false };
  }
  if (budget <= 0) {
    return { text: "", truncated: true };
  }
  if (text.length <= budget) {
    return { text, truncated: false };
  }
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = (kept.length ? 1 : 0) + line.length;
    if (kept.length && used + cost > budget) {
      break;
    }
    if (!kept.length && line.length > budget) {
      return { text: "", truncated: true };
    }
    kept.push(line);
    used += cost;
  }
  return { text: kept.join("\n"), truncated: kept.length < lines.length };
}

function numberedLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split("\n").filter((line) => /^\s*\[\d+\]/.test(line)).length;
}

function fitCachedBody(
  source: MeterSource,
  maxChars: number
): { document: string; paragraphs: number; truncated: boolean; shapes?: ShapeRead } {
  const shapes = source.shapes;
  if (maxChars <= 0) {
    return {
      document: "",
      paragraphs: 0,
      truncated: Boolean(source.document) || source.truncated,
      shapes: shapes
        ? { ...shapes, text: "", truncated: Boolean(shapes.text) || shapes.truncated, count: 0 }
        : undefined,
    };
  }
  const shapeBody = shapes ? renderedShapeBody(shapes) : "";
  const header = shapeBody ? `\n\n${SHAPES_MARKER}\n`.length : 0;
  let nextShapes = shapes;
  let shapeCost = shapeBody.length;
  if (header + shapeCost > maxChars && shapes) {
    const room = Math.max(0, maxChars - header);
    nextShapes = { ...shapes, text: shapes.text.slice(0, room), truncated: true };
    shapeCost = renderedShapeBody(nextShapes).length;
  }
  const bodyBudget = Math.max(0, maxChars - header - shapeCost);
  const trimmed = trimLines(source.document, bodyBudget);
  return {
    document: trimmed.text,
    paragraphs: numberedLines(trimmed.text),
    truncated: source.truncated || trimmed.truncated,
    shapes: nextShapes,
  };
}

/**
 * Selection first, then markup, then whatever body still fits. The body and the
 * markup lists come from a cache read at the full budget.
 */
export function assembleMeterAttachment(
  source: MeterSource,
  selection: MeterSelection,
  budget: number
): Attachment {
  if (source.scope === "none") {
    return { ...EMPTY_ATTACHMENT, scope: "none" };
  }
  const room = Math.max(0, budget);
  const focus = selection.text.slice(0, room);
  const focusCut = focus.length < selection.text.length;
  const forMarkup = source.markup ? markupCharBudget(Math.max(0, room - focus.length)) : 0;
  const comments = source.markup
    ? takeItems(source.comments, Math.floor(forMarkup / 2), commentChars)
    : emptyMarkup<CommentNote>();
  const commentsUsed = source.markup ? usedChars(comments, commentChars) : 0;
  const changes = source.markup
    ? takeItems(source.changes, forMarkup - commentsUsed, changeChars)
    : emptyMarkup<ChangeNote>();
  if (source.scope === "selection") {
    return {
      scope: "selection",
      document: "",
      paragraphs: 0,
      truncated: focusCut,
      focus,
      markup: source.markup,
      comments,
      changes,
      listMarks: selection.listMarks,
      reviewedFallback: selection.reviewedFallback,
      inlineMarkup: false,
    };
  }
  const markupUsed = commentsUsed + usedChars(changes, changeChars);
  const remaining = room - focus.length - markupUsed;
  const body = fitCachedBody(source, remaining);
  return {
    scope: source.scope,
    document: body.document,
    paragraphs: body.paragraphs || (body.document ? source.paragraphs : 0),
    truncated: body.truncated || focusCut || remaining <= 0,
    focus,
    markup: source.markup,
    comments,
    changes,
    listMarks: source.listMarks || selection.listMarks,
    reviewedFallback: source.reviewedFallback,
    inlineMarkup: source.inlineMarkup,
    inlineCommentCount: source.inlineMarkup ? source.inlineCommentCount : undefined,
    shapes: body.shapes,
  };
}

/**
 * Selection-scoped markup is read from the selection, so a new selection needs
 * a fresh body read. Without paragraph events, a selection change is the only
 * cheap sign that the document text moved.
 */
export function selectionNeedsBodyRead(
  scope: AttachmentScope,
  markup: boolean,
  paragraphEvents: boolean
): boolean {
  return (scope === "selection" && markup) || !paragraphEvents;
}

/** Quiet time after the last paragraph edit before the meter reads the body again. */
export const DOCUMENT_EDIT_QUIET_MS = 1_500;

/**
 * One read, 1.5s after the last edit. Every edit extends that wait, so typing
 * faster than the quiet time does not read at all. A read already running for
 * this same pause is not started again; a read that began earlier is followed
 * by one fresh read when it finishes.
 */
export function createDocumentEditRefresh(
  read: () => Promise<unknown> | unknown,
  quietMs = DOCUMENT_EDIT_QUIET_MS
): { onEdit: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight = false;
  let again = false;

  const start = () => {
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    again = false;
    Promise.resolve(read()).finally(() => {
      inflight = false;
      if (again) {
        again = false;
        start();
      }
    });
  };

  return {
    onEdit() {
      again = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(start, quietMs);
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = undefined;
      again = false;
    },
  };
}

type BodyRequest = { scope: AttachmentScope; budget: number; markup: boolean };

/**
 * One meter read at a time. A newer request replaces one that has not started,
 * and a selection change re-reads only the selection.
 */
export function createMeterSession(io: {
  readSource: (scope: AttachmentScope, budget: number, markup: boolean) => Promise<MeterSource>;
  readSelection: () => Promise<MeterSelection>;
}) {
  let source: MeterSource | null = null;
  let selection: MeterSelection | null = null;
  let running = false;
  let body: BodyRequest | null = null;
  let selectionDirty = false;
  const queued: Array<() => void> = [];

  async function drain(): Promise<void> {
    if (running) {
      await new Promise<void>((resolve) => queued.push(resolve));
      return;
    }
    running = true;
    try {
      for (;;) {
        if (body) {
          const request = body;
          body = null;
          source = await io.readSource(request.scope, request.budget, request.markup);
          selection = source.selection;
          continue;
        }
        if (selectionDirty && source) {
          selectionDirty = false;
          selection = await io.readSelection();
          continue;
        }
        selectionDirty = false;
        break;
      }
    } finally {
      running = false;
      const waiters = queued.splice(0);
      for (const wake of waiters) {
        wake();
      }
    }
  }

  async function settled(): Promise<void> {
    do {
      await drain();
    } while (running || body || (selectionDirty && source));
  }

  return {
    async requestBody(
      scope: AttachmentScope,
      budget: number,
      markup: boolean
    ): Promise<Attachment> {
      body = { scope, budget, markup };
      await settled();
      if (!source) {
        return { ...EMPTY_ATTACHMENT, scope };
      }
      return assembleMeterAttachment(source, selection ?? source.selection, source.budget);
    },
    async selectionChanged(): Promise<Attachment | null> {
      if (!source && !body && !running) {
        return null;
      }
      selectionDirty = true;
      await settled();
      if (!source) {
        return null;
      }
      return assembleMeterAttachment(source, selection ?? source.selection, source.budget);
    },
  };
}
