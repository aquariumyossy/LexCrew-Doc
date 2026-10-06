import { scanXmlTokens, xmlAttr } from "./extract/xml";

export type LineGridPatch = {
  ooxml: string;
  changed: boolean;
  lineGrid: boolean;
  autoSpacing: boolean;
};

export type IndentFormat = {
  leftPt?: number;
  firstLinePt?: number;
  /** Body size used to turn points into character units. 12 when unknown. */
  fontPt: number;
};

export type LineSpacingCopy = {
  line: string | null;
  lineRule: string | null;
};

export type ParagraphFormatOptions = {
  unsetLineGrid?: boolean;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  indent?: IndentFormat;
  /** Copy `w:line` / `w:lineRule` from a sample paragraph. */
  lineCopy?: LineSpacingCopy;
};

export type ParagraphLineSpacing = {
  snapOff: boolean;
  line: string | null;
  lineRule: string | null;
};

/**
 * Turns off paragraph line-grid snapping (`w:snapToGrid`) in the document
 * body. Styles and run-level character-grid flags are left alone so a later
 * `insertOoxml` does not rewrite Normal for the whole file.
 */
export function unsetParagraphLineGrid(ooxml: string): LineGridPatch {
  return patchParagraphFormat(ooxml, { unsetLineGrid: true });
}

/**
 * Direct paragraph properties Word.js cannot set: line-grid snap, the
 * "Auto" before/after spacing that ignores `spaceBefore` / `spaceAfter`,
 * and character-unit indent (`w:leftChars` / `w:hangingChars`) that
 * overrides the point values on Japanese Word.
 */
/**
 * Direct line spacing of the first paragraph. Snap is off only when the
 * paragraph says so. A missing flag means the document grid still applies.
 */
export function readParagraphLineSpacing(ooxml: string): ParagraphLineSpacing {
  const none: ParagraphLineSpacing = { snapOff: false, line: null, lineRule: null };
  if (!ooxml) {
    return none;
  }
  const part = documentXmlRange(ooxml);
  const xml = part ? ooxml.slice(part.start, part.end) : ooxml;
  const stack: string[] = [];
  let inFirst = false;
  let inPPr = false;
  let seen = false;
  let snapOff = false;
  let spacingAttrs: string | null = null;
  for (const token of scanXmlTokens(xml)) {
    if (token.kind === "open") {
      const local = localName(token.name);
      const parent = stack.length ? stack[stack.length - 1] : "";
      if (local === "p" && !seen) {
        seen = true;
        inFirst = !token.empty;
        if (token.empty) {
          break;
        }
      } else if (local === "pPr" && parent === "p" && inFirst && !inPPr) {
        inPPr = !token.empty;
      } else if (local === "snapToGrid" && parent === "pPr" && inFirst && inPPr && token.empty) {
        snapOff = snapIsOff(token.attrs);
      } else if (local === "spacing" && parent === "pPr" && inFirst && inPPr && token.empty) {
        spacingAttrs = token.attrs;
      }
      if (!token.empty) {
        stack.push(local);
      }
      continue;
    }
    if (token.kind !== "close") {
      continue;
    }
    const local = localName(token.name);
    if (stack.length && stack[stack.length - 1] === local) {
      stack.pop();
    }
    if (local === "pPr") {
      inPPr = false;
    }
    if (local === "p" && seen) {
      break;
    }
  }
  return {
    snapOff,
    line: spacingAttrs ? localAttr(spacingAttrs, "line") : null,
    lineRule: spacingAttrs ? localAttr(spacingAttrs, "lineRule") : null,
  };
}

export function patchParagraphFormat(
  ooxml: string,
  options: ParagraphFormatOptions
): LineGridPatch {
  const empty: LineGridPatch = { ooxml, changed: false, lineGrid: false, autoSpacing: false };
  if (
    !options.unsetLineGrid &&
    options.spaceBeforePt === undefined &&
    options.spaceAfterPt === undefined &&
    !options.indent &&
    !options.lineCopy
  ) {
    return empty;
  }
  const part = documentXmlRange(ooxml);
  if (!part) {
    const patched = patchParagraphs(ooxml, options);
    return patched.changed
      ? {
          ooxml: patched.xml,
          changed: true,
          lineGrid: patched.lineGrid,
          autoSpacing: patched.autoSpacing,
        }
      : empty;
  }
  const inner = ooxml.slice(part.start, part.end);
  const patched = patchParagraphs(inner, options);
  if (!patched.changed) {
    return empty;
  }
  return {
    ooxml: ooxml.slice(0, part.start) + patched.xml + ooxml.slice(part.end),
    changed: true,
    lineGrid: patched.lineGrid,
    autoSpacing: patched.autoSpacing,
  };
}

