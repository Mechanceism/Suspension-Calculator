import { memo, useEffect, useState, type PointerEvent as RPointerEvent } from 'react';
import { useModel } from './useModel';
import { useApp, pickDesign } from './store';
import { modelSnapshot, testsSnapshot } from './project';
import { FileMenu, Notice } from './panels/FileMenu';
import { ViewMenu } from './panels/ViewMenu';
import { UnitsMenu } from './panels/UnitsMenu';
import { TestsSidebar as TestsSidebarRaw, TestResults as TestResultsRaw, TestViewBar as TestViewBarRaw, useActiveTest } from './panels/TestsPanels';
import { CourseViewport, useTestView, setTestView } from './viewport/CourseView';

// The Tests panels read the store themselves: memoized so the vehicle model changing (every playback
// frame) doesn't re-render them.
const TestsSidebar = memo(TestsSidebarRaw);
const TestResults = memo(TestResultsRaw);
const TestViewBar = memo(TestViewBarRaw);

/** Tests: the Static view (the car in place) or the Dynamic one (driving the course); one or the other. */
function TestsViewport({ model }: { model: ReturnType<typeof useVehicle> }) {
  const mode = useTestView((s) => s.mode);
  const test = useActiveTest();
  return (
    <div className="tests-viewport">
      <div className="view-mode-switch" role="tablist" aria-label="Test view">
        <button role="tab" aria-selected={mode === 'static'} className={`chip${mode === 'static' ? ' on' : ''}`} onClick={() => setTestView({ mode: 'static' })} title="The car in place, posed for the selected segment or the playback moment">Static</button>
        <button role="tab" aria-selected={mode === 'dynamic'} className={`chip${mode === 'dynamic' ? ' on' : ''}`} onClick={() => setTestView({ mode: 'dynamic' })} title="The course in 3D with the car driving it (Play)">Dynamic</button>
      </div>
      {mode === 'static' ? <VehicleViewport model={model} memoryKey="testsStatic" /> : <CourseViewport model={model} test={test} />}
    </div>
  );
}
import { HelpOverlay } from './panels/HelpOverlay';
import { BusyIndicator } from './panels/BusyIndicator';
import { SetupWizard } from './panels/SetupWizard';
import { initHistory, undo, redo, useHistory } from './history';
import { initHeldDimensions } from './heldDimensions';
import { save, useDirty } from './fileActions';
import { Viewport } from './viewport/Viewport';
import { LeftSidebar } from './panels/LeftSidebar';
import { MotionBar } from './panels/MotionBar';
import { Readout } from './panels/Readout';
import { Plots } from './panels/Plots';
import { useVehicle } from './useVehicle';
import { VehicleViewport } from './viewport/VehicleView';
import { switchWorkspace } from './viewport/SafeHtml';
import { VehicleSidebar, VehicleResults, VehicleMotionBar } from './panels/VehiclePanels';

