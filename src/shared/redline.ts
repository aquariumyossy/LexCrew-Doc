export type RedlineOp = {
  /** Index in `before`. Equal to `end` for a pure insertion. */
  start: number;
  /** Index in `before`. */
  end: number;
  /** Empty for a pure deletion. */
  text: string;
};

type Run = { kind: "equal" | "delete" | "insert"; items: string[] };

/** Where each accepted character sits in the raw word-character list. */
export type ReviewedAlignment = {
  /** Raw index for each reviewed character. `-1` when more than one raw index fits. */
  rawIndex: number[];
  /** Half-open ranges of reviewed indices whose raw index is not unique. */
  ambiguous: { start: number; end: number }[];
};

/**
 * Map `reviewed` onto `raw` when `reviewed` is `raw` with some characters
 * deleted. A repeated character next to the same deleted character has more
 * than one raw index; those reviewed indices are `-1`.
 * Returns null when `reviewed` is not a subsequence of `raw`.
 */
export function alignReviewed(raw: readonly string[], reviewed: string): ReviewedAlignment | null {
  const target = Array.from(reviewed);
  const row = raw.length + 1;
  const pref = new Uint8Array((target.length + 1) * row);
  const suf = new Uint8Array((target.length + 1) * row);
  const at = (i: number, j: number) => i * row + j;
  for (let j = 0; j <= raw.length; j += 1) {
    pref[at(0, j)] = 1;
    suf[at(target.length, j)] = 1;
  }
  for (let i = 1; i <= target.length; i += 1) {
    for (let j = 1; j <= raw.length; j += 1) {
      let ways = pref[at(i, j - 1)];
      if (raw[j - 1] === target[i - 1]) {
        ways += pref[at(i - 1, j - 1)];
      }
      pref[at(i, j)] = ways > 2 ? 2 : ways;
    }
  }
  if (pref[at(target.length, raw.length)] === 0) {
    return null;
  }
  for (let i = target.length - 1; i >= 0; i -= 1) {
    for (let j = raw.length - 1; j >= 0; j -= 1) {
      let ways = suf[at(i, j + 1)];
      if (raw[j] === target[i]) {
        ways += suf[at(i + 1, j + 1)];
      }
      suf[at(i, j)] = ways > 2 ? 2 : ways;
    }
  }

  const rawIndex: number[] = [];
  const ambiguousAt: boolean[] = [];
  for (let i = 0; i < target.length; i += 1) {
    const hits: number[] = [];
    for (let j = 0; j < raw.length; j += 1) {
      if (raw[j] === target[i] && pref[at(i, j)] > 0 && suf[at(i + 1, j + 1)] > 0) {
        hits.push(j);
      }
    }
    if (hits.length === 1) {
      rawIndex.push(hits[0]);
      ambiguousAt.push(false);
    } else if (hits.length > 1) {
      rawIndex.push(-1);
      ambiguousAt.push(true);
    } else {
      return null;
    }
  }

  const ambiguous: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= target.length; i += 1) {
    const on = i < target.length && ambiguousAt[i];
    if (on && start < 0) {
      start = i;
    }
    if (!on && start >= 0) {
      ambiguous.push({ start, end: i });
      start = -1;
    }
  }
  return { rawIndex, ambiguous };
}

/**
 * An op hits a deletion when its reviewed span covers raw characters that are
 * not in that span, or when it touches a reviewed character with two raw indices.
 * An insertion at the start of a uniquely mapped character stays off the deletion
 * that sits immediately before that character.
 */
export function opHitsDeletion(op: RedlineOp, alignment: ReviewedAlignment, rawLength: number): boolean {
  const { rawIndex } = alignment;
  if (op.start === op.end) {
    if (rawIndex.length === 0) {
      return rawLength > 0;
    }
    if (op.start > 0 && rawIndex[op.start - 1] < 0) {
      return true;
    }
    if (op.start < rawIndex.length && rawIndex[op.start] < 0) {
      return true;
    }
    return false;
  }
  for (let i = op.start; i < op.end; i += 1) {
    if (rawIndex[i] < 0) {
      return true;
    }
  }
  return rawIndex[op.end - 1] - rawIndex[op.start] + 1 !== op.end - op.start;
}

