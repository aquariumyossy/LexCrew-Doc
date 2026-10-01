import { ListMark } from "../listMark";
import { scanXml, xmlAttr } from "./xml";

/**
 * Word stores list labels in numbering.xml, not in the paragraph text. An
 * attached file has no `listString`, so the label is rebuilt in document order.
 * One entry per non-empty `w:p`, the same paragraphs the docx readers emit.
 */

type LevelDef = {
  start: number;
  numFmt: string;
  lvlText: string;
  /** Omitted: any higher level resets this one. 0: never. 1-based level index otherwise. */
  restart: number | null;
  isLgl: boolean;
};

type NumDef = {
  abstractId: string;
  overrides: Map<number, { startOverride?: number; level?: LevelDef }>;
};

type StyleNum = {
  basedOn?: string;
  hasNumId: boolean;
  numId: number;
  hasIlvl: boolean;
  ilvl: number;
};

type ParaNum = {
  styleId?: string;
  hasNumId: boolean;
  numId: number;
  hasIlvl: boolean;
  ilvl: number;
};

const AIUEO = Array.from("アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン");
const IROHA = Array.from("イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス");
const KANJI = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function intVal(attrs: string, name: string): number | undefined {
  const raw = xmlAttr(attrs, name);
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function flagOn(attrs: string): boolean {
  const val = xmlAttr(attrs, "w:val").toLowerCase();
  return val !== "0" && val !== "false" && val !== "off";
}

function freshLevel(): LevelDef {
  return { start: 1, numFmt: "decimal", lvlText: "", restart: null, isLgl: false };
}

function parseNumbering(xml: string): { abstracts: Map<string, Map<number, LevelDef>>; nums: Map<number, NumDef> } {
  const abstracts = new Map<string, Map<number, LevelDef>>();
  const nums = new Map<number, NumDef>();
  type Frame =
    | { kind: "abstract"; id: string }
    | { kind: "num"; id: number }
    | { kind: "override"; ilvl: number }
    | { kind: "lvl"; ilvl: number; def: LevelDef }
    | { kind: "other" };
  const stack: Frame[] = [];

  const findNum = (): NumDef | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack[i];
      if (frame.kind === "num") {
        return nums.get(frame.id);
      }
    }
    return undefined;
  };

  const currentLevel = (): LevelDef | undefined => {
    const top = stack[stack.length - 1];
    return top?.kind === "lvl" ? top.def : undefined;
  };

  for (const event of scanXml(xml)) {
    if (event.kind === "close") {
      const frame = stack.pop();
      if (!frame || frame.kind !== "lvl") {
        continue;
      }
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const parent = stack[i];
        if (parent.kind === "override") {
          const num = findNum();
          if (num) {
            const record = num.overrides.get(parent.ilvl) ?? {};
            record.level = frame.def;
            num.overrides.set(parent.ilvl, record);
          }
          break;
        }
        if (parent.kind === "abstract") {
          abstracts.get(parent.id)?.set(frame.ilvl, frame.def);
          break;
        }
      }
      continue;
    }
    if (event.kind !== "open") {
      continue;
    }

    if (event.name === "w:abstractNum") {
      const id = xmlAttr(event.attrs, "w:abstractNumId");
      abstracts.set(id, abstracts.get(id) ?? new Map());
      if (!event.empty) {
        stack.push({ kind: "abstract", id });
      }
      continue;
    }
    if (event.name === "w:num") {
      const id = intVal(event.attrs, "w:numId");
      if (id === undefined) {
        if (!event.empty) {
          stack.push({ kind: "other" });
        }
        continue;
      }
      nums.set(id, nums.get(id) ?? { abstractId: "", overrides: new Map() });
      if (!event.empty) {
        stack.push({ kind: "num", id });
      }
      continue;
    }
    if (event.name === "w:lvlOverride") {
      const ilvl = intVal(event.attrs, "w:ilvl") ?? 0;
      const num = findNum();
      if (num && !num.overrides.has(ilvl)) {
        num.overrides.set(ilvl, {});
      }
      if (!event.empty) {
        stack.push({ kind: "override", ilvl });
      }
      continue;
    }
    if (event.name === "w:lvl") {
      if (!event.empty) {
        stack.push({ kind: "lvl", ilvl: intVal(event.attrs, "w:ilvl") ?? 0, def: freshLevel() });
      }
      continue;
    }
    if (event.name === "w:abstractNumId") {
      const num = findNum();
      if (num) {
        num.abstractId = xmlAttr(event.attrs, "w:val");
      }
      if (!event.empty) {
        stack.push({ kind: "other" });
      }
      continue;
    }
    if (event.name === "w:startOverride") {
      const top = stack[stack.length - 1];
      const num = findNum();
      if (top?.kind === "override" && num) {
        const record = num.overrides.get(top.ilvl) ?? {};
        record.startOverride = intVal(event.attrs, "w:val");
        num.overrides.set(top.ilvl, record);
      }
      if (!event.empty) {
        stack.push({ kind: "other" });
      }
      continue;
    }

    const level = currentLevel();
    if (level) {
      if (event.name === "w:start") {
        level.start = intVal(event.attrs, "w:val") ?? 1;
      } else if (event.name === "w:numFmt") {
        level.numFmt = xmlAttr(event.attrs, "w:val") || "decimal";
      } else if (event.name === "w:lvlText") {
        level.lvlText = xmlAttr(event.attrs, "w:val");
      } else if (event.name === "w:lvlRestart") {
        level.restart = intVal(event.attrs, "w:val") ?? 0;
      } else if (event.name === "w:isLgl") {
        level.isLgl = flagOn(event.attrs);
      }
    }
    if (!event.empty) {
      stack.push({ kind: "other" });
    }
  }

  return { abstracts, nums };
}

