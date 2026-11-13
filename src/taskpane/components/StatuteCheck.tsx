import * as React from "react";
import { Button, Spinner, Text, makeStyles, tokens } from "@fluentui/react-components";
import { checkStatutes } from "../api";
import {
  StatuteHit,
  checkRequest,
  emptyCheckMessage,
  jumpTarget,
  rowLabel,
} from "../statuteCheck";
import { getSelectionText, readBodyText, selectTextOccurrence } from "../word";

const useStyles = makeStyles({
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "180px",
    overflowY: "auto",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    padding: "4px",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  line: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  jump: {
    flex: 1,
    minWidth: 0,
    justifyContent: "flex-start",
    textAlign: "left",
  },
  detail: {
    padding: "2px 8px 6px",
    whiteSpace: "pre-wrap",
    color: tokens.colorNeutralForeground2,
  },
  match: { color: tokens.colorPaletteGreenForeground1 },
  number: { color: tokens.colorPaletteDarkOrangeForeground1 },
  review: { color: tokens.colorPaletteRedForeground1 },
});

type Props = {
  disabled: boolean;
  inWord: boolean;
  online: boolean;
};

export const StatuteCheck: React.FC<Props> = ({ disabled, inWord, online }) => {
  const styles = useStyles();
  const [running, setRunning] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [rows, setRows] = React.useState<StatuteHit[]>([]);
  const [open, setOpen] = React.useState<number | null>(null);
  const [scope, setScope] = React.useState<"selection" | "document">("document");
  const abortRef = React.useRef<AbortController | null>(null);

  const run = async () => {
    if (!inWord) {
      setNote("Word の文書を開いているときに使えます。");
      setRows([]);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setNote("");
    setOpen(null);
    try {
      const selection = await getSelectionText();
      const documentText = selection.trim() ? "" : await readBodyText();
      const request = checkRequest(selection, documentText, online);
      setScope(request.scope);
      if (!request.text.trim()) {
        setRows([]);
        setNote(emptyCheckMessage(request.scope));
        return;
      }
      const results = await checkStatutes(request.text, request.online, controller.signal);
      setRows(results);
      setNote(results.length === 0 ? emptyCheckMessage(request.scope) : "");
    } catch (error) {
      if (controller.signal.aborted) {
        setNote("照合を中止しました。");
        return;
      }
      setRows([]);
      setNote(error instanceof Error ? error.message : "条文照合に失敗しました。");
    } finally {
      setRunning(false);
    }
  };

  const jump = async (row: StatuteHit) => {
    const target = jumpTarget(row);
    try {
      const found = await selectTextOccurrence(target.anchor, target.occurrence, scope);
      if (!found) {
        setNote("文書の中でその引用を選べませんでした。");
      }
    } catch {
      setNote("文書の中でその引用を選べませんでした。");
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.line}>
        <Button appearance="secondary" size="small" disabled={disabled || running} onClick={() => void run()}>
          条文照合
        </Button>
        {running ? (
          <Button
            appearance="subtle"
            size="small"
            onClick={() => abortRef.current?.abort()}
          >
            中止
          </Button>
        ) : null}
        {running ? <Spinner size="tiny" label="照合しています…" /> : null}
      </div>
      {note ? (
        <Text size={200} className={styles.review}>
          {note}
        </Text>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.list}>
          {rows.map((row, index) => {
            const tone = row.status === "match" ? styles.match : row.status === "number" ? styles.number : styles.review;
            return (
              <div key={`${row.anchor}-${row.occurrence}-${index}`} className={styles.row}>
                <div className={styles.line}>
                  <Button
                    appearance="transparent"
                    size="small"
                    className={styles.jump}
                    onClick={() => void jump(row)}
                  >
                    <span className={tone}>{rowLabel(row)}</span>
                  </Button>
                  <Button
                    appearance="subtle"
                    size="small"
                    onClick={() => setOpen(open === index ? null : index)}
                  >
                    {open === index ? "閉じる" : "本文"}
                  </Button>
                </div>
                {open === index ? (
                  <Text size={200} className={styles.detail}>
                    {[
                      row.reason,
                      row.diff,
                      row.offlineNote,
                      row.articleText,
                      row.asOf ? `時点: ${row.asOf}` : "",
                      row.source ? `出典: ${row.source}` : "",
                    ]
                      .filter(Boolean)
                      .join("\n")}
                  </Text>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
