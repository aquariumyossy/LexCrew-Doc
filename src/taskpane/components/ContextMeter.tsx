import * as React from "react";
import { Text, makeStyles, tokens } from "@fluentui/react-components";

const WARN_RATIO = 0.8;

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "0",
    minWidth: 0,
    flexShrink: 1,
    lineHeight: "16px",
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  warn: {
    color: tokens.colorPaletteRedForeground1,
  },
});

function jp(n: number): string {
  return n.toLocaleString("ja-JP");
}

export type ContextMeterProps = {
  /** Rough size of this conversation plus the draft being typed. */
  tokens: number;
  limit: number;
};

const ContextMeter: React.FC<ContextMeterProps> = ({ tokens, limit }) => {
  const styles = useStyles();
  const warn = limit > 0 && tokens / limit >= WARN_RATIO;

  return (
    <div className={styles.root} data-guri="context-meter">
      <Text
        size={200}
        className={warn ? styles.warn : styles.muted}
        title="この会話を送るときの目安です。上限を超えると古いやり取りから落ちます。"
      >
        {jp(tokens)} / {jp(limit)}
      </Text>
      {warn ? (
        <Text size={200} className={styles.warn}>
          上限に近いので、新しい会話に切り替えてください。
        </Text>
      ) : null}
    </div>
  );
};

export default ContextMeter;
