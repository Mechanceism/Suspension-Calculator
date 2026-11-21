/**
 * Undo / redo for every design edit (Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z).
 *
 * The store is watched: when the design changes, the design as it was before is pushed onto the
 * undo stack. Quick bursts (typing, nudging, slider steps within 600 ms) count as one step, and a
 * whole drag counts as one step (recorded when the drag ends). Switching the active corner is not an
 * edit (the saved design is unchanged). New / Open start a fresh history.
 */
import { create } from 'zustand';
import { useApp, pickDesign, type DesignState } from './store';
import { designSnapshot } from './project';

const LIMIT = 200;
const BURST_MS = 600;

export const useHistory = create<{ canUndo: boolean; canRedo: boolean }>(() => ({ canUndo: false, canRedo: false }));

const past: DesignState[] = [];
const future: DesignState[] = [];
let committed: DesignState | null = null;
let committedKey = '';
let lastChange = 0;
let restoring = false;
let started = false;

const publish = () => useHistory.setState({ canUndo: past.length > 0, canRedo: future.length > 0 });

function snapshot(): { d: DesignState; key: string } {
  const d = pickDesign(useApp.getState());
  return { d, key: designSnapshot(d) };
}

/** Start watching the store (once). */
export function initHistory(): void {
  if (started) return;
  started = true;
  ({ d: committed, key: committedKey } = snapshot());
  const keys = Object.keys(committed) as (keyof DesignState)[];
  useApp.subscribe((s, prev) => {
    if (restoring || s.interacting) return;
    const dragEnded = prev.interacting && !s.interacting;
    if (!dragEnded && keys.every((k) => s[k] === prev[k])) return;
    const { d, key } = snapshot();
    if (key === committedKey) { committed = d; return; } // e.g. corner switch: same design
    const now = performance.now();
    if (dragEnded || now - lastChange > BURST_MS || !past.length) {
      past.push(committed!);
      if (past.length > LIMIT) past.shift();
    }
    future.length = 0;
    committed = d;
    committedKey = key;
    lastChange = dragEnded ? 0 : now;
    publish();
  });
}

function restore(d: DesignState) {
  restoring = true;
  try { useApp.setState({ ...d, selection: null }); } finally { restoring = false; }
  committed = d;
  committedKey = designSnapshot(d);
  lastChange = 0;
  publish();
}

export function undo(): void {
  const d = past.pop();
  if (!d || !committed) return;
  future.push(committed);
  restore(d);
}

export function redo(): void {
  const d = future.pop();
  if (!d || !committed) return;
  past.push(committed);
  restore(d);
}

/** Forget the history (after New / Open). */
export function resetHistory(): void {
  past.length = 0;
  future.length = 0;
  ({ d: committed, key: committedKey } = snapshot());
  lastChange = 0;
  publish();
}
