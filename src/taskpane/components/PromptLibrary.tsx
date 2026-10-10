import * as React from "react";
import {
  Button,
  Field,
  Input,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { DeleteRegular, NotepadRegular } from "@fluentui/react-icons";
import { uiPx } from "../uiFont";
import {
  SavedPrompt,
  firstLine,
  forgetSavedPrompt,
  loadSavedPrompts,
  needsReplaceConfirm,
  rememberSavedPrompt,
  saveBlockReason,
  saveWasTooLong,
  titleFromBody,
} from "../savedPrompts";

const useStyles = makeStyles({
  icon: {
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
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    width: "260px",
    maxWidth: "70vw",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    maxHeight: "40vh",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "6px",
    padding: "2px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 6px",
  },
  pick: {
    flexGrow: 1,
    minWidth: 0,
    height: "auto",
    minHeight: "unset",
    padding: "0",
    textAlign: "left",
    justifyContent: "flex-start",
    fontSize: uiPx(12),
    lineHeight: uiPx(16),
  },
  text: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    maxWidth: "100%",
  },
  title: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: uiPx(12),
    lineHeight: uiPx(16),
  },
  preview: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
    fontSize: uiPx(11),
    lineHeight: uiPx(16),
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: uiPx(12),
    padding: "8px 6px",
  },
  warning: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    fontSize: uiPx(12),
    lineHeight: uiPx(16),
  },
  actions: {
    display: "flex",
    gap: "6px",
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
});

type LibraryMode = "list" | "name" | "confirm";

export type PromptLibraryPanelProps = {
  prompts: SavedPrompt[];
  composerText: string;
  mode: LibraryMode;
  draftTitle: string;
  pending: SavedPrompt | null;
  tooLong: boolean;
  onDraftTitle: (value: string) => void;
  onStartSave: () => void;
  onCommitSave: () => void;
  onCancelName: () => void;
  onPick: (prompt: SavedPrompt) => void;
  onConfirmRecall: () => void;
  onCancelConfirm: () => void;
  onDelete: (id: string) => void;
};

function isImeEnter(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

export const PromptLibraryPanel: React.FC<PromptLibraryPanelProps> = ({
  prompts,
  composerText,
  mode,
  draftTitle,
  pending,
  tooLong,
  onDraftTitle,
  onStartSave,
  onCommitSave,
  onCancelName,
  onPick,
  onConfirmRecall,
  onCancelConfirm,
  onDelete,
}) => {
  const styles = useStyles();

  if (mode === "name") {
    return (
      <div className={styles.panel}>
        <Field size="small" label="名前">
          <Input
            size="small"
            value={draftTitle}
            autoFocus
            aria-label="名前"
            onChange={(_, data) => onDraftTitle(data.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || isImeEnter(event)) {
                return;
              }
              event.preventDefault();
              onCommitSave();
            }}
          />
        </Field>
        <div className={styles.actions}>
          <Button appearance="primary" size="small" onClick={onCommitSave}>
            保存
          </Button>
          <Button appearance="secondary" size="small" onClick={onCancelName}>
            戻る
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "confirm" && pending) {
    return (
      <div className={styles.panel}>
        <Text className={styles.title} block>
          今の文章を置き換えます
        </Text>
        <Text className={styles.preview} block>
          {pending.title}
        </Text>
        <div className={styles.actions}>
          <Button appearance="primary" size="small" onClick={onConfirmRecall}>
            呼び出す
          </Button>
          <Button appearance="secondary" size="small" onClick={onCancelConfirm}>
            戻る
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <Button
        appearance="primary"
        size="small"
        disabled={composerText.trim().length === 0}
        onClick={onStartSave}
      >
        この文章を保存
      </Button>
      {tooLong ? (
        <Text className={styles.warning} block>
          2万字を超えるので保存できません。
        </Text>
      ) : null}
      <div className={styles.list}>
        {prompts.length === 0 ? (
          <Text className={styles.empty}>保存したプロンプトはまだありません。</Text>
        ) : (
          prompts.map((prompt) => {
            const preview = firstLine(prompt.body);
            return (
              <div className={styles.row} key={prompt.id}>
                <Button
                  appearance="subtle"
                  size="small"
                  className={styles.pick}
                  onClick={() => onPick(prompt)}
                >
                  <span className={styles.text}>
                    <span className={styles.title}>{prompt.title}</span>
                    {preview && preview !== prompt.title ? (
                      <span className={styles.preview}>{preview}</span>
                    ) : null}
                  </span>
                </Button>
                <Button
                  appearance="subtle"
                  size="small"
                  className={styles.drop}
                  icon={<DeleteRegular />}
                  aria-label={`${prompt.title} を削除`}
                  onClick={() => onDelete(prompt.id)}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export type PromptLibraryProps = {
  text: string;
  disabled: boolean;
  onRecall: (body: string) => void;
};

export const PromptLibrary: React.FC<PromptLibraryProps> = ({ text, disabled, onRecall }) => {
  const styles = useStyles();
  const [open, setOpen] = React.useState(false);
  const [prompts, setPrompts] = React.useState<SavedPrompt[]>([]);
  const [mode, setMode] = React.useState<LibraryMode>("list");
  const [draftTitle, setDraftTitle] = React.useState("");
  const [pending, setPending] = React.useState<SavedPrompt | null>(null);
  const [tooLong, setTooLong] = React.useState(false);

  React.useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const showList = () => {
    setMode("list");
    setPending(null);
    setDraftTitle("");
  };

  const startSave = () => {
    const blocked = saveBlockReason(text);
    if (blocked === "empty") {
      return;
    }
    if (blocked === "tooLong") {
      setTooLong(true);
      showList();
      return;
    }
    setTooLong(false);
    setDraftTitle(titleFromBody(text));
    setMode("name");
  };

  const commitSave = () => {
    const result = rememberSavedPrompt({ title: draftTitle, body: text });
    if (!result.ok) {
      setTooLong(saveWasTooLong(result));
      showList();
      return;
    }
    setPrompts(result.prompts);
    setTooLong(false);
    showList();
  };

  const pick = (prompt: SavedPrompt) => {
    if (needsReplaceConfirm(text, prompt.body)) {
      setPending(prompt);
      setMode("confirm");
      return;
    }
    onRecall(prompt.body);
    setOpen(false);
  };

  const confirmRecall = () => {
    if (!pending) {
      return;
    }
    onRecall(pending.body);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      positioning="above-start"
      onOpenChange={(_, data) => {
        setOpen(data.open);
        if (data.open) {
          setPrompts(loadSavedPrompts());
          setTooLong(false);
          showList();
        }
      }}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          size="small"
          className={styles.icon}
          icon={<NotepadRegular />}
          aria-label="プロンプトの保存と呼出"
          title="プロンプトの保存と呼出"
          disabled={disabled}
        />
      </PopoverTrigger>
      <PopoverSurface>
        <PromptLibraryPanel
          prompts={prompts}
          composerText={text}
          mode={mode}
          draftTitle={draftTitle}
          pending={pending}
          tooLong={tooLong}
          onDraftTitle={setDraftTitle}
          onStartSave={startSave}
          onCommitSave={commitSave}
          onCancelName={showList}
          onPick={pick}
          onConfirmRecall={confirmRecall}
          onCancelConfirm={showList}
          onDelete={(id) => {
            setPrompts(forgetSavedPrompt(id));
            if (pending?.id === id) {
              showList();
            }
          }}
        />
      </PopoverSurface>
    </Popover>
  );
};