export function App() {
  const model = useModel();
  const workspace = useApp((s) => s.workspace);
  const setWorkspace = switchWorkspace;
  const vehicle = useVehicle(workspace !== 'corner');
  const dirty = useDirty();

  // The startup layout counts as "saved" (nothing to lose yet).
  useEffect(() => {
    const s = useApp.getState();
    if (s.savedSnapshot === null && s.fileName === null) s.markSaved(null, modelSnapshot(pickDesign(s)), testsSnapshot(s));
    initHistory();
    initHeldDimensions();
  }, []);
  const [help, setHelp] = useState(false);
  const canUndo = useHistory((h) => h.canUndo);
  const canRedo = useHistory((h) => h.canRedo);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Keyboard: Esc closes the measure tool / clears the selection; M toggles measuring.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
      const s = useApp.getState();
      // Undo / redo the design (inside a text box the browser's own undo applies).
      if ((e.ctrlKey || e.metaKey) && !typing && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        if (e.key === 'y' || e.key === 'Y' || e.shiftKey) redo(); else undo();
        return;
      }
      if (!typing && e.key === '?') { setHelp((h) => !h); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (e.shiftKey) s.set('saveAsOpen', true);
        else save();
        return;
      }
      if (e.key === 'Escape') {
        if (s.measureMode) s.toggleMeasure();
        else s.select(null);
      } else if (!typing && (e.key === 'm' || e.key === 'M')) {
        s.toggleMeasure();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Side panel widths: drag the edges to resize (not saved; the defaults come back on reload).
  const [leftW, setLeftW] = useState(330);
  const [rightW, setRightW] = useState(320);

  return (
    <div className="app" style={{ gridTemplateColumns: `${leftW}px 5px minmax(200px, 1fr) 5px ${rightW}px` }}>
      <header className="topbar">
        <h1>Suspension Calculator</h1>
        <FileMenu />
        <ViewMenu />
        <UnitsMenu />
        <div className="history-btns">
          <button className="menu-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↶</button>
          <button className="menu-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">↷</button>
        </div>
        <nav className="workspace-switch" role="tablist" aria-label="Workspace">
          <button role="tab" aria-selected={workspace === 'corner'} className={workspace === 'corner' ? 'on' : ''} onClick={() => setWorkspace('corner')}>Corner</button>
          <button role="tab" aria-selected={workspace === 'vehicle'} className={workspace === 'vehicle' ? 'on' : ''} onClick={() => setWorkspace('vehicle')}>Vehicle</button>
          <button role="tab" aria-selected={workspace === 'tests'} className={workspace === 'tests' ? 'on' : ''} onClick={() => setWorkspace('tests')} title="Chains of driving segments run on the whole car">Tests</button>
        </nav>
        <BusyIndicator />
        <span className="muted topbar-note">{workspace === 'corner' ? 'Chassis fixed · one corner' : workspace === 'vehicle' ? 'Whole car · quasi-static' : 'Tests · steady states + ride over time'}</span>
        <button className="menu-btn help-btn" onClick={() => setHelp(true)} title="Keyboard & mouse help (?)">?</button>
      </header>
      {help && <HelpOverlay onClose={() => setHelp(false)} />}
      <SetupWizard />
      <Notice />
      {workspace === 'corner' ? (
        <>
          <aside className="left">
            <LeftSidebar model={model} />
          </aside>
          <Splitter area="lsplit" width={leftW} setWidth={setLeftW} sign={1} />
          <main className="center">
            <Viewport model={model} />
            <MotionBar model={model} />
          </main>
          <Splitter area="rsplit" width={rightW} setWidth={setRightW} sign={-1} />
          <aside className="right">
            <Readout model={model} />
            <Plots model={model} />
          </aside>
        </>
      ) : workspace === 'tests' ? (
        <>
          <aside className="left"><div className="tab-body"><TestsSidebar /></div></aside>
          <Splitter area="lsplit" width={leftW} setWidth={setLeftW} sign={1} />
          <main className="center">
            <TestsViewport model={vehicle} />
            <TestViewBar />
          </main>
          <Splitter area="rsplit" width={rightW} setWidth={setRightW} sign={-1} />
          <aside className="right"><TestResults /></aside>
        </>
      ) : (
        <>
          <aside className="left"><VehicleSidebar model={vehicle} /></aside>
          <Splitter area="lsplit" width={leftW} setWidth={setLeftW} sign={1} />
          <main className="center">
            <VehicleViewport model={vehicle} />
            <VehicleMotionBar />
          </main>
          <Splitter area="rsplit" width={rightW} setWidth={setRightW} sign={-1} />
          <aside className="right"><VehicleResults model={vehicle} /></aside>
        </>
      )}
    </div>
  );
}

/** Drag handle between a side panel and the viewport. */
function Splitter({ area, width, setWidth, sign }: { area: string; width: number; setWidth: (w: number) => void; sign: 1 | -1 }) {
  const [drag, setDrag] = useState<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, 220), Math.min(760, window.innerWidth * 0.45)));
  return (
    <div
      className={`splitter${drag ? ' active' : ''}`} style={{ gridArea: area }}
      role="separator" aria-orientation="vertical" title="Drag to resize · double-click to reset"
      onPointerDown={(e: RPointerEvent) => { (e.target as Element).setPointerCapture(e.pointerId); setDrag({ x: e.clientX, w: width }); }}
      onPointerMove={(e: RPointerEvent) => { if (drag) setWidth(clamp(drag.w + sign * (e.clientX - drag.x))); }}
      onPointerUp={(e: RPointerEvent) => { (e.target as Element).releasePointerCapture(e.pointerId); setDrag(null); }}
      onDoubleClick={() => setWidth(sign === 1 ? 330 : 320)}
    />
  );
}