function documentXmlRange(ooxml: string): { start: number; end: number } | null {
  for (const token of scanXmlTokens(ooxml)) {
    if (token.kind !== "open" || localName(token.name) !== "part" || token.empty) {
      continue;
    }
    if (!isDocumentPartName(partName(token.attrs))) {
      continue;
    }
    const rest = ooxml.slice(token.end);
    const open = /<(?:[A-Za-z0-9._-]+:)?xmlData(?:\s[^>]*)?>/.exec(rest);
    if (!open || open.index === undefined) {
      return null;
    }
    const innerStart = token.end + open.index + open[0].length;
    const close = /<\/(?:[A-Za-z0-9._-]+:)?xmlData\s*>/.exec(ooxml.slice(innerStart));
    if (!close || close.index === undefined) {
      return null;
    }
    return { start: innerStart, end: innerStart + close.index };
  }
  return null;
}

function partName(attrs: string): string {
  return xmlAttr(attrs, "pkg:name") || xmlAttr(attrs, "name");
}

function isDocumentPartName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  return normalized === "word/document.xml";
}

type Replacement = { start: number; end: number; text: string };
type PatchFlags = { changed: boolean; lineGrid: boolean; autoSpacing: boolean };

type SpacingEl = { start: number; end: number; attrs: string };
type IndEl = { start: number; end: number; attrs: string };
type PPrEl = {
  prefix: string;
  openStart: number;
  openEnd: number;
  empty: boolean;
  innerStart: number;
  snap: { start: number; end: number; off: boolean } | null;
  openSnap: { start: number; off: boolean } | null;
  spacing: SpacingEl | null;
  openSpacing: { start: number; attrs: string } | null;
  ind: IndEl | null;
  openInd: { start: number; attrs: string } | null;
};
type ParaEl = {
  prefix: string;
  afterOpen: number;
  empty: boolean;
  openStart: number;
  openEnd: number;
  pPr: PPrEl | null;
};

