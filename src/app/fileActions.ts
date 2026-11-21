/** File menu actions: New, Save, Save as, Recents, Import, Export. */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp, defaultDesign, pickDesign } from './store';
import { serializeProject, importProject, designSnapshot } from './project';
import { saveLayout, getLayout, touchLayout } from './library';
import { resetHistory } from './history';

/** True when the design differs from what was last saved / opened. */
export function useDirty(): boolean {
  const design = useApp(useShallow(pickDesign));
  const saved = useApp((s) => s.savedSnapshot);
  return useMemo(() => designSnapshot(design) !== saved, [design, saved]);
}

const confirmDiscard = (dirty: boolean) => !dirty || window.confirm('Discard unsaved changes to this layout?');

export function newLayout(dirty: boolean): void {
  if (!confirmDiscard(dirty)) return;
  const d = defaultDesign();
  useApp.getState().applyDesign(d, null, designSnapshot(d));
  resetHistory();
  useApp.getState().notify('New layout (default sample C).');
}

export function saveAs(name: string): void {
  const s = useApp.getState();
  const design = pickDesign(s);
  const file = serializeProject(design, name);
  if (!saveLayout(file)) { s.notify('Could not save: browser storage is unavailable. Use Export instead.', 'error'); return; }
  s.markSaved(name, designSnapshot(design));
  s.set('saveAsOpen', false);
  s.notify(`Saved “${name}”.`);
}

export function save(): void {
  const s = useApp.getState();
  if (s.fileName) saveAs(s.fileName);
  else s.set('saveAsOpen', true);
}

export function openLayout(name: string, dirty: boolean): void {
  if (!confirmDiscard(dirty)) return;
  const s = useApp.getState();
  const entry = getLayout(name);
  if (!entry) { s.notify(`“${name}” is no longer in Recents.`, 'error'); return; }
  try {
    const r = importProject(entry.data);
    s.applyDesign(r.design, name, designSnapshot(r.design));
    resetHistory();
    touchLayout(name);
    s.notify(r.warnings.length ? `Opened “${name}” with notes:\n${r.warnings.join('\n')}` : `Opened “${name}”.`, r.warnings.length ? 'warn' : 'info');
  } catch (e) {
    s.notify(`Could not open “${name}”: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

export function exportLayout(): void {
  const s = useApp.getState();
  const name = s.fileName ?? 'Untitled layout';
  const file = serializeProject(pickDesign(s), name);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.susp.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  s.notify(`Exported “${a.download}” (file format v${file.formatVersion}, app ${file.appVersion}).`);
}

export async function importLayoutFile(file: File, dirty: boolean): Promise<void> {
  const s = useApp.getState();
  if (!confirmDiscard(dirty)) return;
  try {
    const r = importProject(JSON.parse(await file.text()));
    // Imported layouts open as unsaved in this browser until saved.
    s.applyDesign(r.design, r.name, null);
    resetHistory();
    s.notify(
      r.warnings.length ? `Imported “${r.name}” with notes:\n${r.warnings.join('\n')}` : `Imported “${r.name}”. Save to add it to Recents.`,
      r.warnings.length ? 'warn' : 'info',
    );
  } catch (e) {
    s.notify(`Could not import ${file.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}
