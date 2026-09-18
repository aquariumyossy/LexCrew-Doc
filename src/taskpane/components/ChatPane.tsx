import * as React from "react";
import { Badge, Text, makeStyles, tokens } from "@fluentui/react-components";
import { StoredMessage } from "../../shared/history";
import { foreignCharNoticeForAssistant } from "../../shared/japaneseHan";
import { splitUserMessage } from "../../shared/prompts";
import { TOOL_SEARCH, TOOL_SEARCH_INDEX, describeToolCall } from "../../shared/tools";
import { SearchHit } from "../../sidecar/types";
import MarkdownView, { CollapsedLink } from "./MarkdownView";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    overflowY: "auto",
    flexGrow: 1,
    minHeight: "120px",
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
    padding: "24px 8px",
    backgroundColor: tokens.colorNeutralCardBackground,
    border: `1px solid ${tokens.colorBrandStroke2}`,
    borderRadius: "8px",
  },
  turn: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  user: {
    alignSelf: "flex-end",
    maxWidth: "92%",
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke2}`,
    borderRadius: "8px",
    padding: "8px 10px",
    wordBreak: "break-word",
  },
  assistant: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    backgroundColor: tokens.colorNeutralCardBackground,
    border: "none",
    borderRadius: "8px",
    padding: "8px 10px",
    wordBreak: "break-word",
  },
  caret: {
    display: "inline-block",
    width: "2px",
    height: "1em",
    marginLeft: "2px",
    backgroundColor: tokens.colorBrandForeground1,
    verticalAlign: "text-bottom",
    animationName: {
      from: { opacity: 1 },
      to: { opacity: 0 },
    },
    animationDuration: "0.7s",
    animationIterationCount: "infinite",
    animationDirection: "alternate",
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
  },
  disclosure: {
    border: `1px solid ${tokens.colorBrandStroke2}`,
    borderRadius: "6px",
    padding: "6px 8px",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
  },
  disclosureBody: {
    marginTop: "6px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: "200px",
    overflowY: "auto",
  },
  summary: {
    cursor: "pointer",
  },
  hit: {
    border: `1px solid ${tokens.colorBrandStroke2}`,
    borderRadius: "6px",
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    backgroundColor: tokens.colorNeutralCardBackground,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  warning: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    fontSize: "12px",
    marginTop: "6px",
  },
});

/** Tool replies only carry an id, so the name comes from the call that asked for it. */
function toolNameById(messages: StoredMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls) {
      names.set(call.id, call.function.name);
    }
  }
  return names;
}

function parseHits(content: string): SearchHit[] | null {
  try {
    const parsed = JSON.parse(content) as SearchHit[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const Disclosure: React.FC<{ label: string; children: React.ReactNode; open?: boolean }> = ({
  label,
  children,
  open,
}) => {
  const styles = useStyles();
  return (
    <details className={styles.disclosure} open={open}>
      <summary className={styles.summary}>{label}</summary>
      <div className={styles.disclosureBody}>{children}</div>
    </details>
  );
};

const UserMessage: React.FC<{ content: string }> = ({ content }) => {
  const styles = useStyles();
  const { instruction, document, comments, changes, files, selection } = splitUserMessage(content);
  return (
    <div className={styles.turn}>
      <div className={styles.user}>
        <MarkdownView text={instruction} />
      </div>
      {document ? (
        <Disclosure
          label={document.startsWith("本文なし") ? "本文は渡っていません" : "文書全体を添付"}
        >
          {document}
        </Disclosure>
      ) : null}
      {comments ? <Disclosure label="コメントを添付">{comments}</Disclosure> : null}
      {changes ? <Disclosure label="変更履歴を添付">{changes}</Disclosure> : null}
      {/* The text itself lives on the conversation, so this is the names only. */}
      {files ? <Disclosure label="資料ファイルを添付">{files}</Disclosure> : null}
      {selection ? (
        <Disclosure label={`選択 ${selection.length} 字を添付`}>{selection}</Disclosure>
      ) : null}
    </div>
  );
};

const AssistantMessage: React.FC<{
  content: string;
  reasoningContent: string;
  toolCalls?: StoredMessage["toolCalls"];
  streaming?: boolean;
}> = ({ content, reasoningContent, toolCalls = [], streaming }) => {
  const styles = useStyles();
  const showReasoning = Boolean(reasoningContent);
  const foreignNotice = foreignCharNoticeForAssistant(content, toolCalls);
  return (
    <div className={styles.turn}>
      {showReasoning ? (
        <Disclosure label={streaming ? "思考中…" : "思考を表示"} open={streaming || undefined}>
          {reasoningContent}
        </Disclosure>
      ) : null}
      {content || streaming || foreignNotice ? (
        <div className={styles.assistant}>
          {content || streaming ? (
            <>
              <MarkdownView text={content} />
              {streaming ? <span className={styles.caret} /> : null}
            </>
          ) : null}
          {foreignNotice ? (
            <Text size={200} className={styles.warning}>
              {foreignNotice}
            </Text>
          ) : null}
        </div>
      ) : null}
      {!streaming && toolCalls.length ? (
        <div className={styles.chips}>
          {toolCalls.map((call) => (
            <Badge key={call.id} appearance="tint" color="informative">
              {describeToolCall(call.function.name, call.function.arguments)}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const SearchHits: React.FC<{ hits: SearchHit[]; label: string }> = ({ hits, label }) => {
  const styles = useStyles();
  return (
    <Disclosure label={label}>
      <div className={styles.turn}>
        {hits.map((hit) => (
          <div className={styles.hit} key={`${hit.url}-${hit.title}`}>
            <Text weight="semibold" size={200}>
              {hit.title}
            </Text>
            {hit.url ? <CollapsedLink href={hit.url} /> : null}
            {hit.content ? (
              <Text size={200} className={styles.muted}>
                {hit.content}
              </Text>
            ) : null}
          </div>
        ))}
        <Text size={200} className={styles.muted}>
          「これをコメントにして」のように続けて指示できます。
        </Text>
      </div>
    </Disclosure>
  );
};

const ToolMessage: React.FC<{ message: StoredMessage; name: string }> = ({ message, name }) => {
  const styles = useStyles();
  if (message.content.startsWith("エラー")) {
    return (
      <div className={styles.chips}>
        <Badge appearance="tint" color="danger">
          {message.content}
        </Badge>
      </div>
    );
  }
  if (name === TOOL_SEARCH || name === TOOL_SEARCH_INDEX) {
    const hits = parseHits(message.content);
    if (hits?.length) {
      const label =
        name === TOOL_SEARCH_INDEX ? `索引結果 ${hits.length} 件` : `検索結果 ${hits.length} 件`;
      return <SearchHits hits={hits} label={label} />;
    }
  }
  return null;
};

export type ChatDraft = {
  content: string;
  reasoningContent: string;
};

export type ChatPaneProps = {
  messages: StoredMessage[];
  draft?: ChatDraft | null;
};

const ChatPane: React.FC<ChatPaneProps> = ({ messages, draft }) => {
  const styles = useStyles();
  const names = React.useMemo(() => toolNameById(messages), [messages]);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const streaming = Boolean(draft);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, draft?.content, draft?.reasoningContent]);

  if (!messages.length && !streaming) {
    return (
      <div className={styles.root} data-guri="chat">
        <div className={styles.empty}>
          <Text block>本文を選んで、やりたいことをそのまま書いてください。</Text>
          <Text block size={200}>
            例:「この条項を点検してコメントして」「選択部分を 12pt
            の太字にして」「請求の趣旨を起案して」
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root} data-guri="chat">
      {messages.map((message) => {
        if (message.role === "user") {
          return <UserMessage key={message.id} content={message.content} />;
        }
        if (message.role === "assistant") {
          return (
            <AssistantMessage
              key={message.id}
              content={message.content}
              reasoningContent={message.reasoningContent}
              toolCalls={message.toolCalls}
            />
          );
        }
        return (
          <ToolMessage
            key={message.id}
            message={message}
            name={names.get(message.toolCallId) || ""}
          />
        );
      })}
      {draft ? (
        <AssistantMessage
          content={draft.content}
          reasoningContent={draft.reasoningContent}
          streaming
        />
      ) : null}
      <div ref={bottomRef} />
    </div>
  );
};

export default ChatPane;
