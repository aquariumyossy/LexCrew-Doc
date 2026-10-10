import { scanXml, xmlAttr } from "./xml";

/**
 * Word stores each text box twice, once in `mc:Choice` and again in
 * `mc:Fallback`. The fallback copy is not a second shape.
 */
export class ShapeStory {
  private fallback = 0;
  private shape = 0;

  open(name: string): void {
    if (name === "mc:Fallback") {
      this.fallback += 1;
      return;
    }
    if (this.fallback === 0 && (name === "w:txbxContent" || name === "v:textbox")) {
      this.shape += 1;
    }
  }

  close(name: string): void {
    if (this.fallback === 0 && (name === "w:txbxContent" || name === "v:textbox") && this.shape > 0) {
      this.shape -= 1;
    }
    if (name === "mc:Fallback" && this.fallback > 0) {
      this.fallback -= 1;
    }
  }

  /** Inside a text box, and not in the fallback copy of one. */
  inShape(): boolean {
    return this.fallback === 0 && this.shape > 0;
  }

  inFallback(): boolean {
    return this.fallback > 0;
  }

  /** A `w:p` here is not one of `body.paragraphs`. */
  hiddenFromBody(): boolean {
    return this.inShape() || this.inFallback();
  }
}

/**
 * One shape's paragraphs, in document order. Empty lines are already dropped.
 * `anchor` is the 1-based body paragraph that owns the drawing, or null when
 * the walk cannot say. Empty shapes are dropped later, so this stays with the
 * block and `[図1]` does not slide.
 */
export type AnchoredShape = {
  lines: string[];
  anchor: number | null;
};

/** What one body paragraph holds, in the same order as `body.paragraphs`. */
export type BodyParagraphFact = {
  /** Body text without the text box story and without deleted or moved-away runs. */
  text: string;
  /** A picture, chart or embedded object outside any text box. A text box anchor is not one. */
  hasDrawing: boolean;
  /** Owns a floating shape, an empty text box included. */
  hasAnchor: boolean;
  /** Holds a page or section break, so it is layout even when it has no text. */
  pageBreak: boolean;
  /** The paragraph mark is a tracked deletion, so the paragraph goes away on accept. */
  markDeleted: boolean;
  /** Written as `<w:p/>`. */
  selfClosing: boolean;
};

export type ShapePlacement = {
  blocks: AnchoredShape[];
  /** Body `w:p` elements, excluding paragraphs inside a text box. */
  bodyParagraphs: number;
  paragraphs: BodyParagraphFact[];
};

const DRAWING_TAGS = new Set(["pic:pic", "v:imagedata", "w:object", "c:chart", "dgm:relIds"]);
const ANCHOR_TAGS = new Set(["wp:anchor", "w:pict"]);

function breaksPage(name: string, attrs: string, stack: readonly string[]): boolean {
  const inProperties = stack[stack.length - 1] === "w:pPr";
  if (name === "w:br") {
    return xmlAttr(attrs, "w:type") === "page";
  }
  if (name === "w:sectPr") {
    return inProperties;
  }
  if (name === "w:pageBreakBefore") {
    const value = xmlAttr(attrs, "w:val");
    return inProperties && value !== "0" && value !== "false";
  }
  return false;
}

export const SHAPE_NOTE =
  "行頭の [図1] は段落番号ではありません。read_paragraphs には出ません。消すときは delete_shape にその数字を渡します。置換、コメント、挿入の対象にしません。";

/** Address of one shape in the section handed to the model, starting at 1. */
export function shapeLabel(number: number): string {
  return `[図${number}]`;
}

/**
 * The text we show and the text `Shape.body` returns, compared the same way.
 * Word ends a paragraph with a carriage return and a cell with a bell.
 */
