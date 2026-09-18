import * as React from "react";
import { Link, makeStyles, tokens } from "@fluentui/react-components";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { argosScopeChipLabel } from "../../shared/argos";

const useStyles = makeStyles({
  root: {
    overflowWrap: "anywhere",
    wordBreak: "break-word",
    "& > :first-child": {
      marginTop: 0,
    },
    "& > :last-child": {
      marginBottom: 0,
    },
    "& h1, & h2, & h3, & h4, & h5, & h6": {
      marginTop: "0.7em",
      marginBottom: "0.35em",
      lineHeight: 1.35,
      color: tokens.colorBrandForeground1,
      fontWeight: tokens.fontWeightSemibold,
    },
    "& h1": { fontSize: "16px" },
    "& h2": { fontSize: "15px" },
    "& h3": { fontSize: "14px" },
    "& h4, & h5, & h6": { fontSize: "13px" },
    "& p": {
      marginTop: 0,
      marginBottom: "0.55em",
    },
    "& ul, & ol": {
      marginTop: 0,
      marginBottom: "0.55em",
      paddingLeft: "1.35em",
    },
    "& li": {
      margin: "2px 0",
    },
    "& li > p": {
      margin: 0,
    },
    "& blockquote": {
      margin: "0 0 0.55em",
      paddingLeft: "8px",
      borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
      color: tokens.colorNeutralForeground2,
    },
    "& hr": {
      border: "none",
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      margin: "8px 0",
    },
    "& code": {
      fontFamily: 'Consolas, "Yu Gothic UI", monospace',
      fontSize: "12px",
      backgroundColor: tokens.colorBrandBackground2,
      padding: "0 4px",
      borderRadius: "3px",
    },
    "& pre": {
      overflowX: "auto",
      backgroundColor: tokens.colorBrandBackground2,
      padding: "8px",
      borderRadius: "6px",
      margin: "8px 0",
    },
    "& pre code": {
      backgroundColor: "transparent",
      padding: 0,
    },
    "& table": {
      borderCollapse: "collapse",
      fontSize: "12px",
      width: "100%",
    },
    "& th, & td": {
      border: `1px solid ${tokens.colorBrandStroke2}`,
      padding: "4px 6px",
      verticalAlign: "top",
    },
    "& th": {
      backgroundColor: tokens.colorBrandBackground2,
      color: tokens.colorBrandForeground1,
      textAlign: "left",
      fontWeight: tokens.fontWeightSemibold,
    },
    "& a": {
      color: tokens.colorBrandForeground1,
    },
  },
  tableWrap: {
    overflowX: "auto",
    maxWidth: "100%",
    margin: "8px 0",
  },
  foldedLink: {
    display: "inline-block",
    verticalAlign: "baseline",
    maxWidth: "100%",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    wordBreak: "break-all",
  },
  summary: {
    cursor: "pointer",
  },
});

function isWebHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function isLocalHref(href: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(href) ||
    href.startsWith("\\\\") ||
    href.startsWith("mailfolder:") ||
    href.startsWith("file:")
  );
}

function hostLabel(href: string): string {
  if (isLocalHref(href)) {
    return argosScopeChipLabel(href);
  }
  try {
    return new URL(href).hostname.replace(/^www\./, "") || "リンク";
  } catch {
    return "リンク";
  }
}

function childText(node: React.ReactNode): string {
  return React.Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
        return childText(child.props.children);
      }
      return "";
    })
    .join("");
}

export const CollapsedLink: React.FC<{ href: string; label?: string }> = ({ href, label }) => {
  const styles = useStyles();
  const web = isWebHref(href);
  return (
    <details className={styles.foldedLink}>
      <summary className={styles.summary}>{label || hostLabel(href)}</summary>
      {web ? (
        <Link href={href} target="_blank" rel="noreferrer">
          {href}
        </Link>
      ) : (
        <span>{href}</span>
      )}
    </details>
  );
};

function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  if (!href || (!isWebHref(href) && !isLocalHref(href))) {
    return <>{children}</>;
  }
  const label = childText(children).trim();
  const fold = !label || label === href;
  return <CollapsedLink href={href} label={fold ? undefined : label} />;
}

export type MarkdownViewProps = {
  text: string;
};

const MarkdownView: React.FC<MarkdownViewProps> = ({ text }) => {
  const styles = useStyles();
  if (!text) {
    return null;
  }
  return (
    <div className={styles.root} data-guri="markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
          img: ({ alt, src }) => <span>{alt || src || "画像"}</span>,
          table: ({ children }) => (
            <div className={styles.tableWrap}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
};

export default MarkdownView;
