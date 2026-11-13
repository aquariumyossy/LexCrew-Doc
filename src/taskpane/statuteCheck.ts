/** Pure helpers for the 条文照合 button. The sidecar does the check. */

export type StatuteStatus = "match" | "number" | "review";

export type StatuteHit = {
  citation: string;
  status: StatuteStatus;
  label: string;
  reason: string;
  diff: string;
  articleText: string;
  asOf: string;
  source: string;
  offlineNote: string;
  anchor: string;
  occurrence: number;
};

export type CheckRequest = {
  text: string;
  scope: "selection" | "document";
  online: boolean;
};

/** Selection wins. An empty caret checks the whole document. */
export function checkRequest(selection: string, documentText: string, online: boolean): CheckRequest {
  if (selection.trim()) {
    return { text: selection, scope: "selection", online };
  }
  return { text: documentText, scope: "document", online };
}

export function rowLabel(hit: Pick<StatuteHit, "citation" | "label">): string {
  return `${hit.citation}：${hit.label}`;
}

export function jumpTarget(hit: Pick<StatuteHit, "anchor" | "occurrence">): {
  anchor: string;
  occurrence: number;
} {
  return { anchor: hit.anchor, occurrence: hit.occurrence };
}

/** Same count Word's literal search would use inside the checked text. */
export function occurrenceBefore(text: string, anchor: string, start: number): number {
  if (!anchor) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (from < start) {
    const at = text.indexOf(anchor, from);
    if (at < 0 || at >= start) {
      break;
    }
    count += 1;
    from = at + anchor.length;
  }
  return count;
}

export function emptyCheckMessage(scope: CheckRequest["scope"]): string {
  return scope === "selection"
    ? "選択範囲に条文の引用は見当たりません。"
    : "文書に条文の引用は見当たりません。";
}