function patchParagraphs(
  xml: string,
  options: ParagraphFormatOptions
): { xml: string } & PatchFlags {
  const flags: PatchFlags = { changed: false, lineGrid: false, autoSpacing: false };
  if (!xml) {
    return { xml, ...flags };
  }
  const stack: string[] = [];
  const paras: ParaEl[] = [];
  let current: ParaEl | null = null;
  let pPr: PPrEl | null = null;

  for (const token of scanXmlTokens(xml)) {
    if (token.kind === "open") {
      const local = localName(token.name);
      const parent = stack.length ? stack[stack.length - 1] : "";
      const grandparent = stack.length >= 2 ? stack[stack.length - 2] : "";
      if (local === "p") {
        const para: ParaEl = {
          prefix: namePrefix(token.name),
          afterOpen: token.end,
          empty: token.empty,
          openStart: token.start,
          openEnd: token.end,
          pPr: null,
        };
        paras.push(para);
        current = token.empty ? null : para;
      } else if (local === "pPr" && parent === "p" && current && !current.pPr) {
        pPr = {
          prefix: namePrefix(token.name),
          openStart: token.start,
          openEnd: token.end,
          empty: token.empty,
          innerStart: token.end,
          snap: null,
          openSnap: null,
          spacing: null,
          openSpacing: null,
          ind: null,
          openInd: null,
        };
        current.pPr = pPr;
        if (token.empty) {
          pPr = null;
        }
      } else if (
        local === "snapToGrid" &&
        parent === "pPr" &&
        grandparent === "p" &&
        pPr
      ) {
        const off = snapIsOff(token.attrs);
        if (token.empty) {
          pPr.snap = { start: token.start, end: token.end, off };
        } else {
          pPr.openSnap = { start: token.start, off };
        }
      } else if (local === "spacing" && parent === "pPr" && grandparent === "p" && pPr) {
        if (token.empty) {
          pPr.spacing = { start: token.start, end: token.end, attrs: token.attrs };
        } else {
          pPr.openSpacing = { start: token.start, attrs: token.attrs };
        }
      } else if (local === "ind" && parent === "pPr" && grandparent === "p" && pPr) {
        if (token.empty) {
          pPr.ind = { start: token.start, end: token.end, attrs: token.attrs };
        } else {
          pPr.openInd = { start: token.start, attrs: token.attrs };
        }
      }
      if (!token.empty) {
        stack.push(local);
      }
      continue;
    }
    if (token.kind !== "close") {
      continue;
    }
    const local = localName(token.name);
    const top = stack.length ? stack[stack.length - 1] : "";
    const parent = stack.length >= 2 ? stack[stack.length - 2] : "";
    const grandparent = stack.length >= 3 ? stack[stack.length - 3] : "";
    if (
      local === "snapToGrid" &&
      top === "snapToGrid" &&
      parent === "pPr" &&
      grandparent === "p" &&
      pPr?.openSnap
    ) {
      pPr.snap = { start: pPr.openSnap.start, end: token.end, off: pPr.openSnap.off };
      pPr.openSnap = null;
    }
    if (
      local === "spacing" &&
      top === "spacing" &&
      parent === "pPr" &&
      grandparent === "p" &&
      pPr?.openSpacing
    ) {
      pPr.spacing = {
        start: pPr.openSpacing.start,
        end: token.end,
        attrs: pPr.openSpacing.attrs,
      };
      pPr.openSpacing = null;
    }
    if (
      local === "ind" &&
      top === "ind" &&
      parent === "pPr" &&
      grandparent === "p" &&
      pPr?.openInd
    ) {
      pPr.ind = { start: pPr.openInd.start, end: token.end, attrs: pPr.openInd.attrs };
      pPr.openInd = null;
    }
    if (local === "pPr" && top === "pPr" && parent === "p") {
      pPr = null;
    }
    if (local === "p" && top === "p") {
      current = null;
      pPr = null;
    }
    if (top === local) {
      stack.pop();
    }
  }

  const replacements: Replacement[] = [];
  for (const para of paras) {
    const next = paragraphReplacements(xml, para, options);
    replacements.push(...next.items);
    flags.lineGrid = flags.lineGrid || next.lineGrid;
    flags.autoSpacing = flags.autoSpacing || next.autoSpacing;
  }
  if (!replacements.length) {
    return { xml, ...flags };
  }
  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = xml;
  for (const item of replacements) {
    out = out.slice(0, item.start) + item.text + out.slice(item.end);
  }
  return { xml: out, changed: true, lineGrid: flags.lineGrid, autoSpacing: flags.autoSpacing };
}

function paragraphReplacements(
  xml: string,
  para: ParaEl,
  options: ParagraphFormatOptions
): { items: Replacement[]; lineGrid: boolean; autoSpacing: boolean } {
  const prefix = para.pPr?.prefix || para.prefix;
  const snap = options.unsetLineGrid ? snapPatch(para, prefix) : null;
  const spacing = spacingPatch(para, prefix, options);
  const indent = indentPatch(para, prefix, options);

  if (para.empty) {
    const inner = `${snap?.text || ""}${spacing?.text || ""}${indent?.text || ""}`;
    if (!inner) {
      return { items: [], lineGrid: false, autoSpacing: false };
    }
    const open = xml.slice(para.openStart, para.openEnd).replace(/\/\s*>$/, ">");
    return {
      items: [
        {
          start: para.openStart,
          end: para.openEnd,
          text: `${open}<${qualify(prefix, "pPr")}>${inner}</${qualify(prefix, "pPr")}></${qualify(prefix, "p")}>`,
        },
      ],
      lineGrid: Boolean(snap),
      autoSpacing: Boolean(spacing),
    };
  }

  const pPr = para.pPr;
  if (!pPr) {
    const inner = `${snap?.text || ""}${spacing?.text || ""}${indent?.text || ""}`;
    if (!inner) {
      return { items: [], lineGrid: false, autoSpacing: false };
    }
    return {
      items: [
        {
          start: para.afterOpen,
          end: para.afterOpen,
          text: `<${qualify(prefix, "pPr")}>${inner}</${qualify(prefix, "pPr")}>`,
        },
      ],
      lineGrid: Boolean(snap),
      autoSpacing: Boolean(spacing),
    };
  }

  if (pPr.empty) {
    const inner = `${snap?.text || ""}${spacing?.text || ""}${indent?.text || ""}`;
    if (!inner) {
      return { items: [], lineGrid: false, autoSpacing: false };
    }
    const open = xml.slice(pPr.openStart, pPr.openEnd).replace(/\/\s*>$/, ">");
    return {
      items: [
        {
          start: pPr.openStart,
          end: pPr.openEnd,
          text: `${open}${inner}</${qualify(prefix, "pPr")}>`,
        },
      ],
      lineGrid: Boolean(snap),
      autoSpacing: Boolean(spacing),
    };
  }

  const items: Replacement[] = [];
  const inserts: string[] = [];
  let lineGrid = false;
  let autoSpacing = false;
  if (snap) {
    if (snap.start === snap.end) {
      inserts.push(snap.text);
    } else {
      items.push(snap);
    }
    lineGrid = true;
  }
  if (spacing) {
    if (spacing.start === spacing.end) {
      inserts.push(spacing.text);
    } else {
      items.push(spacing);
    }
    autoSpacing = true;
  }
  if (indent) {
    if (indent.start === indent.end) {
      inserts.push(indent.text);
    } else {
      items.push(indent);
    }
  }
  if (inserts.length) {
    items.push({ start: pPr.innerStart, end: pPr.innerStart, text: inserts.join("") });
  }
  return { items, lineGrid, autoSpacing };
}

