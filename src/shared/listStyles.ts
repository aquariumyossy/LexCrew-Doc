/** How a format_list style is applied in Word. */
export type ListStyleKind = "continue" | "numbering" | "builtin";

export type BuiltinListStyleSpec = {
  numberStyle: string;
  /** Label template; `%N` stands for this level's own counter. */
  numberFormat: string;
  trailingCharacter?: "TrailingNone" | "TrailingTab" | "TrailingSpace";
};

export type ListStyleSpec = {
  id: string;
  label: string;
  example: string;
  kind: ListStyleKind;
  /** setLevelNumbering path; only when kind === "numbering". */
  numbering?: "arabic" | "paren" | "lowerLetter";
  /** ListLevel path; only when kind === "builtin". */
  builtin?: BuiltinListStyleSpec;
};

export const LIST_STYLE_SPECS: ListStyleSpec[] = [
  {
    id: "continue",
    label: "直前の番号を継ぐ",
    example: "〔2.〕",
    kind: "continue",
  },
  {
    id: "arabic",
    label: "1. 2.",
    example: "〔1.〕",
    kind: "numbering",
    numbering: "arabic",
  },
  {
    id: "paren",
    label: "(1) (2)",
    example: "〔(1)〕",
    kind: "numbering",
    numbering: "paren",
  },
  {
    id: "lowerLetter",
    label: "a. b.",
    example: "〔a.〕",
    kind: "numbering",
    numbering: "lowerLetter",
  },
  {
    id: "dai",
    label: "第１",
    example: "〔第１〕",
    kind: "builtin",
    builtin: {
      numberStyle: "ArabicFullWidth",
      numberFormat: "第%N",
      trailingCharacter: "TrailingNone",
    },
  },
  {
    id: "daiJo",
    label: "第１条",
    example: "〔第１条〕",
    kind: "builtin",
    builtin: {
      numberStyle: "ArabicFullWidth",
      numberFormat: "第%N条",
      trailingCharacter: "TrailingNone",
    },
  },
  {
    id: "arabicFull",
    label: "１　",
    example: "〔１　〕",
    kind: "builtin",
    builtin: {
      numberStyle: "ArabicFullWidth",
      numberFormat: "%N\u3000",
      trailingCharacter: "TrailingNone",
    },
  },
  {
    id: "parenFull",
    label: "（１）",
    example: "〔（１）〕",
    kind: "builtin",
    builtin: {
      numberStyle: "ArabicFullWidth",
      numberFormat: "（%N）",
      trailingCharacter: "TrailingNone",
    },
  },
  {
    id: "aiueo",
    label: "ア",
    example: "〔ア〕",
    kind: "builtin",
    builtin: {
      numberStyle: "Aiueo",
      numberFormat: "%N",
    },
  },
  {
    id: "circled",
    label: "①",
    example: "〔①〕",
    kind: "builtin",
    builtin: {
      numberStyle: "NumberInCircle",
      numberFormat: "%N",
      trailingCharacter: "TrailingNone",
    },
  },
];

export const LIST_STYLE_IDS = LIST_STYLE_SPECS.map((spec) => spec.id);

export type ListStyle = (typeof LIST_STYLE_IDS)[number];

export function isListStyle(value: unknown): value is ListStyle {
  return typeof value === "string" && (LIST_STYLE_IDS as string[]).includes(value);
}

export function listStyleSpec(style: ListStyle): ListStyleSpec {
  const spec = LIST_STYLE_SPECS.find((row) => row.id === style);
  if (!spec) {
    throw new Error(`Unknown list style: ${style}`);
  }
  return spec;
}

export function isBuiltinListStyle(style: ListStyle): boolean {
  return listStyleSpec(style).kind === "builtin";
}

/**
 * Word writes the counter of list level `n` as `%n+1`, so a label meant for its
 * own level has to name that level: `%1` at level 0, `%3` at level 2. A
 * mismatched placeholder points at a level with no items and prints nothing.
 */
export function listLevelNumberFormat(builtin: BuiltinListStyleSpec, level: number): string {
  return builtin.numberFormat.replace("%N", `%${level + 1}`);
}

/** Comma-separated style names for tool errors and descriptions. */
export function listStyleNamesForPrompt(): string {
  return LIST_STYLE_SPECS.filter((spec) => spec.id !== "continue")
    .map((spec) => spec.id)
    .join(" / ");
}

/** Styles that can turn a bullet into a numbered list. */
export function listStyleNamesForApply(): string {
  return LIST_STYLE_SPECS.filter((spec) => spec.kind !== "continue")
    .map((spec) => spec.id)
    .join(" / ");
}

export function listStyleToolDescription(): string {
  const rows = LIST_STYLE_SPECS.filter((spec) => spec.kind !== "continue").map(
    (spec) => `${spec.id} は ${spec.label}`
  );
  return (
    rows.join("、") +
    "。circled は ①〜⑳ まで。号が多いときは arabicFull や parenFull を使う。" +
    "paren は半角 (1)、parenFull は全角 （１）。" +
    "dai は 第１、daiJo は 第１条（自動番号）。条見出しの本文は insert_blocks の clause。"
  );
}

export function listStyleEnum(): string[] {
  return [...LIST_STYLE_IDS];
}
