import * as React from "react";
import { Checkbox, Field, Input, Text, makeStyles, tokens } from "@fluentui/react-components";
import { OutlineLayout, OutlineLevelFormat } from "../../shared/blocks";

const LEVEL_LABELS = ["第１", "１．", "（１）", "①・など", "本文"];

type CharsKey = "indentChars" | "hangingChars" | "firstLineChars";

const COLUMNS: { key: CharsKey; label: string }[] = [
  { key: "indentChars", label: "インデント" },
  { key: "hangingChars", label: "ぶら下げ" },
  { key: "firstLineChars", label: "字下げ" },
];

const useStyles = makeStyles({
  grid: {
    display: "grid",
    gridTemplateColumns: "auto auto repeat(3, minmax(0, 1fr))",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
  },
  number: {
    minWidth: 0,
    width: "100%",
  },
});

type Props = {
  layout: OutlineLayout;
  onChange: (layout: OutlineLayout) => void;
};

const OutlineLayoutField: React.FC<Props> = ({ layout, onChange }) => {
  const styles = useStyles();
  const update = (index: number, partial: Partial<OutlineLevelFormat>) =>
    onChange(layout.map((row, at) => (at === index ? { ...row, ...partial } : row)));

  return (
    <Field
      size="small"
      label="階層レイアウト（字）"
      hint="「第１」「１．」「（１）」のような番号付きの階層で本文を書かせたときに当てます。ぶら下げを入れた段は字下げを使いません。"
    >
      <div className={styles.grid}>
        <span />
        <Text size={200}>太字</Text>
        {COLUMNS.map((column) => (
          <Text key={column.key} size={200}>
            {column.label}
          </Text>
        ))}
        {layout.map((row, index) => (
          <React.Fragment key={LEVEL_LABELS[index]}>
            <Text size={200}>{LEVEL_LABELS[index]}</Text>
            <Checkbox
              checked={row.bold}
              aria-label={`${LEVEL_LABELS[index]} 太字`}
              onChange={(_, data) => update(index, { bold: data.checked === true })}
            />
            {COLUMNS.map((column) => (
              <Input
                key={column.key}
                className={styles.number}
                size="small"
                type="number"
                min={0}
                max={20}
                step={0.5}
                aria-label={`${LEVEL_LABELS[index]} ${column.label}`}
                value={String(row[column.key])}
                onChange={(_, data) => {
                  const n = Number(data.value);
                  if (Number.isFinite(n) && n >= 0 && n <= 20) {
                    update(index, { [column.key]: n });
                  }
                }}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
    </Field>
  );
};

export default OutlineLayoutField;
