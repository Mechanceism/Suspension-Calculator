/**
 * Snapshots (R9): other designs to compare the current one with. A snapshot is a whole design — the model,
 * its tests and their last results (scores) — kept as its own model-and-tests file, not inside the current
 * project. Take one (File → Take snapshot: the current design is downloaded as a file and added to the
 * list) or import any project file as one. The list lasts while the page is open; one of them is the one
 * compared (Compare tab).
 */
import { create } from 'zustand';
import { useApp, pickDesign, type DesignState } from './store';
import { serializeProject, importProject } from './project';
import { currentResults, download } from './fileActions';
import type { SavedResult } from './savedResults';

export interface Snapshot {
  id: string;
  /** The design's name (the project's, or the file's). */
  name: string;
  /** The file it was saved to or read from. */
  fileName: string;
  /** When it was taken (or the file saved), ISO. */
  takenAt: string;
  /** The model and its tests, as the file holds them. */
  design: DesignState;
  /** Its tests' last results (scores) saved with it, by test id. */
  results: Record<string, SavedResult>;
  source: 'taken' | 'imported';
}

interface SnapshotState {
  list: Snapshot[];
  /** The snapshot compared with the current design. */
  activeId: string | null;
}
export const useSnapshots = create<SnapshotState>(() => ({ list: [], activeId: null }));

let counter = 0;
const add = (sn: Omit<Snapshot, 'id'>): Snapshot => {
  const full = { ...sn, id: `snap-${Date.now().toString(36)}-${(counter++).toString(36)}` };
  useSnapshots.setState((st) => ({ list: [...st.list, full], activeId: full.id }));
  return full;
};

const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;

/** The current design as a snapshot: downloaded as a model-and-tests file (with the results) and added to the list. */
export function takeSnapshot(): Snapshot {
  const s = useApp.getState();
  const name = s.fileName ?? 'Untitled layout';
  const now = new Date();
  const file = serializeProject(pickDesign(s), name, { tests: true, results: currentResults() });
  const fileName = download(file, `${name} snapshot ${stamp(now)}.susp.json`);
  // What the snapshot holds is what the file holds: read back from it.
  const r = importProject(JSON.parse(JSON.stringify(file)));
  const sn = add({ name, fileName, takenAt: now.toISOString(), design: r.design, results: r.results, source: 'taken' });
  const n = Object.keys(r.results).length;
  s.notify(`Snapshot “${name}” taken (${n ? `${n} test result${n === 1 ? '' : 's'} saved with it` : 'no up-to-date test results to save with it'}), saved as “${fileName}”. Compare it in the Compare tab.`);
  return sn;
}

/** Any project file as a snapshot. */
export async function importSnapshot(file: File): Promise<Snapshot | null> {
  const s = useApp.getState();
  try {
    const data = JSON.parse(await file.text()) as Record<string, unknown>;
    const r = importProject(data);
    const sn = add({ name: r.name, fileName: file.name, takenAt: typeof data.savedAt === 'string' ? data.savedAt : new Date().toISOString(), design: r.design, results: r.results, source: 'imported' });
    s.notify(r.warnings.length ? `Imported “${r.name}” as a snapshot with notes:\n${r.warnings.join('\n')}` : `Imported “${r.name}” as a snapshot. Compare it in the Compare tab.`, r.warnings.length ? 'warn' : 'info');
    return sn;
  } catch (e) {
    s.notify(`Could not import ${file.name} as a snapshot: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return null;
  }
}

export function removeSnapshot(id: string) {
  useSnapshots.setState((st) => {
    const list = st.list.filter((x) => x.id !== id);
    return { list, activeId: st.activeId === id ? (list[list.length - 1]?.id ?? null) : st.activeId };
  });
}
export const setActiveSnapshot = (id: string | null) => useSnapshots.setState({ activeId: id });
export const activeSnapshot = (): Snapshot | null => { const st = useSnapshots.getState(); return st.list.find((x) => x.id === st.activeId) ?? null; };
