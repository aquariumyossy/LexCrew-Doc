import * as React from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { CheckmarkRegular } from "@fluentui/react-icons";
import {
  ArgosScopeRow,
  argosButtonLabel,
  argosFolderListLabel,
  argosScopeChipLabel,
  collapseArgosScopes,
  matchesArgosFilter,
  parseArgosScopes,
  sameArgosPath,
} from "../../shared/argos";
import { listArgosScopes } from "../api";
import { CompactDialogClose, useCompactDialogStyles } from "./compactDialog";

const useStyles = makeStyles({
  trigger: {
    maxWidth: "170px",
    minWidth: 0,
  },
  triggerLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    minHeight: "140px",
    maxHeight: "360px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "6px",
    padding: "2px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    margin: 0,
    border: "none",
    borderRadius: "4px",
    backgroundColor: "transparent",
    padding: "4px 6px",
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "12px",
    lineHeight: "16px",
    color: tokens.colorNeutralForeground1,
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  rowActive: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  nested: {
    paddingLeft: "22px",
  },
  check: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
  },
  badge: {
    flexShrink: 0,
    fontSize: "10px",
    lineHeight: "16px",
    padding: "0 6px",
    borderRadius: "999px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  label: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "6px",
  },
  footerLabel: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
  },
  muted: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    padding: "8px 6px",
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: "12px",
    whiteSpace: "pre-wrap",
  },
});

export type ArgosScopePickerProps = {
  argosBaseUrl: string;
  argosApiKey: string;
  pathPrefix: string;
  disabled?: boolean;
  onChange: (paths: string[]) => void;
};

function isSelected(path: string, selected: string[]): boolean {
  return selected.some((item) => sameArgosPath(item, path));
}

function footerLabel(selected: string[], rows: ArgosScopeRow[]): string {
  if (!selected.length) {
    return "索引全体";
  }
  const first = rows.find((row) => sameArgosPath(row.path, selected[0]));
  const name = first
    ? first.label || argosScopeChipLabel(first.path)
    : argosScopeChipLabel(selected[0]);
  if (selected.length === 1) {
    return name;
  }
  return `${name} ほか${selected.length - 1}件`;
}

const ScopeRow: React.FC<{
  badge?: string;
  label: string;
  nested?: boolean;
  active: boolean;
  onClick: () => void;
}> = ({ badge, label, nested, active, onClick }) => {
  const styles = useStyles();
  return (
    <button
      type="button"
      className={`${styles.row} ${active ? styles.rowActive : ""} ${nested ? styles.nested : ""}`}
      onClick={onClick}
    >
      <span className={styles.check}>{active ? <CheckmarkRegular fontSize={14} /> : null}</span>
      {badge ? <span className={styles.badge}>{badge}</span> : null}
      <span className={styles.label} title={label}>
        {label}
      </span>
    </button>
  );
};

const ArgosScopePicker: React.FC<ArgosScopePickerProps> = ({
  argosBaseUrl,
  argosApiKey,
  pathPrefix,
  disabled,
  onChange,
}) => {
  const styles = useStyles();
  const dialog = useCompactDialogStyles();
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [draft, setDraft] = React.useState<string[]>([]);
  const [recent, setRecent] = React.useState<ArgosScopeRow[]>([]);
  const [scopes, setScopes] = React.useState<ArgosScopeRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const roots = React.useMemo(() => scopes.filter((row) => row.isRoot), [scopes]);
  const allRows = React.useMemo(() => [...recent, ...scopes], [recent, scopes]);

  const visibleRecent = React.useMemo(
    () => recent.filter((row) => matchesArgosFilter(row, filter, row.label)),
    [recent, filter]
  );
  const visibleScopes = React.useMemo(
    () => scopes.filter((row) => matchesArgosFilter(row, filter, argosFolderListLabel(row, roots))),
    [scopes, filter, roots]
  );

  React.useEffect(() => {
    if (!open) {
      return undefined;
    }
    const ac = new AbortController();
    setLoading(true);
    setError("");
    setFilter("");
    setDraft(parseArgosScopes(pathPrefix));
    void listArgosScopes({ argosBaseUrl, argosApiKey }, ac.signal)
      .then((result) => {
        setRecent(result.recent);
        setScopes(result.scopes);
      })
      .catch((caught: unknown) => {
        if (ac.signal.aborted) {
          return;
        }
        const hint = (caught as { hint?: string }).hint;
        const message =
          caught instanceof Error ? caught.message : "Argos の範囲を取得できませんでした。";
        setError(hint ? `${message}\n${hint}` : message);
        setRecent([]);
        setScopes([]);
      })
      .finally(() => {
        if (!ac.signal.aborted) {
          setLoading(false);
        }
      });
    return () => ac.abort();
  }, [open, argosBaseUrl, argosApiKey, pathPrefix]);

  const close = () => setOpen(false);

  const apply = () => {
    onChange(draft);
    close();
  };

  const toggle = (path: string) => {
    if (isSelected(path, draft)) {
      setDraft(draft.filter((item) => !sameArgosPath(item, path)));
      return;
    }
    setDraft(collapseArgosScopes([...draft, path]));
  };

  return (
    <>
      <Button
        appearance="subtle"
        size="small"
        className={styles.trigger}
        disabled={disabled}
        aria-label="Argos の検索範囲"
        onClick={() => setOpen(true)}
      >
        <span className={styles.triggerLabel}>{argosButtonLabel(pathPrefix)}</span>
      </Button>
      <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
        <DialogSurface className={dialog.surface} aria-label="検索範囲" data-guri="argos-scope">
          <DialogBody className={dialog.body}>
            <DialogTitle className={dialog.heading} action={<CompactDialogClose onClick={close} />}>
              GURI に参照させるフォルダを選択してください。
            </DialogTitle>
            <DialogContent className={dialog.content}>
              <Input
                size="small"
                value={filter}
                onChange={(_, data) => setFilter(data.value)}
                placeholder="フォルダ名で絞り込み…"
                aria-label="フォルダ名で絞り込み"
              />
              {error ? <Text className={styles.error}>{error}</Text> : null}
              <div className={styles.list}>
                {loading ? <Spinner size="tiny" label="読み込み中…" /> : null}
                <ScopeRow
                  badge="全体"
                  label="索引全体"
                  active={draft.length === 0}
                  onClick={() => setDraft([])}
                />
                {visibleRecent.map((row) => (
                  <ScopeRow
                    key={`recent:${row.path}`}
                    badge="直近"
                    label={row.label || argosScopeChipLabel(row.path)}
                    active={isSelected(row.path, draft)}
                    onClick={() => toggle(row.path)}
                  />
                ))}
                {visibleScopes.map((row) => (
                  <ScopeRow
                    key={`scope:${row.path}`}
                    badge={row.isRoot ? "ルート" : undefined}
                    label={argosFolderListLabel(row, roots)}
                    nested={!row.isRoot}
                    active={isSelected(row.path, draft)}
                    onClick={() => toggle(row.path)}
                  />
                ))}
                {!loading && !error && !visibleRecent.length && !visibleScopes.length ? (
                  <Text className={styles.muted}>
                    {filter.trim()
                      ? "一致するフォルダがありません。"
                      : "表示できるフォルダがありません。"}
                  </Text>
                ) : null}
              </div>
              <div className={styles.footer}>
                <span className={styles.footerLabel}>{footerLabel(draft, allRows)}</span>
                <Button appearance="primary" size="small" onClick={apply}>
                  適用
                </Button>
              </div>
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
};

export default ArgosScopePicker;
