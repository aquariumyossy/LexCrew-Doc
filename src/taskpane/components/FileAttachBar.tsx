import * as React from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AttachRegular, DismissRegular } from "@fluentui/react-icons";
import { ChangeNote, CommentNote, MarkupList } from "../../shared/attachment";
import { ACCEPTED_EXTENSIONS } from "../../shared/fileExtract";
import {
  CommittedFile,
  FileSource,
  FileText,
  fileTextChars,
  filesChars,
  isReady,
} from "../../shared/fileSource";
import { uiPx } from "../uiFont";
import { CompactDialogClose, useCompactDialogStyles } from "./compactDialog";

const useStyles = makeStyles({
  badges: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    alignItems: "center",
  },
  badge: {
    cursor: "pointer",
    maxWidth: "100%",
    "& .fui-Badge__content": {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxWidth: "260px",
    maxHeight: "40vh",
    overflowY: "auto",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  name: {
    flexGrow: 1,
    minWidth: 0,
    justifyContent: "flex-start",
    textAlign: "left",
    fontSize: uiPx(12),
    "& .fui-Button__icon": {
      display: "none",
    },
  },
  drop: {
    minWidth: "20px",
    maxWidth: "20px",
    height: "20px",
    "& svg": {
      width: "12px",
      height: "12px",
    },
  },
  clip: {
    minWidth: "24px",
    maxWidth: "24px",
    width: "24px",
    height: "24px",
    padding: 0,
    "& svg": {
      width: "16px",
      height: "16px",
    },
  },
  hidden: {
    display: "none",
  },
  preview: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: uiPx(12),
    lineHeight: uiPx(17),
  },
  section: {
    color: tokens.colorNeutralForeground2,
    fontSize: uiPx(11),
  },
  muted: {
    color: tokens.colorNeutralForeground3,
    fontSize: uiPx(11),
    lineHeight: uiPx(16),
  },
  warning: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    fontSize: uiPx(11),
    lineHeight: uiPx(16),
  },
});

/** What the preview shows: a pending read and a kept file look the same here. */
type Previewable = FileText & { name: string };

function jp(n: number): string {
  return n.toLocaleString("ja-JP");
}

/** The one line a badge or a list row shows for a file still being read. */
export function pendingLabel(source: FileSource): string {
  switch (source.status) {
    case "extracting":
      return "読み取り中";
    case "ocr":
      return `OCR処理中（${source.done + 1}/${source.total}ページ）`;
    case "error":
      return source.message;
    default:
      return `${jp(fileTextChars(source))} 字`;
  }
}

function MarkupSection<T>({
  label,
  list,
  render,
}: {
  label: string;
  list: MarkupList<T>;
  render: (item: T, index: number) => string;
}): React.ReactElement | null {
  const styles = useStyles();
  if (list.error) {
    return (
      <Text className={styles.warning} block>
        {label}を読めませんでした（{list.error}）。無いとは限りません。
      </Text>
    );
  }
  if (!list.items.length) {
    return null;
  }
  return (
    <div>
      <Text className={styles.section} block>
        {label} {jp(list.items.length)} 件{list.truncated ? "（途中まで）" : ""}
      </Text>
      <Text className={styles.preview} block>
        {list.items.map((item, index) => render(item, index + 1)).join("\n")}
      </Text>
    </div>
  );
}

const FilePreview: React.FC<{ file: Previewable | null; onClose: () => void }> = ({
  file,
  onClose,
}) => {
  const styles = useStyles();
  const dialog = useCompactDialogStyles();
  return (
    <Dialog open={Boolean(file)} onOpenChange={(_, data) => (data.open ? undefined : onClose())}>
      <DialogSurface className={dialog.surface} aria-label="添付ファイルの中身">
        <DialogBody className={dialog.body}>
          <DialogTitle className={dialog.heading} action={<CompactDialogClose onClick={onClose} />}>
            {file?.name}
          </DialogTitle>
          <DialogContent className={dialog.scrollContent}>
            {file ? (
              <div className={dialog.stack}>
                <Text className={styles.muted} block>
                  {file.origin === "ocr" ? "画像から読み取り" : "テキストを読み取り"}・
                  {jp(fileTextChars(file))} 字{file.truncated ? "・長いので途中まで渡します" : ""}
                </Text>
                <Text className={styles.preview} block>
                  {file.body || "本文は読み取れませんでした。"}
                </Text>
                <MarkupSection
                  label="コメント"
                  list={file.comments}
                  render={(note: CommentNote, index) =>
                    `[${index}] ${note.author} ${note.date}${note.anchor ? ` 対象「${note.anchor}」` : ""}\n${note.content}`
                  }
                />
                <MarkupSection
                  label="変更履歴"
                  list={file.changes}
                  render={(note: ChangeNote, index) =>
                    `[${index}] ${note.author} ${note.date}「${note.text}」${note.where ? ` 場所「${note.where}」` : ""}`
                  }
                />
              </div>
            ) : null}
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};

type ListRow = {
  id: string;
  name: string;
  detail: string;
  failed: boolean;
  /** Absent while the file is still being read. */
  preview: Previewable | null;
};

const FileList: React.FC<{
  rows: ListRow[];
  disabled: boolean;
  onPreview: (file: Previewable) => void;
  onRemove: (id: string) => void;
}> = ({ rows, disabled, onPreview, onRemove }) => {
  const styles = useStyles();
  return (
    <div className={styles.list}>
      {rows.map((row) => (
        <div className={styles.row} key={row.id}>
          <Button
            appearance="subtle"
            size="small"
            className={styles.name}
            disabled={!row.preview}
            onClick={() => row.preview && onPreview(row.preview)}
          >
            {row.name}
          </Button>
          <Text className={row.failed ? styles.warning : styles.muted}>{row.detail}</Text>
          <Button
            appearance="subtle"
            size="small"
            className={styles.drop}
            icon={<DismissRegular />}
            aria-label={`${row.name} を外す`}
            disabled={disabled}
            onClick={() => onRemove(row.id)}
          />
        </div>
      ))}
    </div>
  );
};

const BadgeWithList: React.FC<{
  label: string;
  color: "informative" | "brand" | "danger";
  rows: ListRow[];
  disabled: boolean;
  onPreview: (file: Previewable) => void;
  onRemove: (id: string) => void;
}> = ({ label, color, rows, disabled, onPreview, onRemove }) => {
  const styles = useStyles();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={(_, data) => setOpen(data.open)} withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <Badge
          appearance="tint"
          color={color}
          className={styles.badge}
          role="button"
          tabIndex={0}
          onKeyDown={(event: React.KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              setOpen(true);
            }
          }}
        >
          {label}
        </Badge>
      </PopoverTrigger>
      <PopoverSurface>
        <FileList
          rows={rows}
          disabled={disabled}
          onPreview={(file) => {
            setOpen(false);
            onPreview(file);
          }}
          onRemove={onRemove}
        />
      </PopoverSurface>
    </Popover>
  );
};

