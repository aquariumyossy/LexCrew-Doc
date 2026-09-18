import * as React from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";

/** Shared chrome for history, settings, and Argos dialogs. */
export const useCompactDialogStyles = makeStyles({
  surface: {
    maxWidth: "100%",
    width: "calc(100vw - 16px)",
    padding: "8px",
    fontSize: "12px",
    lineHeight: "16px",
    "& .fui-DialogBody": {
      padding: "0",
      gap: "6px",
    },
    "& .fui-DialogContent": {
      padding: "0",
      margin: "0",
    },
    "& .fui-DialogTitle": {
      fontSize: "11px",
      lineHeight: "16px",
      fontWeight: tokens.fontWeightRegular,
      color: tokens.colorNeutralForeground2,
    },
    "& .fui-Button": {
      fontSize: "12px",
    },
    "& .fui-Button__icon": {
      fontSize: "14px",
      width: "14px",
      height: "14px",
    },
    "& .fui-Button__icon svg": {
      width: "14px",
      height: "14px",
      fontSize: "14px",
    },
    "& .fui-Field": {
      gap: "2px",
    },
    "& .fui-Label, & .fui-Field__label": {
      fontSize: "12px",
      lineHeight: "16px",
    },
    "& .fui-Field__hint": {
      fontSize: "11px",
      lineHeight: "16px",
    },
    "& .fui-Input": {
      minHeight: "24px",
      fontSize: "12px",
    },
    "& .fui-Input__input": {
      fontSize: "12px",
    },
    "& .fui-Radio, & .fui-Radio__label": {
      fontSize: "12px",
      lineHeight: "16px",
    },
    "& .fui-RadioGroup": {
      gap: "4px",
    },
    "& .fui-Text": {
      fontSize: "12px",
      lineHeight: "16px",
    },
  },
  body: {
    gap: "6px",
    padding: "0",
  },
  heading: {
    fontSize: "11px",
    lineHeight: "16px",
    fontWeight: tokens.fontWeightRegular,
    color: tokens.colorNeutralForeground2,
    whiteSpace: "normal",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    minHeight: 0,
    overflow: "hidden",
    padding: "0",
    margin: "0",
  },
  scrollContent: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    minHeight: 0,
    maxHeight: "70vh",
    overflowY: "auto",
    padding: "0",
    margin: "0",
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    alignItems: "center",
  },
  muted: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    lineHeight: "16px",
  },
});

export const CompactDialogClose: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <Button
    appearance="subtle"
    size="small"
    icon={<DismissRegular />}
    aria-label="閉じる"
    onClick={onClick}
  />
);
