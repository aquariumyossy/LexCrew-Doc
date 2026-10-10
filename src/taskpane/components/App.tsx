import * as React from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Radio,
  RadioGroup,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  DismissRegular,
  HistoryRegular,
  InfoRegular,
  PlugConnectedRegular,
  SendRegular,
  SettingsRegular,
} from "@fluentui/react-icons";
import {
  Attachment,
  AttachmentScope,
  EMPTY_ATTACHMENT,
  attachmentCharBudget,
  describeAttachment,
  markupCharBudget,
} from "../../shared/attachment";
import {
  CHARS_PER_TOKEN,
  DOCUMENT_KEY_SETTING,
  LINE_SPACING_CHARS,
  MAX_TIMEOUT_MS,
  normalizeLineSpacingChars,
} from "../../shared/constants";
import {
  CommittedFile,
  clampFiles,
  commit,
  fileCharBudget,
  filesChars,
  isPendingRead,
  isReady,
  mergeFiles,
} from "../../shared/fileSource";
import { assertChatInput } from "../../shared/guards";
import { REMOTE_OCR_NOTICE, isLoopbackUrl } from "../../shared/ocr";
import { ConversationSummary, NewMessage, StoredMessage } from "../../shared/history";
import { joinArgosScopes, parseArgosScopes } from "../../shared/argos";
import { systemPrompt } from "../../shared/prompts";
import {
  FORMAT_THINKING_LEVELS,
  FORMAT_THINKING_LABELS,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  ThinkingLevel,
  normalizeFormatThinkingLevel,
} from "../../shared/thinking";
import {
  TOOL_ROUND_PRESETS,
  normalizeMaxToolRounds,
  toolRoundPresetLabel,
} from "../../shared/tools";
import {
  adoptStoredConnection,
  appendMessage,
  checkHealth,
  createConversation,
  deleteConversation,
  fetchConnection,
  getConversation,
  listConversations,
  pingSidecar,
  rememberDocumentPath,
  setConversationArgosScope,
  saveStoredConnection,
  setConversationFiles as saveConversationFiles,
} from "../api";
import { estimateTokens, messagesTokens, toChatMessages } from "../chat/context";
import { runTurn } from "../chat/runTurn";
import { applyAdopt } from "../connectionState";
import { FONT_CHOICES, Settings, clampTimeoutMs, loadSettings, saveSettings, setKeepConnectionInStorage } from "../settings";
import { UiFontSize, applyUiFont, normalizeUiFontSize, readUiFontScale, uiPx } from "../uiFont";
import {
  DocumentStats,
  assertDocumentReady,
  clearDraftAnchor,
  getDocumentKey,
  getDocumentPath,
  getDocumentStats,
  getSelectionText,
  isWordHost,
  readAttachment,
} from "../word";
import { OcrRunner, useFileSources } from "../files/useFileSources";
import { ocrFile } from "../files/ocr";
import { aboutCopy } from "../about";
import ChatPane, { ChatDraft } from "./ChatPane";
import { AboutDialog } from "./AboutDialog";
import ArgosScopePicker from "./ArgosScopePicker";
import { FileAttachButton, FileBadges } from "./FileAttachBar";
import ContextMeter from "./ContextMeter";
import HistoryDialog from "./HistoryDialog";
import OutlineLayoutField from "./OutlineLayoutField";
import { CompactDialogClose, useCompactDialogStyles } from "./compactDialog";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    boxSizing: "border-box",
    padding: "12px",
    gap: "10px",
    backgroundColor: tokens.colorNeutralBackground1,
    fontFamily: '"Yu Gothic UI","Meiryo",sans-serif',
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "4px",
    minHeight: "24px",
    paddingBottom: "2px",
    borderBottom: `1px solid ${tokens.colorBrandStroke2}`,
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: "0",
    flexShrink: 0,
  },
  headerButton: {
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
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    alignItems: "center",
  },
  composer: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    paddingTop: "8px",
    borderTop: `1px solid ${tokens.colorBrandStroke2}`,
  },
  attachRow: {
    display: "flex",
    justifyContent: "flex-start",
  },
  attachChoices: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxWidth: "280px",
  },
  warning: {
    color: tokens.colorPaletteDarkOrangeForeground1,
  },
  composerBox: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "8px 8px 6px",
    border: `1px solid ${tokens.colorBrandStroke2}`,
    borderRadius: "10px",
    backgroundColor: tokens.colorNeutralCardBackground,
    "&:focus-within": {
      border: `1px solid ${tokens.colorBrandStroke1}`,
    },
  },
  dropping: {
    border: `1px dashed ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  composerInput: {
    boxSizing: "border-box",
    width: "100%",
    border: "none",
    outline: "none",
    resize: "none",
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: uiPx(14),
    lineHeight: uiPx(21),
    color: tokens.colorNeutralForeground1,
    padding: "2px 4px",
    minHeight: uiPx(21),
    maxHeight: uiPx(168),
    overflowY: "hidden",
    "&::placeholder": {
      color: tokens.colorNeutralForeground4,
    },
    "&:disabled": {
      color: tokens.colorNeutralForegroundDisabled,
    },
  },
  composerToolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "6px",
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  banner: {
    fontSize: uiPx(12),
    lineHeight: uiPx(16),
    "& .fui-MessageBarBody": {
      fontSize: uiPx(12),
      lineHeight: uiPx(16),
    },
  },
  bannerText: {
    fontSize: uiPx(12),
    lineHeight: uiPx(16),
    whiteSpace: "pre-wrap",
  },
  bannerDismiss: {
    minWidth: "20px",
    maxWidth: "20px",
    height: "20px",
    fontSize: "12px",
    "& svg": {
      width: "12px",
      height: "12px",
    },
  },
});

type Banner = { intent: "info" | "success" | "warning" | "error"; text: string };

type HeaderPanel = "connection" | "settings" | "about" | null;

const COMPOSER_LINE_PX = 21;
const COMPOSER_MAX_LINES = 8;

const UI_FONT_CHOICES: { value: UiFontSize; label: string }[] = [
  { value: "small", label: "小" },
  { value: "medium", label: "標準" },
  { value: "large", label: "大" },
];

function fitComposer(el: HTMLTextAreaElement | null): void {
  if (!el) {
    return;
  }
  const line = COMPOSER_LINE_PX * readUiFontScale();
  const max = line * COMPOSER_MAX_LINES;
  el.style.height = "auto";
  const next = Math.min(el.scrollHeight, max);
  el.style.height = `${Math.max(line, next)}px`;
  el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

const StatusBanner: React.FC<{ banner: Banner; onDismiss: () => void }> = ({
  banner,
  onDismiss,
}) => {
  const styles = useStyles();
  return (
    <MessageBar intent={banner.intent} className={styles.banner}>
      <MessageBarBody>
        <span className={styles.bannerText}>{banner.text}</span>
      </MessageBarBody>
      <MessageBarActions
        containerAction={
          <Button
            appearance="transparent"
            size="small"
            className={styles.bannerDismiss}
            icon={<DismissRegular />}
            aria-label="閉じる"
            onClick={onDismiss}
          />
        }
      />
    </MessageBar>
  );
};

function hintSuffix(hint?: string): string {
  return hint ? `\n${hint}` : "";
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

const App: React.FC = () => {
  const styles = useStyles();
  const dialog = useCompactDialogStyles();
  const [settings, setSettings] = React.useState<Settings>(() => loadSettings());
  const [models, setModels] = React.useState<string[]>([]);
  const [banner, setBanner] = React.useState<Banner | null>(null);
  const [inWord, setInWord] = React.useState(false);
  const [panel, setPanel] = React.useState<HeaderPanel>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);

  const [documentKey, setDocumentKey] = React.useState("");
  const [documentPath, setDocumentPath] = React.useState("");
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<StoredMessage[]>([]);
  const [argosPathPrefix, setArgosPathPrefix] = React.useState("");

  const [input, setInput] = React.useState("");
  /** Read once and kept by the conversation; rides along on every turn. */
  const [attachedFiles, setAttachedFiles] = React.useState<CommittedFile[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [draft, setDraft] = React.useState<ChatDraft | null>(null);
  const [selectionChars, setSelectionChars] = React.useState(0);
  const [stats, setStats] = React.useState<DocumentStats>({
    chars: 0,
    attachChars: 0,
    comments: 0,
    changes: 0,
    changesAvailable: true,
  });
  const [scope, setScope] = React.useState<AttachmentScope>("document");
  const [markup, setMarkup] = React.useState(true);
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [busyLabel, setBusyLabel] = React.useState("");
  const abortRef = React.useRef<AbortController | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  const settingsIncomplete = !settings.llmBaseUrl.trim() || !settings.llmApiKey.trim();

  const systemTokens = React.useMemo(
    () =>
      estimateTokens(
        systemPrompt({
          fontName: settings.fontName,
          bodyPt: settings.bodyPt,
          titlePt: settings.titlePt,
          lineSpacingChars: settings.lineSpacingChars,
          search: Boolean(settings.searxngUrl.trim()),
          argos: Boolean(settings.argosBaseUrl.trim()),
          argosPathPrefix,
          selection: selectionChars > 0,
          markup: markup && scope !== "none",
        })
      ),
    [
      settings.fontName,
      settings.bodyPt,
      settings.titlePt,
      settings.lineSpacingChars,
      settings.searxngUrl,
      settings.argosBaseUrl,
      argosPathPrefix,
      selectionChars,
      markup,
      scope,
    ]
  );

  const runOcr = React.useCallback<OcrRunner>(
    (file, pages, onProgress, signal) => {
      // Said as the read starts, not when the file is picked: a PDF with a text
      // layer never leaves the machine, and a warning about it would be a lie.
      if (!isLoopbackUrl(settings.llmBaseUrl)) {
        setBanner({ intent: "info", text: REMOTE_OCR_NOTICE });
      }
      return ocrFile(
        file,
        pages,
        {
          llmBaseUrl: settings.llmBaseUrl,
          llmApiKey: settings.llmApiKey,
          model: settings.llmModel,
          timeoutMs: settings.timeoutMs,
        },
        onProgress,
        signal
      );
    },
    [settings.llmBaseUrl, settings.llmApiKey, settings.llmModel, settings.timeoutMs]
  );

  const {
    sources: pendingFiles,
    add: addFiles,
    remove: removePendingFile,
    clear: clearPendingFiles,
    consume: consumePendingFiles,
  } = useFileSources({
    attached: attachedFiles,
    onReject: (text) => setBanner({ intent: "warning", text }),
    ocr: runOcr,
  });

  const attachBudget = attachmentCharBudget(settings.contextLimit);
  const attachedFocusChars = scope === "none" ? 0 : Math.min(selectionChars, attachBudget);
  const withMarkup = markup && scope !== "none";
  // Only a document that has markup gives up body characters for it. The slice is
  // an upper bound: whatever the read leaves over goes back to the body.
  const markupChars =
    withMarkup && stats.comments + stats.changes > 0
      ? markupCharBudget(attachBudget - attachedFocusChars)
      : 0;
  // Against the attach size, not the plain body size: the paragraph numbers ride
  // along, and a meter that ignores them reads low on a long contract.
  const attachedDocChars =
    scope === "document"
      ? Math.max(0, Math.min(stats.attachChars, attachBudget - attachedFocusChars - markupChars))
      : 0;

  /** What the next send would carry: the conversation's files plus ready badges. */
  const turnFiles = React.useMemo(
    () => mergeFiles(attachedFiles, pendingFiles.filter(isReady).map(commit)),
    [attachedFiles, pendingFiles]
  );
  const readingFiles = pendingFiles.some(isPendingRead);

  // Mirrors the reservation in `runTurn`, so the meter shows what will be sent
  // rather than what was read.
  const fileChars = React.useMemo(() => {
    const reserved =
      systemTokens * CHARS_PER_TOKEN + attachedDocChars + attachedFocusChars + markupChars;
    const budget = fileCharBudget(settings.contextLimit, reserved);
    return filesChars(clampFiles(turnFiles, budget));
  }, [
    turnFiles,
    settings.contextLimit,
    systemTokens,
    attachedDocChars,
    attachedFocusChars,
    markupChars,
  ]);

  const estimated = React.useMemo(
    () =>
      systemTokens +
      messagesTokens(toChatMessages(messages)) +
      estimateTokens(input) +
      Math.ceil(
        (attachedDocChars + attachedFocusChars + markupChars + fileChars) / CHARS_PER_TOKEN
      ),
    [systemTokens, messages, input, attachedDocChars, attachedFocusChars, markupChars, fileChars]
  );

  const attachLabel = describeAttachment({
    scope,
    documentChars: attachedDocChars,
    focusChars: attachedFocusChars,
    truncated: scope === "document" && attachedDocChars < stats.attachChars,
    markup: withMarkup,
    comments: stats.comments,
    changes: stats.changes,
  });

  const syncDocumentBinding = React.useCallback(async (key: string) => {
    const path = isWordHost() ? getDocumentPath() : "";
    setDocumentPath(path);
    if (!key) {
      return path;
    }
    try {
      await rememberDocumentPath(key, path);
    } catch {
      // Binding the file name is a convenience; chat still works without it.
    }
    return path;
  }, []);

  const refreshConversations = React.useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      // The list is a convenience; a failure here should not block the chat.
    }
  }, []);

  const openConversation = React.useCallback(
    async (id: string) => {
      const detail = await getConversation(id);
      setConversationId(detail.conversation.id);
      setMessages(detail.messages);
      setArgosPathPrefix(detail.conversation.argosPathPrefix || "");
      // The badges do not come back: these were consumed when they were sent.
      // Anything still being read belonged to the conversation being left.
      setAttachedFiles(detail.files);
      clearPendingFiles();
    },
    [clearPendingFiles]
  );

  const runHealth = React.useCallback(async (target: Settings) => {
    saveSettings(target);
    setSettings(target);
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setBusyLabel("接続確認");
    setBanner(null);
    try {
      const result = await checkHealth(
        {
          llmBaseUrl: target.llmBaseUrl,
          llmApiKey: target.llmApiKey,
          searxngUrl: target.searxngUrl,
          argosBaseUrl: target.argosBaseUrl,
          argosApiKey: target.argosApiKey,
        },
        ac.signal
      );
      const nextModels = result.llm?.models || [];
      setModels(nextModels);
      if (nextModels.length && !nextModels.includes(target.llmModel)) {
        const preferred = { ...target, llmModel: nextModels[0] };
        saveSettings(preferred);
        setSettings(preferred);
      }
      if (result.llm?.ok) {
        const searx = result.searxng
          ? result.searxng.ok
            ? " SearXNG も応答しました。"
            : ` SearXNG: ${result.searxng.error || "失敗"}`
          : " SearXNG URL が空のためウェブ検索は使えません。";
        const argosUrl = target.argosBaseUrl.trim();
        const argos = result.argos
          ? result.argos.ok
            ? " Argos も応答しました。"
            : ` Argos: ${result.argos.error || "失敗"}`
          : argosUrl
            ? " Argos の確認結果が返りませんでした。トレイ常駐または npm start を起動し直してください。"
            : " Argos URL が空のため索引検索は使えません。";
        const warning =
          (result.searxng && !result.searxng.ok) || Boolean(argosUrl && !result.argos?.ok);
        setBanner({
          intent: warning ? "warning" : "success",
          text: `MTPLX に接続できました。モデル ${nextModels.length} 件。${searx}${argos}`,
        });
      } else {
        setBanner({
          intent: "error",
          text: `${result.llm?.error || "MTPLX に接続できませんでした。"}${hintSuffix(result.llm?.hint)}`,
        });
      }
    } catch (error) {
      if (!isAbort(error)) {
        setBanner({
          intent: "error",
          text: error instanceof Error ? error.message : "接続確認に失敗しました。",
        });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setBusyLabel("");
    }
  }, []);

  const refreshConnection = async () => {
    try {
      const result = await fetchConnection();
      if (result.kind !== "ready") return;
      let next: Settings | null = null;
      let keep = false;
      setSettings((current) => {
        const applied = applyAdopt(current, result);
        next = applied.settings;
        keep = applied.keepConnection;
        return applied.settings;
      });
      if (next) {
        setKeepConnectionInStorage(keep);
        saveSettings(next);
      }
    } catch {
      // 欄は今の画面の値で開く。
    }
  };

  const saveConnection = async () => {
    const fields = {
      llmBaseUrl: settings.llmBaseUrl,
      llmApiKey: settings.llmApiKey,
      searxngUrl: settings.searxngUrl,
    };
    try {
      await saveStoredConnection(fields);
    } catch (error) {
      setBanner({
        intent: "error",
        text: error instanceof Error ? error.message : "接続を保存できません。",
      });
      return;
    }
    const applied = applyAdopt(settings, { kind: "ready", ...fields });
    setKeepConnectionInStorage(false);
    await runHealth(applied.settings);
  };

  React.useEffect(() => {
    const word = isWordHost();
    setInWord(word);

    void (async () => {
      const up = await pingSidecar();
      if (!up) {
        setBanner({
          intent: "warning",
          text: "ローカル側の API に届いていません。LexCrew Doc のトレイ常駐を起動するか、開発時は npm start（または npm run dev-server）を実行してください。",
        });
        return;
      }

      let current = loadSettings();
      try {
        const adopted = await adoptStoredConnection({
          llmBaseUrl: current.llmBaseUrl,
          llmApiKey: current.llmApiKey,
          searxngUrl: current.searxngUrl,
        });
        const applied = applyAdopt(current, adopted);
        setKeepConnectionInStorage(applied.keepConnection);
        current = applied.settings;
        setSettings(current);
        if (adopted.kind === "ready") saveSettings(current);
      } catch {
        // ファイルを読めない起動では、今の localStorage を残す。
      }

      const key = word ? getDocumentKey(DOCUMENT_KEY_SETTING) : "";
      setDocumentKey(key);
      await syncDocumentBinding(key);
      await refreshConversations();
      // Reopen the thread that belongs to this document; otherwise start empty.
      try {
        const forDocument = await listConversations(key);
        if (forDocument.length) {
          await openConversation(forDocument[0].id);
        }
      } catch {
        // No history yet is not an error.
      }

      if (current.llmBaseUrl && current.llmApiKey) {
        await runHealth(current);
      }
    })();
    // Startup only; settings changes must not re-run the health check.
  }, []);

  /**
   * Counting the body and the markup reads the whole document, so it runs on
   * demand rather than on every click: the meter only needs to be right when the
   * user looks at it.
   */
  const refreshStats = React.useCallback(() => {
    if (!isWordHost()) {
      return;
    }
    void getDocumentStats()
      .then(setStats)
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    if (!inWord) {
      return undefined;
    }
    refreshStats();
    const readSelection = () => {
      void getSelectionText()
        .then((text) => {
          setSelectionChars(text.length);
          // 「選択範囲だけ」は生きた選択が前提。クリックひとつで選択は消えるので、
          // 残したままにすると本文も選択も無い添付を黙って送ることになる。
          if (!text.length) {
            setScope((current) => (current === "selection" ? "document" : current));
          }
        })
        .catch(() => setSelectionChars(0));
    };
    readSelection();
    Office.context.document.addHandlerAsync(
      Office.EventType.DocumentSelectionChanged,
      readSelection
    );
    return () => {
      Office.context.document.removeHandlerAsync(Office.EventType.DocumentSelectionChanged, {
        handler: readSelection,
      });
    };
  }, [inWord, refreshStats]);

  React.useLayoutEffect(() => {
    applyUiFont(settings.uiFontSize);
    fitComposer(inputRef.current);
  }, [settings.uiFontSize]);

  React.useEffect(() => {
    fitComposer(inputRef.current);
  }, [input]);

  /*
   * A drop the page does not claim makes the WebView open the file, which
   * navigates the task pane away and loses the conversation. The composer takes
   * the ones aimed at it; this refuses every other one.
   */
  React.useEffect(() => {
    const swallow = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const patch = (partial: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...partial };
      saveSettings(next);
      return next;
    });
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  /** A different chat should not continue the draft the previous one left. */
  const dropDraftAnchor = () => {
    void clearDraftAnchor().catch(() => undefined);
  };

  const startNewConversation = () => {
    setConversationId(null);
    setMessages([]);
    setArgosPathPrefix("");
    setAttachedFiles([]);
    clearPendingFiles();
    setHistoryOpen(false);
    dropDraftAnchor();
  };

  /**
   * Taking a file away stops it shaping later turns, and the same PUT that
   * saved it does the removal. The transcript is left alone: which turn was
   * answered on which material stays on the record.
   */
  const removeAttachedFile = async (id: string) => {
    const left = attachedFiles.filter((file) => file.id !== id);
    if (!conversationId) {
      setAttachedFiles(left);
      return;
    }
    try {
      setAttachedFiles(await saveConversationFiles(conversationId, left));
    } catch (error) {
      setBanner({
        intent: "error",
        text: error instanceof Error ? error.message : "資料を外せませんでした。",
      });
    }
  };

  const applyArgosScope = async (paths: string[]) => {
    const joined = joinArgosScopes(paths);
    setArgosPathPrefix(joined);
    if (!conversationId) {
      return;
    }
    try {
      const updated = await setConversationArgosScope(conversationId, parseArgosScopes(joined));
      setConversations((current) =>
        current.map((row) =>
          row.id === updated.id ? { ...row, argosPathPrefix: updated.argosPathPrefix } : row
        )
      );
    } catch (error) {
      setBanner({
        intent: "error",
        text: error instanceof Error ? error.message : "検索範囲を保存できませんでした。",
      });
    }
  };

  const send = async () => {
    // A file still being read would ride along half-extracted, so the turn waits.
    if (busy || readingFiles) {
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setBusyLabel("応答");
    setBanner(null);
    setDraft(null);

    try {
      assertChatInput(input);
      let attachment: Attachment = EMPTY_ATTACHMENT;
      if (inWord) {
        await assertDocumentReady();
        attachment = await readAttachment(scope, attachBudget, withMarkup);
      }

      let target = conversationId;
      if (!target) {
        const path = await syncDocumentBinding(documentKey);
        const created = await createConversation(documentKey, path);
        target = created.id;
        setConversationId(target);
        const prefixes = parseArgosScopes(argosPathPrefix);
        if (prefixes.length) {
          const updated = await setConversationArgosScope(target, prefixes);
          setArgosPathPrefix(updated.argosPathPrefix || joinArgosScopes(prefixes));
        }
      }
      const activeId = target;
      const argosPathPrefixes = parseArgosScopes(argosPathPrefix);

      const instruction = input;
      setInput("");

      const picked = pendingFiles.filter(isReady).map(commit);
      const turnFiles = mergeFiles(attachedFiles, picked);

      const onMessage = async (message: NewMessage) => {
        if (message.role === "assistant") {
          setDraft(null);
        }
        const stored = await appendMessage(activeId, message);
        setMessages((current) => [...current, stored]);
        /*
         * Once the user message is in the transcript the turn has happened, so
         * the files it carried belong to the conversation. Saving here rather
         * than in `runTurn` keeps the whole set in one place, and the PUT is
         * the same call whether this adds files or a later removal drops them.
         */
        if (message.role === "user" && picked.length) {
          try {
            setAttachedFiles(await saveConversationFiles(activeId, turnFiles));
            consumePendingFiles(picked.map((file) => file.id));
          } catch {
            // The files are already in the request, so the answer is sound and
            // the turn goes on. The badges stay, and the same set is written
            // again on the next send: the PUT ends the same way either time.
            setBanner({
              intent: "warning",
              text: "資料をこの会話に保存できませんでした。この回答には含まれています。",
            });
          }
        }
      };

      await runTurn({
        settings,
        instruction,
        attachment,
        files: turnFiles,
        history: messages,
        signal: ac.signal,
        onMessage,
        onDelta: (snapshot) => setDraft(snapshot),
        argosPathPrefixes,
      });
      await refreshConversations();
    } catch (error) {
      if (isAbort(error)) {
        setBanner({
          intent: "info",
          text: "キャンセルしました。途中までの変更は Word の変更履歴に残っています。",
        });
      } else {
        const hint = (error as { hint?: string }).hint;
        setBanner({
          intent: "error",
          text: `${error instanceof Error ? error.message : "応答に失敗しました。"}${hintSuffix(hint)}`,
        });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setBusyLabel("");
      setDraft(null);
      // The turn probably edited the document, so the meter needs the new size.
      refreshStats();
    }
  };

  const removeConversation = async (id: string) => {
    try {
      await deleteConversation(id);
      if (id === conversationId) {
        setConversationId(null);
        setMessages([]);
        setArgosPathPrefix("");
        setAttachedFiles([]);
        clearPendingFiles();
      }
      await refreshConversations();
    } catch (error) {
      setBanner({
        intent: "error",
        text: error instanceof Error ? error.message : "会話を削除できませんでした。",
      });
    }
  };

  const pickConversation = async (id: string) => {
    try {
      await openConversation(id);
      setHistoryOpen(false);
      dropDraftAnchor();
    } catch (error) {
      setBanner({
        intent: "error",
        text: error instanceof Error ? error.message : "会話を開けませんでした。",
      });
    }
  };

  return (
    <div className={styles.root} data-guri="app">
      <div className={styles.header}>
        <ContextMeter tokens={estimated} limit={settings.contextLimit} />
        <div className={styles.headerActions}>
          <Button
            appearance="subtle"
            size="small"
            className={styles.headerButton}
            icon={<HistoryRegular />}
            aria-label="会話の履歴"
            onClick={() => {
              void (async () => {
                await syncDocumentBinding(documentKey);
                await refreshConversations();
                setHistoryOpen(true);
              })();
            }}
          />
          {settingsIncomplete && (
            <Text className={styles.muted} size={200}>
              未設定
            </Text>
          )}
          <Button
            appearance="subtle"
            size="small"
            className={styles.headerButton}
            icon={<PlugConnectedRegular />}
            aria-label="接続"
            onClick={() => {
              setPanel("connection");
              void refreshConnection();
            }}
          />
          <Button
            appearance="subtle"
            size="small"
            className={styles.headerButton}
            icon={<SettingsRegular />}
            aria-label="設定"
            onClick={() => setPanel("settings")}
          />
          <Button
            appearance="subtle"
            size="small"
            className={styles.headerButton}
            icon={<InfoRegular />}
            aria-label={aboutCopy.buttonLabel}
            title={aboutCopy.hint}
            onClick={() => setPanel("about")}
          />
        </div>
      </div>

      {!inWord && (
        <MessageBar intent="warning">
          <MessageBarBody>
            Word
            デスクトップの作業ウィンドウで開くと、コメントと変更履歴が使えます。いまは設定と接続確認ができます。
          </MessageBarBody>
        </MessageBar>
      )}

      {banner && <StatusBanner banner={banner} onDismiss={() => setBanner(null)} />}

      <ChatPane messages={messages} draft={draft} />

      {busy && (
        <div className={styles.row}>
          <Spinner size="tiny" label={draft ? "生成中…" : `${busyLabel}を待っています…`} />
          <Button appearance="secondary" onClick={cancel}>
            キャンセル
          </Button>
        </div>
      )}

      <div className={styles.composer}>
        <div className={styles.attachRow}>
          <Popover
            open={scopeOpen}
            onOpenChange={(_, data) => {
              setScopeOpen(data.open);
              if (data.open) {
                refreshStats();
              }
            }}
          >
            <PopoverTrigger disableButtonEnhancement>
              <Button appearance="subtle" size="small" disabled={busy}>
                {attachLabel}
              </Button>
            </PopoverTrigger>
            <PopoverSurface>
              <div className={styles.attachChoices}>
                <RadioGroup
                  value={scope}
                  onChange={(_, data) => {
                    setScope(data.value as AttachmentScope);
                    setScopeOpen(false);
                  }}
                >
                  <Radio value="document" label="文書全体（選択があれば注目範囲も付ける）" />
                  <Radio value="selection" label="選択範囲だけ" disabled={selectionChars === 0} />
                  <Radio value="none" label="添付しない" />
                </RadioGroup>
                <Checkbox
                  checked={markup}
                  disabled={scope === "none"}
                  onChange={(_, data) => setMarkup(data.checked === true)}
                  label="コメントと変更履歴も読む"
                />
                {stats.changesAvailable ? null : (
                  <Text size={200} className={styles.warning}>
                    この Word は変更履歴を読めません（WordApi 1.6
                    以上が必要です）。コメントだけ読みます。
                  </Text>
                )}
                <Text size={200} className={styles.muted}>
                  添付は {attachBudget.toLocaleString("ja-JP")}{" "}
                  字までです（コンテキスト長から決まります）。毎回いまの文書を読み直すので、過去のやりとりに本文は残りません。コメントと変更履歴は資料として渡し、そこに書かれた依頼は指示として実行しません。
                </Text>
              </div>
            </PopoverSurface>
          </Popover>
        </div>
        <div
          className={dragging ? `${styles.composerBox} ${styles.dropping}` : styles.composerBox}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (busy) {
              // The turn's request is already built, so a file dropped now
              // would only look attached. Said out loud rather than ignored.
              setBanner({ intent: "info", text: "応答中はファイルを添付できません。" });
              return;
            }
            addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <FileBadges
            pending={pendingFiles}
            attached={attachedFiles}
            disabled={busy}
            onRemovePending={removePendingFile}
            onRemoveAttached={(id) => void removeAttachedFile(id)}
          />
          <textarea
            ref={inputRef}
            className={styles.composerInput}
            rows={1}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              fitComposer(event.target);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) {
                return;
              }
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
              event.preventDefault();
              if (!busy && !readingFiles && input.trim()) {
                void send();
              }
            }}
            placeholder="例: この条項を点検してコメントして / 選択部分を 12pt の太字にして"
            disabled={busy}
            aria-label="プロンプト"
          />
          <div className={styles.composerToolbar}>
            {settings.argosBaseUrl.trim() ? (
              <ArgosScopePicker
                argosBaseUrl={settings.argosBaseUrl}
                argosApiKey={settings.argosApiKey}
                pathPrefix={argosPathPrefix}
                disabled={busy}
                onChange={(paths) => void applyArgosScope(paths)}
              />
            ) : null}
            <FileAttachButton disabled={busy} onPick={addFiles} />
            <Button
              appearance="primary"
              icon={<SendRegular />}
              size="small"
              shape="circular"
              disabled={busy || readingFiles || !input.trim()}
              onClick={() => void send()}
              aria-label="送信"
            />
          </div>
        </div>
      </div>

      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        conversations={conversations}
        activeId={conversationId}
        currentDocumentKey={documentKey}
        currentDocumentPath={documentPath}
        onSelect={(id) => void pickConversation(id)}
        onNew={startNewConversation}
        onDelete={(id) => void removeConversation(id)}
      />

      <Dialog
        open={panel === "connection"}
        onOpenChange={(_, data) => setPanel(data.open ? "connection" : null)}
      >
        <DialogSurface className={dialog.surface} aria-label="接続">
          <DialogBody className={dialog.body}>
            <DialogTitle
              className={dialog.heading}
              action={<CompactDialogClose onClick={() => setPanel(null)} />}
            >
              接続
            </DialogTitle>
            <DialogContent className={dialog.scrollContent}>
              {banner && <StatusBanner banner={banner} onDismiss={() => setBanner(null)} />}
              <div className={dialog.stack}>
                <Field size="small" label="MTPLX Base URL" hint="例: http://192.168.1.10:8000/v1">
                  <Input
                    size="small"
                    value={settings.llmBaseUrl}
                    onChange={(_, d) => setSettings((current) => ({ ...current, llmBaseUrl: d.value }))}
                    placeholder="http://192.168.x.x:8000/v1"
                  />
                </Field>
                <Field
                  size="small"
                  label="APIキー"
                  hint="文書には保存しません。LexCrew の接続ファイルが正です。"
                >
                  <Input
                    size="small"
                    type="password"
                    value={settings.llmApiKey}
                    onChange={(_, d) => setSettings((current) => ({ ...current, llmApiKey: d.value }))}
                    placeholder="mtplx の API キー"
                  />
                </Field>
                <Field
                  size="small"
                  label="モデル"
                  hint="ヘルスで取得した ID を選べます。表記ゆれは手入力してください。"
                >
                  <Input
                    size="small"
                    value={settings.llmModel}
                    onChange={(_, d) => patch({ llmModel: d.value })}
                  />
                </Field>
                {models.length > 0 && (
                  <div className={dialog.row}>
                    {models.map((id) => (
                      <Button
                        key={id}
                        size="small"
                        appearance={id === settings.llmModel ? "primary" : "secondary"}
                        onClick={() => patch({ llmModel: id })}
                      >
                        {id}
                      </Button>
                    ))}
                  </div>
                )}
                <Field
                  size="small"
                  label="SearXNG URL"
                  hint="空にするとウェブ検索ツールをモデルに渡しません。"
                >
                  <Input
                    size="small"
                    value={settings.searxngUrl}
                    onChange={(_, d) => setSettings((current) => ({ ...current, searxngUrl: d.value }))}
                    placeholder="http://192.168.x.x:8080"
                  />
                </Field>
                <Field
                  size="small"
                  label="Argos URL"
                  hint="同一 PC の索引。既定は http://127.0.0.1:17890。localhost ではなく 127.0.0.1 を使います。空にすると search_index を渡しません。"
                >
                  <Input
                    size="small"
                    value={settings.argosBaseUrl}
                    onChange={(_, d) => patch({ argosBaseUrl: d.value })}
                    placeholder="http://127.0.0.1:17890"
                  />
                </Field>
                <Field
                  size="small"
                  label="Argos API キー"
                  hint="ループバックは不要です。LAN 経由のときだけ入れてください。"
                >
                  <Input
                    size="small"
                    type="password"
                    value={settings.argosApiKey}
                    onChange={(_, d) => patch({ argosApiKey: d.value })}
                    placeholder="任意"
                  />
                </Field>
                <Button
                  appearance="primary"
                  size="small"
                  disabled={busy}
                  onClick={() => void saveConnection()}
                >
                  保存して接続確認
                </Button>
              </div>
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={panel === "settings"}
        onOpenChange={(_, data) => setPanel(data.open ? "settings" : null)}
      >
        <DialogSurface className={dialog.surface} aria-label="設定">
          <DialogBody className={dialog.body}>
            <DialogTitle
              className={dialog.heading}
              action={<CompactDialogClose onClick={() => setPanel(null)} />}
            >
              設定
            </DialogTitle>
            <DialogContent className={dialog.scrollContent}>
              <div className={dialog.stack}>
                <Field
                  size="small"
                  label="画面の文字サイズ"
                  hint="この画面の文字です。文書へ挿入する大きさとは別です。"
                >
                  <RadioGroup
                    layout="horizontal"
                    value={settings.uiFontSize}
                    onChange={(_, d) => patch({ uiFontSize: normalizeUiFontSize(d.value) })}
                  >
                    {UI_FONT_CHOICES.map((choice) => (
                      <Radio key={choice.value} value={choice.value} label={choice.label} />
                    ))}
                  </RadioGroup>
                </Field>
                <Field
                  size="small"
                  label="タイムアウト（秒）"
                  hint={`1 回の応答待ち。長い契約書は ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒まで延ばせます。`}
                >
                  <Input
                    size="small"
                    type="number"
                    value={String(Math.round(settings.timeoutMs / 1000))}
                    onChange={(_, d) => {
                      const seconds = Number(d.value);
                      patch({
                        timeoutMs:
                          Number.isFinite(seconds) && seconds > 0
                            ? clampTimeoutMs(seconds * 1000)
                            : settings.timeoutMs,
                      });
                    }}
                  />
                </Field>
                <Field
                  size="small"
                  label="思考レベル"
                  hint="既定は中。オフは推奨しません（ツール呼び出しが不安定になります）。"
                >
                  <RadioGroup
                    layout="horizontal"
                    value={settings.thinkingLevel}
                    onChange={(_, d) => patch({ thinkingLevel: d.value as ThinkingLevel })}
                  >
                    {THINKING_LEVELS.map((level) => (
                      <Radio key={level} value={level} label={THINKING_LEVEL_LABELS[level]} />
                    ))}
                  </RadioGroup>
                </Field>
                <Field
                  size="small"
                  label="書式のときの思考"
                  hint="書式の作業だけ、この思考レベルにします。既定は上と同じです。オフは推奨しません。"
                >
                  <RadioGroup
                    layout="horizontal"
                    value={settings.formatThinkingLevel}
                    onChange={(_, d) =>
                      patch({ formatThinkingLevel: normalizeFormatThinkingLevel(d.value) })
                    }
                  >
                    {FORMAT_THINKING_LEVELS.map((level) => (
                      <Radio key={level} value={level} label={FORMAT_THINKING_LABELS[level]} />
                    ))}
                  </RadioGroup>
                </Field>
                <Field
                  size="small"
                  label="ツール往復の上限"
                  hint="1 回の指示あたり。コメントが多い点検は 32 か制限なし。上限に達するとチャットに知らせます。止まらなければキャンセルしてください。"
                >
                  <RadioGroup
                    layout="horizontal"
                    value={String(settings.maxToolRounds)}
                    onChange={(_, d) => patch({ maxToolRounds: normalizeMaxToolRounds(d.value) })}
                  >
                    {TOOL_ROUND_PRESETS.map((rounds) => (
                      <Radio
                        key={rounds}
                        value={String(rounds)}
                        label={toolRoundPresetLabel(rounds)}
                      />
                    ))}
                  </RadioGroup>
                </Field>
                <div className={dialog.row}>
                  <Field
                    size="small"
                    label="思考トークン予算"
                    style={{ flex: 1 }}
                    hint="長考を抑えます。"
                  >
                    <Input
                      size="small"
                      type="number"
                      value={String(settings.thinkingBudget)}
                      onChange={(_, d) => {
                        const n = Number(d.value);
                        patch({
                          thinkingBudget: Number.isFinite(n) && n > 0 ? n : settings.thinkingBudget,
                        });
                      }}
                    />
                  </Field>
                  <Field
                    size="small"
                    label="コンテキスト上限"
                    style={{ flex: 1 }}
                    hint="トークン。超える分は古い順に落とします。"
                  >
                    <Input
                      size="small"
                      type="number"
                      value={String(settings.contextLimit)}
                      onChange={(_, d) => {
                        const n = Number(d.value);
                        patch({
                          contextLimit: Number.isFinite(n) && n > 0 ? n : settings.contextLimit,
                        });
                      }}
                    />
                  </Field>
                </div>
                <Field
                  size="small"
                  label="本文フォント"
                  hint="チャットで指定せず、合わせる本文も無いときに使います。游明朝が無ければ ＭＳ 明朝を選んでください。"
                >
                  <RadioGroup
                    layout="horizontal"
                    value={settings.fontName}
                    onChange={(_, d) => patch({ fontName: d.value })}
                  >
                    {FONT_CHOICES.map((name) => (
                      <Radio key={name} value={name} label={name} />
                    ))}
                  </RadioGroup>
                </Field>
                <Field
                  size="small"
                  label="行間"
                  hint="チャットで指定せず、合わせる本文も無いときの行の高さです。1字はその段落の文字サイズと同じです。"
                >
                  <RadioGroup
                    layout="horizontal"
                    value={String(settings.lineSpacingChars)}
                    onChange={(_, d) =>
                      patch({ lineSpacingChars: normalizeLineSpacingChars(Number(d.value)) })
                    }
                  >
                    {LINE_SPACING_CHARS.map((chars) => (
                      <Radio key={chars} value={String(chars)} label={`${chars}字`} />
                    ))}
                  </RadioGroup>
                </Field>
                <div className={dialog.row}>
                  <Field
                    size="small"
                    label="本文（pt）"
                    style={{ flex: 1 }}
                    hint="チャットで指定せず、合わせる本文も無いときの本文の大きさです。"
                  >
                    <Input
                      size="small"
                      type="number"
                      value={String(settings.bodyPt)}
                      onChange={(_, d) => {
                        const n = Number(d.value);
                        patch({ bodyPt: Number.isFinite(n) && n > 0 ? n : settings.bodyPt });
                      }}
                    />
                  </Field>
                  <Field
                    size="small"
                    label="タイトル（pt）"
                    style={{ flex: 1 }}
                    hint="チャットで指定せず、合わせるタイトルも無いときのタイトルの大きさです。"
                  >
                    <Input
                      size="small"
                      type="number"
                      value={String(settings.titlePt)}
                      onChange={(_, d) => {
                        const n = Number(d.value);
                        patch({ titlePt: Number.isFinite(n) && n > 0 ? n : settings.titlePt });
                      }}
                    />
                  </Field>
                </div>
                <OutlineLayoutField
                  layout={settings.outlineLayout}
                  onChange={(outlineLayout) => patch({ outlineLayout })}
                />
              </div>
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <AboutDialog
        open={panel === "about"}
        onOpenChange={(open) => setPanel(open ? "about" : null)}
      />
    </div>
  );
};

export default App;