function parseStyles(xml: string): Map<string, StyleNum> {
  const styles = new Map<string, StyleNum>();
  let current: { id: string; style: StyleNum } | null = null;
  for (const event of scanXml(xml)) {
    if (event.kind === "close") {
      if (event.name === "w:style" && current) {
        if (current.id) {
          styles.set(current.id, current.style);
        }
        current = null;
      }
      continue;
    }
    if (event.kind !== "open") {
      continue;
    }
    if (event.name === "w:style") {
      current = {
        id: xmlAttr(event.attrs, "w:styleId"),
        style: { hasNumId: false, numId: 0, hasIlvl: false, ilvl: 0 },
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (event.name === "w:basedOn") {
      current.style.basedOn = xmlAttr(event.attrs, "w:val");
    } else if (event.name === "w:numId") {
      current.style.hasNumId = true;
      current.style.numId = intVal(event.attrs, "w:val") ?? 0;
    } else if (event.name === "w:ilvl") {
      current.style.hasIlvl = true;
      current.style.ilvl = intVal(event.attrs, "w:val") ?? 0;
    }
  }
  return styles;
}

function inherited(styles: Map<string, StyleNum>, styleId: string | undefined): StyleNum {
  const out: StyleNum = { hasNumId: false, numId: 0, hasIlvl: false, ilvl: 0 };
  const seen = new Set<string>();
  let current = styleId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const style = styles.get(current);
    if (!style) {
      break;
    }
    if (!out.hasNumId && style.hasNumId) {
      out.hasNumId = true;
      out.numId = style.numId;
    }
    if (!out.hasIlvl && style.hasIlvl) {
      out.hasIlvl = true;
      out.ilvl = style.ilvl;
    }
    current = style.basedOn;
  }
  return out;
}

function paragraphRefs(documentXml: string): ParaNum[] {
  const out: ParaNum[] = [];
  const stack: ParaNum[] = [];
  let pPrChange = 0;
  for (const event of scanXml(documentXml)) {
    if (event.kind === "close") {
      if (event.name === "w:pPrChange" && pPrChange > 0) {
        pPrChange -= 1;
      }
      if (event.name === "w:p") {
        const para = stack.pop();
        if (para) {
          out.push(para);
        }
      }
      continue;
    }
    if (event.kind !== "open") {
      continue;
    }
    if (event.name === "w:p") {
      if (!event.empty) {
        stack.push({ hasNumId: false, numId: 0, hasIlvl: false, ilvl: 0 });
      }
      continue;
    }
    if (event.name === "w:pPrChange" && !event.empty) {
      pPrChange += 1;
      continue;
    }
    if (pPrChange > 0 || stack.length === 0) {
      continue;
    }
    const para = stack[stack.length - 1];
    if (event.name === "w:pStyle") {
      para.styleId = xmlAttr(event.attrs, "w:val");
    } else if (event.name === "w:numId") {
      para.hasNumId = true;
      para.numId = intVal(event.attrs, "w:val") ?? 0;
    } else if (event.name === "w:ilvl") {
      para.hasIlvl = true;
      para.ilvl = intVal(event.attrs, "w:val") ?? 0;
    }
  }
  return out;
}

function kana(list: string[], n: number): string | null {
  return n >= 1 && n <= list.length ? list[n - 1] : null;
}

function fullWidth(n: number): string {
  return String(n).replace(/\d/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0));
}

function letters(n: number, upper: boolean): string | null {
  if (n <= 0) {
    return null;
  }
  const index = (n - 1) % 26;
  const times = Math.floor((n - 1) / 26) + 1;
  const base = (upper ? "A" : "a").charCodeAt(0);
  return String.fromCharCode(base + index).repeat(times);
}

function roman(n: number, upper: boolean): string | null {
  if (n <= 0 || n > 3999) {
    return null;
  }
  const parts: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  let left = n;
  for (const [value, glyph] of parts) {
    while (left >= value) {
      out += glyph;
      left -= value;
    }
  }
  return upper ? out : out.toLowerCase();
}

function kanjiCount(n: number): string | null {
  if (n <= 0 || n >= 10000) {
    return null;
  }
  const digits = String(n).split("").map((digit) => Number(digit));
  const units = ["", "十", "百", "千"];
  let out = "";
  digits.forEach((digit, index) => {
    const unit = units[digits.length - 1 - index];
    if (digit === 0) {
      return;
    }
    if (digit === 1 && unit) {
      out += unit;
      return;
    }
    out += KANJI[digit] + unit;
  });
  return out;
}