export type FileBadgesProps = {
  /** Picked but not yet sent. */
  pending: FileSource[];
  /** Already read and kept by this conversation. */
  attached: CommittedFile[];
  /** Removing is refused while a turn is running. */
  disabled: boolean;
  onRemovePending: (id: string) => void;
  onRemoveAttached: (id: string) => void;
};

/**
 * The row above the input. The two kinds are deliberately told apart: a pending
 * badge disappears when it is sent, while a kept file keeps shaping every
 * answer until it is taken away, and an invisible one of those would bend a
 * reply without anyone noticing.
 */
export const FileBadges: React.FC<FileBadgesProps> = ({
  pending,
  attached,
  disabled,
  onRemovePending,
  onRemoveAttached,
}) => {
  const styles = useStyles();
  const [preview, setPreview] = React.useState<Previewable | null>(null);

  const pendingRows: ListRow[] = pending.map((source) => ({
    id: source.id,
    name: source.name,
    detail: pendingLabel(source),
    failed: source.status === "error",
    preview: isReady(source) ? { ...source, name: source.name } : null,
  }));
  const attachedRows: ListRow[] = attached.map((file) => ({
    id: file.id,
    name: file.name,
    detail: `${jp(fileTextChars(file))} 字`,
    failed: false,
    preview: file,
  }));

  const failed = pending.filter((source) => source.status === "error").length;
  const reading = pending.find(
    (source) => source.status === "ocr" || source.status === "extracting"
  );
  const pendingLabelText = () => {
    if (pending.length === 1) {
      const only = pending[0];
      return `${only.name}（${pendingLabel(only)}）`;
    }
    const note = reading ? `・${pendingLabel(reading)}` : failed ? `・${jp(failed)} 件失敗` : "";
    return `添付ファイル ${jp(pending.length)} 件${note}`;
  };

  if (!pending.length && !attached.length) {
    return null;
  }

  return (
    <div className={styles.badges}>
      {pending.length ? (
        <>
          {reading ? <Spinner size="extra-tiny" /> : null}
          <BadgeWithList
            label={pendingLabelText()}
            color={failed && !reading ? "danger" : "brand"}
            rows={pendingRows}
            disabled={false}
            onPreview={setPreview}
            onRemove={onRemovePending}
          />
        </>
      ) : null}
      {attached.length ? (
        <BadgeWithList
          label={`この会話の資料 ${jp(attached.length)} 件 ${jp(filesChars(attached))} 字`}
          color="informative"
          rows={attachedRows}
          disabled={disabled}
          onPreview={setPreview}
          onRemove={onRemoveAttached}
        />
      ) : null}
      <FilePreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );
};

export type FileAttachButtonProps = {
  disabled: boolean;
  onPick: (files: File[]) => void;
};

/** The clip, between the Argos scope and send. */
export const FileAttachButton: React.FC<FileAttachButtonProps> = ({ disabled, onPick }) => {
  const styles = useStyles();
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className={styles.hidden}
        accept={ACCEPTED_EXTENSIONS.join(",")}
        onChange={(event) => {
          onPick(Array.from(event.target.files || []));
          // Cleared so picking the same file again fires another change.
          event.target.value = "";
        }}
      />
      <Button
        appearance="subtle"
        size="small"
        className={styles.clip}
        icon={<AttachRegular />}
        aria-label="ファイルを添付"
        disabled={disabled}
        onClick={() => input.current?.click()}
      />
    </>
  );
};
