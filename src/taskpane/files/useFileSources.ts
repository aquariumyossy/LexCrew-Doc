import * as React from "react";
import { MAX_ATTACHED_FILES } from "../../shared/constants";
import { FileReadError, rejectReason, tooManyFiles } from "../../shared/fileExtract";
import {
  CommittedFile,
  FileIdentity,
  FileSource,
  FileText,
  sameFile,
} from "../../shared/fileSource";
import { readFile } from "./read";

/* global AbortSignal, AbortController, File */

let counter = 0;

function nextId(): string {
  counter += 1;
  return `f_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/** Reads the pages of a scan. Supplied by the caller so this file needs no LLM. */
export type OcrRunner = (
  file: File,
  pages: number,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal
) => Promise<FileText>;

/**
 * A `FileReadError` was written for this badge, so it is shown as it stands.
 * Anything else got here by surprise and is shown with its own words: telling
 * the user the wrong thing is worse than telling them something unpolished.
 */
function readErrorMessage(error: unknown): string {
  if (error instanceof FileReadError) {
    return error.message;
  }
  const detail = error instanceof Error && error.message ? error.message : String(error);
  return detail ? `読み取りに失敗しました（${detail}）` : "読み取りに失敗しました。";
}

export type FileSourcesApi = {
  sources: FileSource[];
  /** Adds what it can read and reports the rest; a refused file gets no badge. */
  add: (files: File[]) => void;
  /** Takes a badge away, stopping the read behind it. */
  remove: (id: string) => void;
  /** Forgets every badge, stopping every read. For switching conversations. */
  clear: () => void;
  /** Drops the badges a successful send has taken over. */
  consume: (ids: string[]) => void;
};

export function useFileSources(options: {
  /** Files the conversation already keeps; they share the count and the dedup. */
  attached: CommittedFile[];
  onReject: (message: string) => void;
  ocr: OcrRunner;
}): FileSourcesApi {
  const [sources, setSources] = React.useState<FileSource[]>([]);
  // A ref beside the state so admitting a second drop sees the first one, which
  // a batch of `setState` calls in one tick would not.
  const known = React.useRef<FileSource[]>([]);
  const aborts = React.useRef(new Map<string, AbortController>());
  const latest = React.useRef(options);
  latest.current = options;

  const apply = React.useCallback((next: (current: FileSource[]) => FileSource[]) => {
    known.current = next(known.current);
    setSources(known.current);
  }, []);

  /** A read that finishes after its badge was taken away must not bring it back. */
  const put = React.useCallback(
    (source: FileSource) => {
      apply((current) =>
        current.some((row) => row.id === source.id)
          ? current.map((row) => (row.id === source.id ? source : row))
          : current
      );
    },
    [apply]
  );

  const remove = React.useCallback(
    (id: string) => {
      aborts.current.get(id)?.abort();
      aborts.current.delete(id);
      apply((current) => current.filter((row) => row.id !== id));
    },
    [apply]
  );

  const clear = React.useCallback(() => {
    for (const controller of aborts.current.values()) {
      controller.abort();
    }
    aborts.current.clear();
    apply(() => []);
  }, [apply]);

  const consume = React.useCallback(
    (ids: string[]) => {
      const gone = new Set(ids);
      apply((current) => current.filter((row) => !gone.has(row.id)));
    },
    [apply]
  );

  const ingest = React.useCallback(
    async (base: { id: string; name: string } & FileIdentity, file: File, ac: AbortController) => {
      try {
        const read = await readFile(file);
        ac.signal.throwIfAborted();
        if (read.status === "text") {
          put({ ...base, status: "ready", ...read.text });
          return;
        }
        put({ ...base, status: "ocr", done: 0, total: read.pages });
        const text = await latest.current.ocr(
          file,
          read.pages,
          (done, total) => put({ ...base, status: "ocr", done, total }),
          ac.signal
        );
        ac.signal.throwIfAborted();
        put({ ...base, status: "ready", ...text });
      } catch (error) {
        // Taking the badge away is not a failure worth reporting on it.
        if (!ac.signal.aborted) {
          put({ ...base, status: "error", message: readErrorMessage(error) });
        }
      } finally {
        aborts.current.delete(base.id);
      }
    },
    [put]
  );

  const add = React.useCallback(
    (files: File[]) => {
      const reject = latest.current.onReject;
      for (const file of files) {
        const reason = rejectReason(file);
        if (reason) {
          reject(`${file.name}: ${reason}`);
          continue;
        }
        const attached = latest.current.attached;
        if (tooManyFiles(known.current.length + attached.length, 1)) {
          reject(`添付できるのは ${MAX_ATTACHED_FILES} 件までです。`);
          return;
        }
        const base = {
          id: nextId(),
          name: file.name,
          size: file.size,
          mtime: file.lastModified,
        };
        if ([...known.current, ...attached].some((row) => sameFile(base, row))) {
          reject(`${file.name} はすでに読み込んでいます。`);
          continue;
        }
        apply((current) => [...current, { ...base, status: "extracting" }]);
        const ac = new AbortController();
        aborts.current.set(base.id, ac);
        void ingest(base, file, ac);
      }
    },
    [apply, ingest]
  );

  return { sources, add, remove, clear, consume };
}