export function shapeTextKey(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\u000b", "\n")
    .replaceAll("\u0007", "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function inRemovedRun(stack: string[]): boolean {
  return stack.includes("w:del") || stack.includes("w:moveFrom");
}

/**
 * Paragraphs that live in text boxes and shapes. `body.paragraphs` does not
 * include them. A frame (`w:framePr`) stays in the body story, so it is not
 * collected here. The same walk records what each body paragraph holds.
 */
export function readShapeBlocks(xml: string): ShapePlacement {
  const story = new ShapeStory();
  const stack: string[] = [];
  const blocks: AnchoredShape[] = [];
  const paragraphs: BodyParagraphFact[] = [];
  let block: AnchoredShape | null = null;
  let line: string[] = [];
  let bodyParagraphs = 0;
  let inBodyParagraph = false;

  const anchorNow = (): number | null => (inBodyParagraph ? bodyParagraphs : null);
  const inBodyStory = () => inBodyParagraph && !story.inShape() && !story.inFallback();
  const fact = () => paragraphs[paragraphs.length - 1];

  const finishLine = () => {
    const text = line.join("").trim();
    line = [];
    if (text && block) {
      block.lines.push(text);
    }
  };

  for (const event of scanXml(xml)) {
    if (event.kind === "text") {
      if (stack[stack.length - 1] === "w:t" && !inRemovedRun(stack)) {
        if (story.inShape()) {
          line.push(event.text);
        } else if (inBodyStory()) {
          fact().text += event.text;
        }
      }
      continue;
    }

    if (event.kind === "close") {
      const found = stack.lastIndexOf(event.name);
      if (found >= 0) {
        stack.length = found;
      }
      if (event.name === "w:p" && story.inShape()) {
        finishLine();
      }
      const wasShape = story.inShape();
      story.close(event.name);
      if (wasShape && !story.inShape()) {
        if (block && block.lines.length) {
          blocks.push(block);
        }
        block = null;
        line = [];
      }
      if (event.name === "w:p" && !wasShape && !story.inFallback()) {
        inBodyParagraph = false;
      }
      continue;
    }

    if (event.name === "w:p" && !story.inShape() && !story.inFallback()) {
      bodyParagraphs += 1;
      inBodyParagraph = true;
      paragraphs.push({
        text: "",
        hasDrawing: false,
        hasAnchor: false,
        pageBreak: false,
        markDeleted: false,
        selfClosing: Boolean(event.empty),
      });
    }

    if (inBodyStory() && !inRemovedRun(stack)) {
      if (DRAWING_TAGS.has(event.name)) {
        fact().hasDrawing = true;
      } else if (event.name === "w:sym") {
        fact().text += "□";
      }
      if (ANCHOR_TAGS.has(event.name)) {
        fact().hasAnchor = true;
      }
      if (breaksPage(event.name, event.attrs, stack)) {
        fact().pageBreak = true;
      }
    }
    if (
      inBodyStory() &&
      (event.name === "w:del" || event.name === "w:moveFrom") &&
      stack[stack.length - 1] === "w:rPr" &&
      stack[stack.length - 2] === "w:pPr"
    ) {
      fact().markDeleted = true;
    }

    if (event.name === "v:textpath" && !story.inFallback() && !story.inShape()) {
      const value = xmlAttr(event.attrs, "string").trim();
      if (value) {
        blocks.push({ lines: [value], anchor: anchorNow() });
      }
    }

    const wasShape = story.inShape();
    story.open(event.name);
    if (!wasShape && story.inShape()) {
      block = { lines: [], anchor: anchorNow() };
      line = [];
    }
    if (event.empty && event.name === "w:p" && !story.inShape() && !story.inFallback()) {
      inBodyParagraph = false;
    }

    if (story.inShape() && !inRemovedRun(stack)) {
      if (event.name === "w:tab") {
        line.push("\t");
      } else if (event.name === "w:br" || event.name === "w:cr") {
        line.push("\n");
      }
    }

    if (!event.empty) {
      stack.push(event.name);
    }
  }

  return { blocks, bodyParagraphs, paragraphs };
}

/** How the OOXML paragraphs were matched to `body.paragraphs`. */
export type FactAlignment = "exact" | "ooxmlTail" | "wordTail" | "selfClosing";

export type AlignedFacts = {
  /** One fact per Word paragraph. */
  facts: BodyParagraphFact[];
  /** The Word paragraph (1-based) for an OOXML paragraph number, or null. */
  place: (anchor: number | null) => number | null;
  how: FactAlignment;
};

const BLANK_FACT: BodyParagraphFact = {
  text: "",
  hasDrawing: false,
  hasAnchor: false,
  pageBreak: false,
  markDeleted: false,
  selfClosing: false,
};

function dense(text: string): string {
  return text.replace(/[\s\u3000\u0007\u000b/]/g, "");
}

/**
 * Word's text for a paragraph may still carry deleted runs, an anchor's "/" or
 * a symbol where the OOXML has `w:sym`, so the OOXML text only has to occur in it.
 */
function sameParagraph(word: string, fact: BodyParagraphFact): boolean {
  const live = dense(word);
  return dense(fact.text)
    .split("□")
    .every((piece) => live.includes(piece));
}

function isEmptyFact(fact: BodyParagraphFact): boolean {
  return !dense(fact.text) && !fact.hasDrawing && !fact.hasAnchor && !fact.pageBreak;
}

/** Word index to OOXML index, or null for a Word paragraph the OOXML lacks. */
function alignmentCandidates(
  paragraphs: readonly BodyParagraphFact[],
  words: readonly string[]
): Array<{ how: FactAlignment; source: (number | null)[] }> {
  const extra = paragraphs.length - words.length;
  const identity = (count: number) => Array.from({ length: count }, (_, index) => index);
  const candidates: Array<{ how: FactAlignment; source: (number | null)[] }> = [];
  if (extra > 0 && paragraphs.slice(words.length).every(isEmptyFact)) {
    candidates.push({ how: "ooxmlTail", source: identity(words.length) });
  }
  if (extra < 0 && words.slice(paragraphs.length).every((word) => !dense(word))) {
    candidates.push({
      how: "wordTail",
      source: [...identity(paragraphs.length), ...Array<null>(-extra).fill(null)],
    });
  }
  const kept = identity(paragraphs.length).filter((index) => !paragraphs[index].selfClosing);
  if (extra > 0 && kept.length === words.length) {
    candidates.push({ how: "selfClosing", source: kept });
  }
  return candidates;
}

/**
 * The facts in `body.paragraphs` order. Equal counts are taken as they are.
 * Otherwise a known way the two differ is tried, and used only when every
 * paragraph's text agrees with it; a wrong match would put a picture's flag
 * on a blank paragraph that a replace then deletes.
 */
export function alignBodyFacts(placement: ShapePlacement, words: readonly string[]): AlignedFacts | null {
  const paragraphs = placement.paragraphs;
  if (paragraphs.length === words.length) {
    return { facts: paragraphs, place: (anchor) => anchor, how: "exact" };
  }
  for (const { how, source } of alignmentCandidates(paragraphs, words)) {
    const fits = source.every((at, index) =>
      at === null ? !dense(words[index]) : sameParagraph(words[index], paragraphs[at])
    );
    if (!fits) {
      continue;
    }
    const wordOf = new Map<number, number>();
    source.forEach((at, index) => {
      if (at !== null) {
        wordOf.set(at + 1, index + 1);
      }
    });
    return {
      facts: source.map((at) => (at === null ? BLANK_FACT : paragraphs[at])),
      place: (anchor) => (anchor == null ? null : wordOf.get(anchor) ?? null),
      how,
    };
  }
  return null;
}

/** Counts only, for the log when the facts cannot be matched as they are. */
export function factCounts(placement: ShapePlacement, words: readonly string[]): Record<string, number> {
  const paragraphs = placement.paragraphs;
  let firstDiff = -1;
  for (let index = 0; index < Math.min(paragraphs.length, words.length); index += 1) {
    if (!sameParagraph(words[index], paragraphs[index])) {
      firstDiff = index + 1;
      break;
    }
  }
  let ooxmlTailEmpty = 0;
  for (let index = paragraphs.length - 1; index >= 0 && isEmptyFact(paragraphs[index]); index -= 1) {
    ooxmlTailEmpty += 1;
  }
  let wordTailEmpty = 0;
  for (let index = words.length - 1; index >= 0 && !dense(words[index]); index -= 1) {
    wordTailEmpty += 1;
  }
  return {
    word: words.length,
    ooxml: paragraphs.length,
    selfClosing: paragraphs.filter((fact) => fact.selfClosing).length,
    ooxmlTailEmpty,
    wordTailEmpty,
    firstDiff,
  };
}

export function fitShapeText(
  blocks: AnchoredShape[],
  maxChars: number,
  truncationNote: string,
  headingFor: (shapeNumber: number, anchor: number | null) => string = (shapeNumber) =>
    shapeLabel(shapeNumber)
): { text: string; truncated: boolean; shown: string[]; anchors: (number | null)[] } {
  const chunks = blocks
    .map((block) => ({ chunk: block.lines.join("\n"), anchor: block.anchor }))
    .filter((block) => block.chunk.length > 0);
  if (!chunks.length) {
    return { text: "", truncated: false, shown: [], anchors: [] };
  }
  if (maxChars <= 0) {
    return { text: "", truncated: true, shown: [], anchors: [] };
  }

  const shown: string[] = [];
  const anchors: (number | null)[] = [];
  let used = SHAPE_NOTE.length;
  let truncated = false;
  for (const block of chunks) {
    const labeled = `${headingFor(shown.length + 1, block.anchor)}\n${block.chunk}`;
    const gap = shown.length === 0 ? 1 : 2;
    if (used + gap + labeled.length > maxChars) {
      truncated = true;
      break;
    }
    shown.push(block.chunk);
    anchors.push(block.anchor);
    used += gap + labeled.length;
  }
  if (!shown.length) {
    truncated = true;
  }

  const labeled = shown.map(
    (chunk, index) => `${headingFor(index + 1, anchors[index])}\n${chunk}`
  );
  let text = shown.length ? `${SHAPE_NOTE}\n${labeled.join("\n\n")}` : "";
  if (truncated && truncationNote) {
    const extra = text ? `\n${truncationNote}` : truncationNote;
    if (text.length + extra.length <= maxChars) {
      text = text ? `${text}${extra}` : truncationNote;
    }
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated, shown, anchors };
}

export type ShapeTextNode = {
  text: string;
  children?: readonly ShapeTextNode[];
};

export type ShapePick<T> =
  | { ok: true; shape: T }
  | { ok: false; reason: "unknown" | "spent" | "missing" };

function shapeLeaves<T extends ShapeTextNode>(nodes: readonly T[]): T[] {
  const leaves: T[] = [];
  for (const node of nodes) {
    // Children are the same kind of node the caller stored. The field type
    // only knows the base, so the walk casts back.
    const children = node.children as readonly T[] | undefined;
    if (children && children.length > 0) {
      leaves.push(...shapeLeaves(children));
    } else {
      leaves.push(node);
    }
  }
  return leaves;
}

/**
 * The numbered block and the live shape are the same when their text matches.
 * Identical text uses the same occurrence: the second `[図]` with that text is
 * the second live shape with that text. A number already deleted still occupies
 * its occurrence, so a later duplicate does not slide onto the shape just removed.
 * A group or canvas contributes its children, not its own text.
 */
export function pickShapeByText<T extends ShapeTextNode>(
  shown: readonly string[],
  shapes: readonly T[],
  shapeNumber: number,
  spent: ReadonlySet<number> = new Set()
): ShapePick<T> {
  if (!Number.isInteger(shapeNumber) || shapeNumber < 1 || shapeNumber > shown.length) {
    return { ok: false, reason: "unknown" };
  }
  if (spent.has(shapeNumber)) {
    return { ok: false, reason: "spent" };
  }
  const target = shapeTextKey(shown[shapeNumber - 1]);
  if (!target) {
    return { ok: false, reason: "missing" };
  }
  let occurrence = 0;
  let alreadySpent = 0;
  for (let index = 0; index < shapeNumber; index += 1) {
    if (shapeTextKey(shown[index]) !== target) {
      continue;
    }
    occurrence += 1;
    if (index < shapeNumber - 1 && spent.has(index + 1)) {
      alreadySpent += 1;
    }
  }
  const wanted = occurrence - alreadySpent;
  let seen = 0;
  for (const shape of shapeLeaves(shapes)) {
    if (shapeTextKey(shape.text) !== target) {
      continue;
    }
    seen += 1;
    if (seen === wanted) {
      return { ok: true, shape };
    }
  }
  return { ok: false, reason: "missing" };
}

/**
 * The `[図]` numbers a replaced span takes with it: boxes anchored on its
 * paragraphs, and on the blank paragraphs after `through` up to the next
 * numbered one. `lastAnchor` is the furthest paragraph holding one of them, and
 * `end` the last of those blanks. With no numbered paragraph after the span,
 * the blanks past it are not taken: the attachment may have been cut short there.
 */
export function shapesInSpan(
  anchors: readonly (number | null)[],
  from: number,
  through: number,
  numbered: Iterable<number>
): { shapes: number[]; lastAnchor: number; end: number } {
  let next = Infinity;
  for (const number of numbered) {
    if (number > through && number < next) {
      next = number;
    }
  }
  const end = Number.isFinite(next) ? next - 1 : through;
  const shapes: number[] = [];
  let lastAnchor = through;
  anchors.forEach((anchor, index) => {
    if (anchor == null || anchor < from || anchor > end) {
      return;
    }
    shapes.push(index + 1);
    lastAnchor = Math.max(lastAnchor, anchor);
  });
  return { shapes, lastAnchor, end };
}

/** The body under `--- 図形 ---`. Empty when this turn has nothing to say. */
export function renderedShapeBody(shapes: { text: string; truncated: boolean; error: string }): string {
  if (shapes.error) {
    return `図形の文字は読めませんでした（${shapes.error}）。無いとは限りません。`;
  }
  if (shapes.text) {
    return shapes.text;
  }
  if (shapes.truncated) {
    return "図形の文字は添付の余白が足りず渡していません。無いとは限りません。";
  }
  return "";
}
