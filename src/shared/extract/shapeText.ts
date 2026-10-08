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

/** One shape's paragraphs, in document order. Empty lines are already dropped. */
export type ShapeBlock = string[];

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
 * collected here.
 */
export function readShapeBlocks(xml: string): ShapeBlock[] {
  const story = new ShapeStory();
  const stack: string[] = [];
  const blocks: ShapeBlock[] = [];
  let block: ShapeBlock | null = null;
  let line: string[] = [];

  const finishLine = () => {
    const text = line.join("").trim();
    line = [];
    if (text && block) {
      block.push(text);
    }
  };

  for (const event of scanXml(xml)) {
    if (event.kind === "text") {
      if (story.inShape() && stack[stack.length - 1] === "w:t" && !inRemovedRun(stack)) {
        line.push(event.text);
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
        if (block && block.length) {
          blocks.push(block);
        }
        block = null;
        line = [];
      }
      continue;
    }

    if (event.name === "v:textpath" && !story.inFallback() && !story.inShape()) {
      const value = xmlAttr(event.attrs, "string").trim();
      if (value) {
        blocks.push([value]);
      }
    }

    const wasShape = story.inShape();
    story.open(event.name);
    if (!wasShape && story.inShape()) {
      block = [];
      line = [];
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

  return blocks;
}

export function fitShapeText(
  blocks: ShapeBlock[],
  maxChars: number,
  truncationNote: string
): { text: string; truncated: boolean; shown: string[] } {
  const chunks = blocks.map((lines) => lines.join("\n")).filter((chunk) => chunk.length > 0);
  if (!chunks.length) {
    return { text: "", truncated: false, shown: [] };
  }
  if (maxChars <= 0) {
    return { text: "", truncated: true, shown: [] };
  }

  const shown: string[] = [];
  let used = SHAPE_NOTE.length;
  let truncated = false;
  for (const chunk of chunks) {
    const labeled = `${shapeLabel(shown.length + 1)}\n${chunk}`;
    const gap = shown.length === 0 ? 1 : 2;
    if (used + gap + labeled.length > maxChars) {
      truncated = true;
      break;
    }
    shown.push(chunk);
    used += gap + labeled.length;
  }
  if (!shown.length) {
    truncated = true;
  }

  const labeled = shown.map((chunk, index) => `${shapeLabel(index + 1)}\n${chunk}`);
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
  return { text, truncated, shown };
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