function circled(n: number): string | null {
  if (n >= 1 && n <= 20) {
    return String.fromCodePoint(0x2460 + n - 1);
  }
  return n > 20 ? String(n) : null;
}

function enclosedParen(n: number): string | null {
  if (n >= 1 && n <= 20) {
    return String.fromCodePoint(0x2474 + n - 1);
  }
  return n > 20 ? String(n) : null;
}

/** null means this format is not one we can show. */
function renderFmt(fmt: string, n: number): string | null {
  switch (fmt) {
    case "decimal":
      return String(n);
    case "decimalFullWidth":
      return fullWidth(n);
    case "aiueo":
    case "aiueoFullWidth":
      return kana(AIUEO, n);
    case "iroha":
    case "irohaFullWidth":
      return kana(IROHA, n);
    case "decimalEnclosedCircle":
      return circled(n);
    case "decimalEnclosedParen":
      return enclosedParen(n);
    case "upperLetter":
      return letters(n, true);
    case "lowerLetter":
      return letters(n, false);
    case "upperRoman":
      return roman(n, true);
    case "lowerRoman":
      return roman(n, false);
    case "japaneseCounting":
      return kanjiCount(n);
    case "bullet":
      return "•";
    default:
      return null;
  }
}

function resolveLevel(
  abstracts: Map<string, Map<number, LevelDef>>,
  nums: Map<number, NumDef>,
  numId: number,
  ilvl: number
): LevelDef | undefined {
  const num = nums.get(numId);
  if (!num) {
    return undefined;
  }
  const base = abstracts.get(num.abstractId)?.get(ilvl);
  const over = num.overrides.get(ilvl);
  if (!base && !over?.level) {
    return undefined;
  }
  const merged: LevelDef = { ...(over?.level ?? base!) };
  if (over?.startOverride !== undefined) {
    merged.start = over.startOverride;
  }
  return merged;
}

function levelIndexes(abstracts: Map<string, Map<number, LevelDef>>, nums: Map<number, NumDef>, numId: number): number[] {
  const num = nums.get(numId);
  if (!num) {
    return [];
  }
  const levels = new Set<number>();
  abstracts.get(num.abstractId)?.forEach((_def, ilvl) => levels.add(ilvl));
  num.overrides.forEach((_over, ilvl) => levels.add(ilvl));
  return [...levels];
}

function resets(def: LevelDef, trigger: number, deeper: number): boolean {
  if (deeper <= trigger) {
    return false;
  }
  if (def.restart === 0) {
    return false;
  }
  if (def.restart === null) {
    return true;
  }
  return trigger === def.restart - 1;
}

const UNREADABLE: ListMark = { isListItem: true, listString: "", kind: "number" };

export function paragraphListMarks(documentXml: string, numberingXml: string, stylesXml: string): (ListMark | null)[] {
  const paras = paragraphRefs(documentXml);
  if (!numberingXml.trim()) {
    return paras.map(() => null);
  }
  const { abstracts, nums } = parseNumbering(numberingXml);
  const styles = parseStyles(stylesXml);
  const counters = new Map<number, Map<number, number>>();

  const levelOf = (numId: number, ilvl: number) => resolveLevel(abstracts, nums, numId, ilvl);

  return paras.map((para) => {
    const style = inherited(styles, para.styleId);
    const hasNumId = para.hasNumId || style.hasNumId;
    if (!hasNumId) {
      return null;
    }
    const numId = para.hasNumId ? para.numId : style.numId;
    if (numId === 0) {
      return null;
    }
    const ilvl = para.hasIlvl ? para.ilvl : style.hasIlvl ? style.ilvl : 0;
    const def = levelOf(numId, ilvl);
    if (!def) {
      return UNREADABLE;
    }

    const state = counters.get(numId) ?? new Map<number, number>();
    counters.set(numId, state);
    for (const deeper of levelIndexes(abstracts, nums, numId)) {
      const deeperDef = levelOf(numId, deeper);
      if (deeperDef && resets(deeperDef, ilvl, deeper)) {
        state.delete(deeper);
      }
    }
    if (def.numFmt === "none") {
      return null;
    }
    if (def.numFmt === "bullet") {
      return { isListItem: true, listString: def.lvlText || "•", kind: "bullet" };
    }

    const next = (state.get(ilvl) ?? def.start - 1) + 1;
    state.set(ilvl, next);
    let failed = false;
    const label = def.lvlText.replace(/%(\d+)/g, (_whole, raw: string) => {
      const index = Number(raw) - 1;
      const value = state.get(index) ?? levelOf(numId, index)?.start;
      if (value === undefined) {
        failed = true;
        return "";
      }
      const fmt = def.isLgl ? "decimal" : levelOf(numId, index)?.numFmt || "decimal";
      const rendered = renderFmt(fmt, value);
      if (rendered === null) {
        failed = true;
        return "";
      }
      return rendered;
    });
    if (failed || !def.lvlText) {
      return UNREADABLE;
    }
    return { isListItem: true, listString: label, kind: "number" };
  });
}