function snapPatch(para: ParaEl, prefix: string): Replacement | null {
  const tag = snapOffTag(prefix);
  const pPr = para.pPr;
  if (!pPr || pPr.empty) {
    return { start: 0, end: 0, text: tag };
  }
  if (pPr.snap) {
    if (pPr.snap.off) {
      return null;
    }
    return { start: pPr.snap.start, end: pPr.snap.end, text: tag };
  }
  return { start: pPr.innerStart, end: pPr.innerStart, text: tag };
}

function spacingPatch(
  para: ParaEl,
  prefix: string,
  options: ParagraphFormatOptions
): Replacement | null {
  if (
    options.spaceBeforePt === undefined &&
    options.spaceAfterPt === undefined &&
    !options.lineCopy
  ) {
    return null;
  }
  const existing = para.pPr && !para.pPr.empty ? para.pPr.spacing : null;
  const built = buildSpacingTag(prefix, existing?.attrs || "", options);
  if (!built.changed) {
    return null;
  }
  if (existing) {
    return { start: existing.start, end: existing.end, text: built.tag };
  }
  if (!para.pPr || para.pPr.empty) {
    return { start: 0, end: 0, text: built.tag };
  }
  return { start: para.pPr.innerStart, end: para.pPr.innerStart, text: built.tag };
}

function indentPatch(
  para: ParaEl,
  prefix: string,
  options: ParagraphFormatOptions
): Replacement | null {
  if (!options.indent) {
    return null;
  }
  const existing = para.pPr && !para.pPr.empty ? para.pPr.ind : null;
  const built = buildIndTag(prefix, existing?.attrs || "", options.indent);
  if (!built.changed) {
    return null;
  }
  if (existing) {
    return { start: existing.start, end: existing.end, text: built.tag };
  }
  if (!para.pPr || para.pPr.empty) {
    return { start: 0, end: 0, text: built.tag };
  }
  return { start: para.pPr.innerStart, end: para.pPr.innerStart, text: built.tag };
}

function buildIndTag(
  prefix: string,
  existingAttrs: string,
  indent: IndentFormat
): { tag: string; changed: boolean } {
  const attrs = readAttrs(existingAttrs);
  let changed = false;
  if (indent.leftPt !== undefined) {
    changed = setAttr(attrs, "left", twips(indent.leftPt), prefix) || changed;
    changed = setAttr(attrs, "leftChars", charHundredths(indent.leftPt, indent.fontPt), prefix) || changed;
  }
  if (indent.firstLinePt !== undefined) {
    if (indent.firstLinePt < 0) {
      changed = dropAttr(attrs, "firstLine") || changed;
      changed = dropAttr(attrs, "firstLineChars") || changed;
      changed = setAttr(attrs, "hanging", twips(Math.abs(indent.firstLinePt)), prefix) || changed;
      changed =
        setAttr(attrs, "hangingChars", charHundredths(Math.abs(indent.firstLinePt), indent.fontPt), prefix) ||
        changed;
    } else if (indent.firstLinePt > 0) {
      changed = dropAttr(attrs, "hanging") || changed;
      changed = dropAttr(attrs, "hangingChars") || changed;
      changed = setAttr(attrs, "firstLine", twips(indent.firstLinePt), prefix) || changed;
      changed =
        setAttr(attrs, "firstLineChars", charHundredths(indent.firstLinePt, indent.fontPt), prefix) ||
        changed;
    } else {
      changed = dropAttr(attrs, "firstLine") || changed;
      changed = dropAttr(attrs, "firstLineChars") || changed;
      changed = dropAttr(attrs, "hanging") || changed;
      changed = dropAttr(attrs, "hangingChars") || changed;
    }
  }
  const name = qualify(prefix, "ind");
  const body = writeAttrs(attrs);
  return { tag: body ? `<${name} ${body}/>` : `<${name}/>`, changed };
}

