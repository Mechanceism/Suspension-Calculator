/**
 * File menu actions: New, Save, Save as, Recents, and Export / Import in three parts: model and tests,
 * model only, tests only. Plus settings export / import (preferences, not the project).
 * Unsaved changes are tracked per part (model, tests) since the last save or export of that part.
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp, defaultDesign, pickDesign } from './store';
import { serializeProject, importProject, modelSnapshot, testsSnapshot, serializeTests, importTests } from './project';
import { saveLayout, getLayout, touchLayout } from './library';
import { resetHistory } from './history';
import { exportSettingsFile, applySettingsFile } from './settingsFile';
import { newTestId } from './tests';
import { create } from 'zustand';

/** An import waiting for the user's answer (it replaces something). */
export const usePendingImport = create<{ file: File | null; part: Part | 'settings' | 'tire' | 'aero' }>(() => ({ file: null, part: 'all' }));
/** Run after the next successful save (Save as dialog → then import). */
let afterSave: (() => void) | null = null;
export const setAfterSave = (fn: (() => void) | null) => { afterSave = fn; };

export type Part = 'all' | 'model' | 'tests';

/** Which parts differ from their last save / export. */
export function useDirtyParts(): { model: boolean; tests: boolean } {
  const design = useApp(useShallow(pickDesign));
  const savedModel = useApp((s) => s.savedSnapshot);
  const savedTests = useApp((s) => s.savedTests);
  return useMemo(() => ({
    model: modelSnapshot(design) !== savedModel,
    tests: testsSnapshot(design) !== (savedTests ?? testsSnapshot({ tests: [] })),
  }), [design, savedModel, savedTests]);
}

/** True when anything is unsaved. */
export function useDirty(): boolean {
  const d = useDirtyParts();
  return d.model || d.tests;
}

const partsText = (d: { model: boolean; tests: boolean }) => [d.model && 'the model', d.tests && 'the tests'].filter(Boolean).join(' and ');
function confirmDiscard(dirty: boolean | { model: boolean; tests: boolean }, what: { model: boolean; tests: boolean } = { model: true, tests: true }): boolean {
  const d = typeof dirty === 'boolean' ? { model: dirty, tests: dirty } : dirty;
  const lose = { model: d.model && what.model, tests: d.tests && what.tests };
  if (!lose.model && !lose.tests) return true;
  return window.confirm(`Discard unsaved changes to ${partsText(lose)}? (Not saved or exported since the last change.)`);
}

const currentSnapshots = () => { const d = pickDesign(useApp.getState()); return { model: modelSnapshot(d), tests: testsSnapshot(d) }; };

export function newLayout(dirty: boolean | { model: boolean; tests: boolean }): void {
  if (!confirmDiscard(dirty)) return;
  const d = defaultDesign();
  useApp.getState().applyDesign(d, null, modelSnapshot(d), testsSnapshot(d));
  resetHistory();
  useApp.getState().notify('New layout (default sample C).');
}

export function saveAs(name: string): void {
  const s = useApp.getState();
  const design = pickDesign(s);
  const file = serializeProject(design, name);
  if (!saveLayout(file)) { s.notify('Could not save: browser storage is unavailable. Use Export instead.', 'error'); return; }
  const snap = currentSnapshots();
  s.markSaved(name, snap.model, snap.tests);
  s.set('saveAsOpen', false);
  s.notify(`Saved “${name}” (model and tests).`);
  const next = afterSave;
  afterSave = null;
  next?.();
}

export function save(): void {
  const s = useApp.getState();
  if (s.fileName) saveAs(s.fileName);
  else s.set('saveAsOpen', true);
}