/**
 * Edits that turn `before` into `after`, one token per Word character.
 * A matching token shorter than the edits on both sides is absorbed, so a
 * single particle does not stay behind as the only unchanged character.
 * A token the same length as those edits stays, and so does a longer gap.
 */
export function planRedline(before: readonly string[], after: readonly string[]): RedlineOp[] {
  return opsFrom(absorb(diffRuns(before, after)));
}

function diffRuns(before: readonly string[], after: readonly string[]): Run[] {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const runs: Run[] = [];
  if (start) {
    runs.push({ kind: "equal", items: before.slice(0, start).slice() });
  }
  runs.push(...editRuns(before.slice(start, endBefore), after.slice(start, endAfter)));
  if (endBefore < before.length) {
    runs.push({ kind: "equal", items: before.slice(endBefore).slice() });
  }
  return mergeRuns(runs);
}

function editRuns(before: readonly string[], after: readonly string[]): Run[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const raw: Run[] = [];
  const push = (kind: Run["kind"], item: string) => {
    const last = raw[raw.length - 1];
    if (last && last.kind === kind) {
      last.items.push(item);
    } else {
      raw.push({ kind, items: [item] });
    }
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      push("equal", before[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("delete", before[i]);
      i += 1;
    } else {
      push("insert", after[j]);
      j += 1;
    }
  }
  while (i < n) {
    push("delete", before[i]);
    i += 1;
  }
  while (j < m) {
    push("insert", after[j]);
    j += 1;
  }
  return raw;
}

function absorb(runs: Run[]): Run[] {
  let current = mergeRuns(runs);
  for (;;) {
    const index = current.findIndex((run, at) => {
      if (run.kind !== "equal" || at === 0 || at === current.length - 1) {
        return false;
      }
      const left = streakSize(current, at - 1, -1);
      const right = streakSize(current, at + 1, 1);
      return left > 0 && right > 0 && run.items.length < left && run.items.length < right;
    });
    if (index < 0) {
      return current;
    }
    const items = current[index].items.slice();
    current.splice(index, 1, { kind: "delete", items }, { kind: "insert", items: items.slice() });
    current = mergeRuns(current);
  }
}

function streakSize(runs: Run[], from: number, step: -1 | 1): number {
  let deleted = 0;
  let inserted = 0;
  for (let i = from; i >= 0 && i < runs.length; i += step) {
    const run = runs[i];
    if (run.kind === "equal") {
      break;
    }
    if (run.kind === "delete") {
      deleted += run.items.length;
    } else {
      inserted += run.items.length;
    }
  }
  return Math.max(deleted, inserted);
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === run.kind) {
      prev.items.push(...run.items);
    } else if (run.items.length) {
      out.push({ kind: run.kind, items: run.items.slice() });
    }
  }
  return out;
}

function opsFrom(runs: Run[]): RedlineOp[] {
  const ops: RedlineOp[] = [];
  let index = 0;
  let at = 0;
  while (at < runs.length) {
    const run = runs[at];
    if (run.kind === "equal") {
      index += run.items.length;
      at += 1;
      continue;
    }
    const deleted: string[] = [];
    const inserted: string[] = [];
    while (at < runs.length && runs[at].kind !== "equal") {
      const next = runs[at];
      if (next.kind === "delete") {
        deleted.push(...next.items);
      } else {
        inserted.push(...next.items);
      }
      at += 1;
    }
    ops.push({ start: index, end: index + deleted.length, text: inserted.join("") });
    index += deleted.length;
  }
  return ops;
}