function buildSpacingTag(
  prefix: string,
  existingAttrs: string,
  options: ParagraphFormatOptions
): { tag: string; changed: boolean } {
  const attrs = readAttrs(existingAttrs);
  let changed = false;
  if (options.spaceBeforePt !== undefined) {
    changed = setAttr(attrs, "beforeAutospacing", "0", prefix) || changed;
    changed = setAttr(attrs, "before", twips(options.spaceBeforePt), prefix) || changed;
    changed = zeroAttrIfPresent(attrs, "beforeLines") || changed;
  }
  if (options.spaceAfterPt !== undefined) {
    changed = setAttr(attrs, "afterAutospacing", "0", prefix) || changed;
    changed = setAttr(attrs, "after", twips(options.spaceAfterPt), prefix) || changed;
    changed = zeroAttrIfPresent(attrs, "afterLines") || changed;
  }
  if (options.lineCopy?.line) {
    changed = setAttr(attrs, "line", options.lineCopy.line, prefix) || changed;
  }
  if (options.lineCopy?.lineRule) {
    changed = setAttr(attrs, "lineRule", options.lineCopy.lineRule, prefix) || changed;
  }
  const name = qualify(prefix, "spacing");
  const body = writeAttrs(attrs);
  return { tag: body ? `<${name} ${body}/>` : `<${name}/>`, changed };
}

type Attr = { name: string; value: string };

function readAttrs(attrs: string): Attr[] {
  const out: Attr[] = [];
  const pattern = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(attrs))) {
    out.push({ name: hit[1], value: hit[2] !== undefined ? hit[2] : hit[3] || "" });
  }
  return out;
}

function writeAttrs(attrs: Attr[]): string {
  return attrs.map((attr) => `${attr.name}="${attr.value}"`).join(" ");
}

function setAttr(attrs: Attr[], local: string, value: string, prefix: string): boolean {
  const index = attrs.findIndex((attr) => localName(attr.name) === local);
  if (index >= 0) {
    if (attrs[index].value === value) {
      return false;
    }
    attrs[index] = { name: attrs[index].name, value };
    return true;
  }
  attrs.push({ name: prefix ? `${prefix}:${local}` : local, value });
  return true;
}

function dropAttr(attrs: Attr[], local: string): boolean {
  const index = attrs.findIndex((attr) => localName(attr.name) === local);
  if (index < 0) {
    return false;
  }
  attrs.splice(index, 1);
  return true;
}

function charHundredths(pt: number, fontPt: number): string {
  const em = fontPt > 0 ? fontPt : 12;
  return String(Math.round((pt / em) * 100));
}

function zeroAttrIfPresent(attrs: Attr[], local: string): boolean {
  const index = attrs.findIndex((attr) => localName(attr.name) === local);
  if (index < 0 || attrs[index].value === "0") {
    return false;
  }
  attrs[index] = { name: attrs[index].name, value: "0" };
  return true;
}

function twips(pt: number): string {
  return String(Math.round(pt * 20));
}

function snapOffTag(prefix: string): string {
  return prefix ? `<${prefix}:snapToGrid ${prefix}:val="0"/>` : `<snapToGrid val="0"/>`;
}

function snapIsOff(attrs: string): boolean {
  const val = xmlAttr(attrs, "w:val") || xmlAttr(attrs, "val");
  if (!val) {
    return false;
  }
  const lower = val.trim().toLowerCase();
  return lower === "0" || lower === "false" || lower === "off";
}

function localAttr(attrs: string, local: string): string | null {
  for (const attr of readAttrs(attrs)) {
    if (localName(attr.name) === local && attr.value) {
      return attr.value;
    }
  }
  return null;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function namePrefix(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? "" : name.slice(0, colon);
}

function qualify(prefix: string, local: string): string {
  return prefix ? `${prefix}:${local}` : local;
}
