/**
 * In-app layout library (File → Save / Save as / Recents), kept in this browser's local storage.
 * Export/Import move layouts between browsers, machines and people as files.
 */
import type { ProjectFile } from './project';

const KEY = 'suspension-calculator:library:v1';

export interface LibraryEntry {
  name: string;
  savedAt: string;
  /** Last opened or saved — used to order Recents. */
  usedAt: string;
  data: ProjectFile;
}

function read(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as LibraryEntry[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: LibraryEntry[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export const listLayouts = (): LibraryEntry[] => read().sort((a, b) => b.usedAt.localeCompare(a.usedAt));

export const hasLayout = (name: string): boolean => read().some((e) => e.name === name);

/** Save (or overwrite) a layout. Returns false if storage isn't available. */
export function saveLayout(file: ProjectFile): boolean {
  const now = new Date().toISOString();
  const list = read().filter((e) => e.name !== file.name);
  list.push({ name: file.name, savedAt: now, usedAt: now, data: file });
  return write(list);
}

export function touchLayout(name: string): void {
  const list = read();
  const e = list.find((x) => x.name === name);
  if (e) { e.usedAt = new Date().toISOString(); write(list); }
}

export function removeLayout(name: string): void {
  write(read().filter((e) => e.name !== name));
}

export function getLayout(name: string): LibraryEntry | undefined {
  return read().find((e) => e.name === name);
}
