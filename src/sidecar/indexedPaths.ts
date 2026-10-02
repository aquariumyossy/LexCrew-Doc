import { indexedPathAllowed, rememberIndexedPath } from "../shared/indexedRead";

const allowed = new Set<string>();

export function noteIndexedHits(paths: string[]): void {
  for (const path of paths) {
    rememberIndexedPath(allowed, path);
  }
}

export function canReadIndexedPath(path: string): boolean {
  return indexedPathAllowed(path, allowed);
}

export function clearIndexedPaths(): void {
  allowed.clear();
}
