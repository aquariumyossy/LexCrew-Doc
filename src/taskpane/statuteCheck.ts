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

export function emptyCheckMessage(scope: CheckRequest["scope"]): string {
  return scope === "selection"
    ? "選択範囲に条文の引用は見当たりません。"
    : "文書に条文の引用は見当たりません。";
}
