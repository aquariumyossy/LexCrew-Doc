import * as React from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AddRegular, DeleteRegular } from "@fluentui/react-icons";
import {
  ConversationSummary,
  conversationDocumentLabel,
  groupConversationsByDocument,
} from "../../shared/history";
import { CompactDialogClose, useCompactDialogStyles } from "./compactDialog";

const useStyles = makeStyles({
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
    padding: "4px 6px",
    borderRadius: "4px",
  },
  active: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  pick: {
    flexGrow: 1,
    minWidth: 0,
    height: "auto",
    minHeight: "unset",
    padding: "0",
    textAlign: "left",
    justifyContent: "flex-start",
    fontSize: "12px",
    lineHeight: "16px",
  },
  title: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    lineHeight: "16px",
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    padding: "8px 6px",
  },
  group: {
    display: "flex",
    flexDirection: "column",
  },
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
    padding: "4px 6px 2px",
  },
  groupLabel: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "11px",
    lineHeight: "16px",
    color: tokens.colorNeutralForeground2,
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
  iconButton: {
    minWidth: "20px",
    maxWidth: "20px",
    height: "20px",
  },
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type HistoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: ConversationSummary[];
  activeId: string | null;
  currentDocumentKey?: string;
  currentDocumentPath?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
};

const HistoryDialog: React.FC<HistoryDialogProps> = ({
  open,
  onOpenChange,
  conversations,
  activeId,
  currentDocumentKey = "",
  currentDocumentPath = "",
  onSelect,
  onNew,
  onDelete,
}) => {
  const styles = useStyles();
  const dialog = useCompactDialogStyles();
  const close = () => onOpenChange(false);
  const groups = groupConversationsByDocument(conversations);

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface className={dialog.surface} aria-label="会話の履歴">
        <DialogBody className={dialog.body}>
          <DialogTitle className={dialog.heading} action={<CompactDialogClose onClick={close} />}>
            会話の履歴
          </DialogTitle>
          <DialogContent className={dialog.content}>
            <Button
              appearance="primary"
              size="small"
              icon={<AddRegular fontSize={14} />}
              onClick={onNew}
            >
              新しい会話
            </Button>
            <div className={styles.list}>
              {!conversations.length ? (
                <Text className={styles.empty}>まだ会話がありません。</Text>
              ) : null}
              {groups.map((group) => {
                const sample = group.conversations[0];
                const fileLabel = conversationDocumentLabel(
                  sample,
                  currentDocumentKey,
                  currentDocumentPath
                );
                const isCurrent =
                  Boolean(currentDocumentKey) && group.documentKey === currentDocumentKey;
                const pathHint = isCurrent
                  ? currentDocumentPath || group.documentPath
                  : group.documentPath;
                return (
                  <div
                    key={group.documentKey || group.documentPath || sample.id}
                    className={styles.group}
                  >
                    <div className={styles.groupHeader} title={pathHint || fileLabel}>
                      <span className={styles.groupLabel}>{fileLabel}</span>
                      {isCurrent ? <span className={styles.badge}>この文書</span> : null}
                    </div>
                    {group.conversations.map((conversation) => (
                      <div
                        key={conversation.id}
                        className={`${styles.row} ${conversation.id === activeId ? styles.active : ""}`}
                      >
                        <Button
                          appearance="subtle"
                          size="small"
                          className={styles.pick}
                          onClick={() => onSelect(conversation.id)}
                        >
                          <span className={styles.title}>
                            <Text weight="semibold" block className={styles.title}>
                              {conversation.title}
                            </Text>
                            <Text className={dialog.muted} block>
                              {formatDate(conversation.updatedAt)} · {conversation.messageCount} 件
                            </Text>
                          </span>
                        </Button>
                        <Button
                          appearance="subtle"
                          size="small"
                          className={styles.iconButton}
                          icon={<DeleteRegular fontSize={14} />}
                          aria-label={`${conversation.title} を削除`}
                          onClick={() => onDelete(conversation.id)}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <Text className={dialog.muted}>
              会話は開いていた Word ファイルに紐づき、この PC のローカル
              DB（%APPDATA%\GURI\history.db）だけに保存されます。
            </Text>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};

export default HistoryDialog;
