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
  DocumentGroup,
  conversationDocumentLabel,
  groupConversationsByDocument,
  partitionConversations,
} from "../../shared/history";
import { uiPx } from "../uiFont";
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
    fontSize: uiPx(12),
    lineHeight: uiPx(16),
  },
  title: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: uiPx(12),
    lineHeight: uiPx(16),
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: uiPx(12),
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
    fontSize: uiPx(11),
    lineHeight: uiPx(16),
    color: tokens.colorNeutralForeground2,
  },
  sectionHeading: {
    flexShrink: 0,
    fontSize: uiPx(12),
    lineHeight: uiPx(16),
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
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

export type HistoryConversationListProps = {
  conversations: ConversationSummary[];
  activeId: string | null;
  currentDocumentKey?: string;
  currentDocumentPath?: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

export type HistoryDialogProps = HistoryConversationListProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNew: () => void;
};

export const HistoryConversationList: React.FC<HistoryConversationListProps> = ({
  conversations,
  activeId,
  currentDocumentKey = "",
  currentDocumentPath = "",
  onSelect,
  onDelete,
}) => {
  const styles = useStyles();
  const dialog = useCompactDialogStyles();
  const split = partitionConversations(conversations, currentDocumentKey);
  const elsewhereGroups = groupConversationsByDocument(split.elsewhere);
  const currentLabel = conversationDocumentLabel(
    {
      documentKey: currentDocumentKey,
      documentPath: split.here[0]?.documentPath ?? "",
    },
    currentDocumentKey,
    currentDocumentPath
  );
  const currentPath = currentDocumentPath || split.here[0]?.documentPath || "";

  const conversationRow = (conversation: ConversationSummary) => (
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
  );

  const documentGroup = (group: DocumentGroup) => {
    const sample = group.conversations[0];
    const fileLabel = conversationDocumentLabel(sample, currentDocumentKey, currentDocumentPath);
    return (
      <div key={group.documentKey || group.documentPath || sample.id} className={styles.group}>
        <div className={styles.groupHeader} title={group.documentPath || fileLabel}>
          <span className={styles.groupLabel}>{fileLabel}</span>
        </div>
        {group.conversations.map(conversationRow)}
      </div>
    );
  };

  return (
    <div className={styles.list}>
      {currentDocumentKey ? (
        <>
          <div className={styles.groupHeader} title={currentPath || currentLabel}>
            <span className={styles.sectionHeading}>この文書</span>
            <span className={styles.groupLabel}>{currentLabel}</span>
          </div>
          {split.here.length ? (
            split.here.map(conversationRow)
          ) : (
            <Text className={styles.empty}>この文書の履歴はまだありません。</Text>
          )}
          {elsewhereGroups.length ? (
            <>
              <div className={styles.groupHeader}>
                <span className={styles.sectionHeading}>ほかの文書</span>
              </div>
              {elsewhereGroups.map(documentGroup)}
            </>
          ) : null}
        </>
      ) : elsewhereGroups.length ? (
        elsewhereGroups.map(documentGroup)
      ) : (
        <Text className={styles.empty}>まだ会話がありません。</Text>
      )}
    </div>
  );
};

const HistoryDialog: React.FC<HistoryDialogProps> = ({
  open,
  onOpenChange,
  onNew,
  ...list
}) => {
  const dialog = useCompactDialogStyles();
  const close = () => onOpenChange(false);

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
            <HistoryConversationList {...list} />
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