export function openLayout(name: string, dirty: boolean | { model: boolean; tests: boolean }): void {
  if (!confirmDiscard(dirty)) return;
  const s = useApp.getState();
  const entry = getLayout(name);
  if (!entry) { s.notify(`“${name}” is no longer in Recents.`, 'error'); return; }
  try {
    const r = importProject(entry.data);
    s.applyDesign(r.design, name, modelSnapshot(r.design), testsSnapshot(r.design));
    resetHistory();
    touchLayout(name);
    s.notify(r.warnings.length ? `Opened “${name}” with notes:\n${r.warnings.join('\n')}` : `Opened “${name}”.`, r.warnings.length ? 'warn' : 'info');
  } catch (e) {
    s.notify(`Could not open “${name}”: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

export function download(data: unknown, filename: string): string {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[\\/:*?"<>|]+/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return a.download;
}

/** Export model and tests, the model only, or the tests only. */
export function exportParts(part: Part): void {
  const s = useApp.getState();
  const name = s.fileName ?? 'Untitled layout';
  const d = pickDesign(s);
  const snap = currentSnapshots();
  if (part === 'tests') {
    const f = download(serializeTests(d, name), `${name} tests.susp-tests.json`);
    s.markSaved(s.fileName, undefined, snap.tests);
    s.notify(`Exported ${d.tests.length} test(s) to “${f}”.`);
    return;
  }
  const file = serializeProject(d, name, { tests: part === 'all' });
  const f = download(file, `${name}${part === 'model' ? ' model' : ''}.susp.json`);
  s.markSaved(s.fileName, snap.model, part === 'all' ? snap.tests : undefined);
  s.notify(`Exported ${part === 'all' ? 'model and tests' : 'the model'} to “${f}” (file format v${file.formatVersion}, app ${file.appVersion}).`);
}

/**
 * Import model and tests, the model only (keeps the current tests), or the tests only (replace the
 * current tests). The user has already agreed to replace them (import prompt).
 */
export async function importParts(file: File, part: Part): Promise<void> {
  const s = useApp.getState();
  try {
    const data = JSON.parse(await file.text()) as unknown;
    if (part === 'tests') {
      const r = importTests(data);
      if (!r.tests.length) { s.notify(`No tests in ${file.name}.`, 'warn'); return; }
      const incoming = r.tests.map((t) => ({ ...t, id: newTestId('test') }));
      s.updateTests(() => incoming);
      s.set('activeTestId', incoming[0]?.id ?? null);
      // Imported tests count as unsaved until saved / exported.
      s.markSaved(s.fileName, undefined, '');
      s.notify(r.warnings.length ? `Imported ${incoming.length} test(s) with notes:\n${r.warnings.join('\n')}` : `Imported ${incoming.length} test(s), replacing the current tests.`, r.warnings.length ? 'warn' : 'info');
      return;
    }
    const r = importProject(data);
    const keepTests = part === 'model';
    const design = keepTests ? { ...r.design, tests: s.tests } : r.design;
    // Imported parts count as unsaved in this browser until saved; kept tests keep their saved state.
    s.applyDesign(design, r.name, null, keepTests ? s.savedTests : null);
    resetHistory();
    s.notify(
      r.warnings.length ? `Imported “${r.name}” (${keepTests ? 'model only' : 'model and tests'}) with notes:\n${r.warnings.join('\n')}` : `Imported “${r.name}” (${keepTests ? 'model only, current tests kept' : 'model and tests'}). Save to add it to Recents.`,
      r.warnings.length ? 'warn' : 'info',
    );
  } catch (e) {
    s.notify(`Could not import ${file.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

export function exportSettings(): void {
  const f = download(exportSettingsFile(), 'Suspension Calculator settings.susp-settings.json');
  useApp.getState().notify(`Exported settings to “${f}”.`);
}

export async function importSettings(file: File): Promise<void> {
  try {
    const notes = applySettingsFile(JSON.parse(await file.text()));
    useApp.getState().notify(notes.length ? `Imported settings with notes:\n${notes.join('\n')}` : 'Imported settings.', notes.length ? 'warn' : 'info');
  } catch (e) {
    useApp.getState().notify(`Could not import ${file.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}
