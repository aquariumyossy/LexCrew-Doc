import * as React from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { aboutCopy } from "../about";
import { uiPx } from "../uiFont";
import { CompactDialogClose, useCompactDialogStyles } from "./compactDialog";

const useStyles = makeStyles({
  heading: {
    margin: 0,
    color: tokens.colorNeutralForeground1,
    fontSize: uiPx(12),
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: uiPx(16),
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

export type AboutDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const AboutDialog: React.FC<AboutDialogProps> = ({ open, onOpenChange }) => {
  const styles = useStyles();
  const dialog = useCompactDialogStyles();
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface className={dialog.surface} aria-label={aboutCopy.title}>
        <DialogBody className={dialog.body}>
          <DialogTitle className={dialog.heading} action={<CompactDialogClose onClick={close} />}>
            {aboutCopy.title}
          </DialogTitle>
          <DialogContent className={dialog.scrollContent}>
            <div className={dialog.stack}>
              <Text className={styles.heading}>概要</Text>
              {aboutCopy.overview.map((paragraph) => (
                <Text key={paragraph} className={dialog.muted}>
                  {paragraph}
                </Text>
              ))}
              <Text className={styles.heading}>機能</Text>
              {aboutCopy.features.map((feature) => (
                <div key={feature.title} className={styles.item}>
                  <Text className={styles.heading}>{feature.title}</Text>
                  <Text className={dialog.muted}>{feature.body}</Text>
                </div>
              ))}
              <Text className={styles.heading}>ライセンス</Text>
              <Text className={dialog.muted}>{aboutCopy.licenseNote}</Text>
              {aboutCopy.licenses.map((row) => (
                <div key={row.name} className={styles.item}>
                  <Text className={dialog.muted}>
                    {row.name} — {row.license} — {row.copyright}
                  </Text>
                  {row.choice ? <Text className={dialog.muted}>{row.choice}</Text> : null}
                </div>
              ))}
              <Text className={styles.heading}>開発</Text>
              <Text className={dialog.muted}>{aboutCopy.credit}</Text>
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
