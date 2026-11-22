import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { listLayouts, removeLayout, hasLayout, type LibraryEntry } from '../library';
import { useDirtyParts, newLayout, save, saveAs, openLayout, exportParts, importParts, exportSettings, importSettings, usePendingImport, setAfterSave, download, type Part } from '../fileActions';
import { exportSettingsFile } from '../settingsFile';
import { importTireFile } from '../tireActions';
import { openWizard } from './SetupWizard';

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export function FileMenu() {
  const [open, setOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [recents, setRecents] = useState<LibraryEntry[]>([]);
  const fileName = useApp((s) => s.fileName);
  const parts = useDirtyParts();
  const dirty = parts.model || parts.tests;
  const importInput = useRef<HTMLInputElement>(null);
  const settingsInput = useRef<HTMLInputElement>(null);
  const tireInput = useRef<HTMLInputElement>(null);
  const importPart = useRef<Part>('all');
  const pickImport = (part: Part) => { importPart.current = part; importInput.current?.click(); };
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setRecents(listLayouts());
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setOpen(false); setRecentsOpen(false); } };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const run = (fn: () => void) => () => { setOpen(false); setRecentsOpen(false); fn(); };

  return (
    <div className="file-menu" ref={root}>
      <button className={`menu-btn${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>File</button>
      <span className="file-title" title={dirty ? `Unsaved changes to ${[parts.model && 'the model', parts.tests && 'the tests'].filter(Boolean).join(' and ')} since the last save / export` : 'Saved'}>
        {fileName ?? 'Untitled'}
        {parts.model && <span className="dirty-dot"> • model</span>}
        {parts.tests && <span className="dirty-dot"> • tests</span>}
      </span>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={run(() => newLayout(parts))}>New (default layout)</button>
          <button role="menuitem" onClick={run(() => openWizard())} title="Enter your car step by step: easy values first, measuring tools included">Setup wizard</button>
          <button role="menuitem" onClick={run(save)}>Save<kbd>Ctrl+S</kbd></button>
          <button role="menuitem" onClick={run(() => useApp.getState().set('saveAsOpen', true))}>Save as…<kbd>Ctrl+Shift+S</kbd></button>
          <div className="menu-sub" onMouseEnter={() => setRecentsOpen(true)} onMouseLeave={() => setRecentsOpen(false)}>
            <button role="menuitem" aria-haspopup="menu" onClick={() => setRecentsOpen(!recentsOpen)}>Recents<span className="menu-arrow">▸</span></button>
            {recentsOpen && (
              <div className="menu submenu" role="menu">
                {recents.length === 0 && <div className="menu-empty">No saved layouts yet</div>}
                {recents.map((r) => (
                  <div key={r.name} className="menu-recent">
                    <button role="menuitem" onClick={run(() => openLayout(r.name, parts))}>
                      <span>{r.name}</span><span className="muted small-text">{when(r.savedAt)}</span>
                    </button>
                    <button
                      className="icon-btn" title={`Remove “${r.name}” from Recents`}
                      onClick={() => { if (window.confirm(`Delete “${r.name}” from this browser?`)) { removeLayout(r.name); setRecents(listLayouts()); } }}
                    >✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="menu-sep" />
          <div className="menu-head">Export to file</div>
          <button role="menuitem" onClick={run(() => exportParts('all'))}>Model and tests{parts.model || parts.tests ? <span className="dirty-dot">•</span> : null}</button>
          <button role="menuitem" onClick={run(() => exportParts('model'))}>Model only{parts.model ? <span className="dirty-dot">•</span> : null}</button>
          <button role="menuitem" onClick={run(() => exportParts('tests'))}>Tests only{parts.tests ? <span className="dirty-dot">•</span> : null}</button>
          <div className="menu-sep" />
          <div className="menu-head">Import from file</div>
          <button role="menuitem" onClick={run(() => pickImport('all'))} title="Replace the model and the tests">Model and tests</button>
          <button role="menuitem" onClick={run(() => pickImport('model'))} title="Replace the model, keep the current tests">Model only</button>
          <button role="menuitem" onClick={run(() => pickImport('tests'))} title="Replace the current tests with those from a tests or project file">Tests only</button>
          <button role="menuitem" onClick={run(() => tireInput.current?.click())} title="Use a fitted Magic Formula tire model (.tir file) for all four tires. Front and rear can differ: Optimize → Tire grip model">Tire (.tir)</button>
          <div className="menu-sep" />
          <div className="menu-head">Settings (units, view, pass-rule profiles)</div>
          <button role="menuitem" onClick={run(exportSettings)}>Export settings</button>
          <button role="menuitem" onClick={run(() => settingsInput.current?.click())}>Import settings</button>
        </div>
      )}
      <input
        ref={importInput} type="file" accept=".json,application/json" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) usePendingImport.setState({ file: f, part: importPart.current }); e.target.value = ''; }}
      />
      <input
        ref={settingsInput} type="file" accept=".json,application/json" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) usePendingImport.setState({ file: f, part: 'settings' }); e.target.value = ''; }}
      />
      <input
        ref={tireInput} type="file" accept=".tir,.TIR,.txt" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) usePendingImport.setState({ file: f, part: 'tire' }); e.target.value = ''; }}
      />
      <SaveAsDialog />
      <ImportPrompt />
    </div>
  );
}

function SaveAsDialog() {
  const openDialog = useApp((s) => s.saveAsOpen);
  const fileName = useApp((s) => s.fileName);
  const set = useApp((s) => s.set);
  const [name, setName] = useState('');
  useEffect(() => { if (openDialog) setName(fileName ?? 'My layout'); }, [openDialog, fileName]);
  if (!openDialog) return null;
  const cancel = () => { setAfterSave(null); set('saveAsOpen', false); };
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    if (n !== fileName && hasLayout(n) && !window.confirm(`“${n}” already exists. Replace it?`)) return;
    saveAs(n);
  };
  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div className="modal" role="dialog" aria-label="Save layout as" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Save layout as</h3>
        <input
          autoFocus className="text-input" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') cancel(); }}
        />
        <p className="hint">Saved in this browser and listed under File → Recents. Use Export to share or back up as a file.</p>
        <div className="modal-actions">
          <button onClick={cancel}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!name.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}

const REPLACES: Record<Part | 'settings' | 'tire', string> = {
  all: 'your current model and tests', model: 'your current model (the tests stay)', tests: 'your current tests', settings: 'your current settings (units, view options, pass-rule profiles)',
  tire: 'the tire grip model of all four tires (the rest of the model stays)',
};

/** Before an import replaces something: save first, save as, overwrite, or cancel. */
function ImportPrompt() {
  const { file, part } = usePendingImport();
  const parts = useDirtyParts();
  if (!file) return null;
  const close = () => usePendingImport.setState({ file: null });
  const go = () => {
    close();
    if (part === 'settings') void importSettings(file);
    else if (part === 'tire') void importTireFile(file, 'both');
    else void importParts(file, part);
  };
  const unsaved = part === 'settings' ? false : part === 'tire' ? parts.model : (part !== 'tests' && parts.model) || (part !== 'model' && parts.tests);
  const saveFirst = () => {
    if (part === 'settings') { exportSettings(); go(); return; }
    const s = useApp.getState();
    if (s.fileName) { save(); go(); return; }
    setAfterSave(go);
    close();
    s.set('saveAsOpen', true);
  };
  const saveAsFirst = () => {
    if (part === 'settings') {
      const name = window.prompt('Save the current settings as:', 'My settings');
      if (!name?.trim()) return;
      download(exportSettingsFile(), `${name.trim()}.susp-settings.json`);
      go();
      return;
    }
    setAfterSave(go);
    close();
    useApp.getState().set('saveAsOpen', true);
  };
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" role="dialog" aria-label="Import" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Import “{file.name}”</h3>
        <p>This will replace {REPLACES[part]}.{unsaved ? ' You have unsaved changes there.' : ''}</p>
        <p className="hint">
          {part === 'settings'
            ? 'Save / Save as export the current settings to a file first.'
            : 'Save / Save as keep the current version in this browser (File → Recents) first.'}
        </p>
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button onClick={saveFirst}>Save</button>
          <button onClick={saveAsFirst}>Save as</button>
          <button className="primary" onClick={go}>Overwrite</button>
        </div>
      </div>
    </div>
  );
}

/** Short-lived message for saves, imports and their warnings. */
export function Notice() {
  const notice = useApp((s) => s.notice);
  const set = useApp((s) => s.set);
  useEffect(() => {
    if (!notice || notice.kind !== 'info') return;
    const t = setTimeout(() => set('notice', null), 3500);
    return () => clearTimeout(t);
  }, [notice, set]);
  if (!notice) return null;
  return (
    <div className={`notice notice-${notice.kind}`} role="status">
      <pre>{notice.text}</pre>
      <button className="icon-btn" onClick={() => set('notice', null)} title="Dismiss">✕</button>
    </div>
  );
}
