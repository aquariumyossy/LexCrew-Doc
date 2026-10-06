import { LineSpacingChars, lineSpacingPt } from "./constants";

export const SAMPLE_RADIUS = 24;

export type UserFormat = {
  fontName?: string;
  bodyPt?: number;
  titlePt?: number;
  lineSpacingChars?: LineSpacingChars;
};

export type SettingsFormat = {
  fontName: string;
  bodyPt: number;
  titlePt: number;
  lineSpacingChars: LineSpacingChars;
};

/** One paragraph near the insert anchor. Spacing is filled after the face is chosen. */
export type FaceReading = {
  text: string;
  name: string;
  nameFarEast: string;
  sizePt: number;
  centered: boolean;
  heading: boolean;
  inTable: boolean;
};

export type SampleSpacing =
  | { kind: "keep" }
  | { kind: "copy"; line: string | null; lineRule: string | null };

export type SampledParagraph = FaceReading & { spacing: SampleSpacing };

export type FontWrite = { write: true; name: string; nameFarEast: string } | { write: false };

export type SizeWrite = { write: true; pt: number } | { write: false };

export type SpacingWrite =
  | { kind: "exact"; pt: number }
  | { kind: "copy"; line: string | null; lineRule: string | null }
  | { kind: "keep" };

export type BlockFormat = {
  font: FontWrite;
  size: SizeWrite;
  spacing: SpacingWrite;
  applyIndent: boolean;
  /** Body size used as one character of indent when indent is applied. */
  indentEm: number;
};

export type ResolvedInsert = {
  body: BlockFormat;
  title: BlockFormat;
};

function trimmed(value: string | undefined): string {
  return (value || "").trim();
}

function readable(sample: FaceReading): boolean {
  return Boolean(trimmed(sample.text) && sample.sizePt > 0 && (trimmed(sample.name) || trimmed(sample.nameFarEast)));
}

function bodyCandidate(sample: FaceReading): boolean {
  return readable(sample) && !sample.heading && !sample.centered && !sample.inTable;
}

function titleCandidate(sample: FaceReading, bodySize: number | null): boolean {
  if (!readable(sample) || sample.inTable) {
    return false;
  }
  if (sample.centered) {
    return true;
  }
  return bodySize !== null && sample.sizePt > bodySize;
}

function nearestIndex(
  samples: FaceReading[],
  anchorIndex: number,
  accept: (sample: FaceReading) => boolean
): number | null {
  let best: { index: number; distance: number } | null = null;
  for (let index = 0; index < samples.length; index += 1) {
    if (!accept(samples[index])) {
      continue;
    }
    const distance = Math.abs(index - anchorIndex);
    const before = index <= anchorIndex;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && before && best.index > anchorIndex)
    ) {
      best = { index, distance };
    }
  }
  return best ? best.index : null;
}

function faceOf(sample: FaceReading): { name: string; nameFarEast: string } {
  const east = trimmed(sample.nameFarEast);
  const ascii = trimmed(sample.name);
  return { name: ascii || east, nameFarEast: east || ascii };
}

function fontWrite(
  userName: string | undefined,
  sample: FaceReading | null,
  settingsName: string,
  hasBody: boolean
): FontWrite {
  const requested = trimmed(userName);
  if (requested) {
    return { write: true, name: requested, nameFarEast: requested };
  }
  if (sample) {
    return { write: true, ...faceOf(sample) };
  }
  if (!hasBody && trimmed(settingsName)) {
    return { write: true, name: settingsName, nameFarEast: settingsName };
  }
  return { write: false };
}

function sizeWrite(
  userPt: number | undefined,
  samplePt: number | undefined,
  settingsPt: number,
  allowSettings: boolean
): SizeWrite {
  if (userPt !== undefined && userPt > 0) {
    return { write: true, pt: userPt };
  }
  if (samplePt !== undefined && samplePt > 0) {
    return { write: true, pt: samplePt };
  }
  if (allowSettings && settingsPt > 0) {
    return { write: true, pt: settingsPt };
  }
  return { write: false };
}

function spacingWrite(
  userChars: number | undefined,
  sample: SampledParagraph | null,
  settingsChars: number,
  sizePt: number,
  allowSettings: boolean
): SpacingWrite {
  if (userChars !== undefined) {
    return { kind: "exact", pt: lineSpacingPt(sizePt > 0 ? sizePt : 12, userChars) };
  }
  if (sample) {
    return sample.spacing.kind === "copy"
      ? { kind: "copy", line: sample.spacing.line, lineRule: sample.spacing.lineRule }
      : { kind: "keep" };
  }
  if (allowSettings) {
    return { kind: "exact", pt: lineSpacingPt(sizePt > 0 ? sizePt : 12, settingsChars) };
  }
  return { kind: "keep" };
}

/**
 * Per field, the chat argument wins, then a nearby paragraph, then settings
 * when the document has no body. A document with text but no readable face
 * leaves that field unset.
 */
export function resolveInsertFormats(
  user: UserFormat,
  samples: SampledParagraph[],
  anchorIndex: number,
  settings: SettingsFormat,
  hasBody: boolean
): ResolvedInsert {
  const bodyIndex = nearestIndex(samples, anchorIndex, bodyCandidate);
  const body = bodyIndex === null ? null : samples[bodyIndex];
  const titleIndex = nearestIndex(samples, anchorIndex, (sample) =>
    titleCandidate(sample, body ? body.sizePt : null)
  );
  const title = titleIndex === null ? null : samples[titleIndex];
  const titleOnly = !body && Boolean(title);

  const bodySize = sizeWrite(
    user.bodyPt,
    body?.sizePt,
    settings.bodyPt,
    !hasBody || titleOnly
  );
  const titleSize = sizeWrite(
    user.titlePt,
    title?.sizePt ?? body?.sizePt,
    settings.titlePt,
    !hasBody && !title && !body
  );
  const bodyPt = bodySize.write ? bodySize.pt : settings.bodyPt;
  const titlePt = titleSize.write ? titleSize.pt : settings.titlePt;
  const applyIndent = !hasBody;

  return {
    body: {
      font: fontWrite(user.fontName, body ?? title, settings.fontName, hasBody),
      size: bodySize,
      spacing: spacingWrite(
        user.lineSpacingChars,
        body ?? title,
        settings.lineSpacingChars,
        bodyPt,
        !hasBody && !body && !title
      ),
      applyIndent,
      indentEm: bodyPt > 0 ? bodyPt : settings.bodyPt,
    },
    title: {
      font: fontWrite(user.fontName, title ?? body, settings.fontName, hasBody),
      size: titleSize,
      spacing: spacingWrite(
        user.lineSpacingChars,
        title ?? body,
        settings.lineSpacingChars,
        titlePt,
        !hasBody && !title && !body
      ),
      applyIndent,
      indentEm: bodyPt > 0 ? bodyPt : settings.bodyPt,
    },
  };
}
