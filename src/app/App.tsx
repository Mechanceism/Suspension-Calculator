import { memo, useEffect, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
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
function TestsViewSwitch() {
  const mode = useTestView((s) => s.mode);
  return (
    <div className="view-mode-switch" role="tablist" aria-label="Test view">
      <button role="tab" aria-selected={mode === 'static'} className={`chip${mode === 'static' ? ' on' : ''}`} onClick={() => setTestView({ mode: 'static' })} title="The car in place, posed for the selected segment or the playback moment">Static</button>
      <button role="tab" aria-selected={mode === 'dynamic'} className={`chip${mode === 'dynamic' ? ' on' : ''}`} onClick={() => setTestView({ mode: 'dynamic' })} title="The course in 3D with the car driving it (Play)">Dynamic</button>
    </div>
  );
}

/**
 * A 3D view kept alive while another one is shown: built once, then only hidden (it neither draws nor
 * re-renders from its props while hidden). Rebuilding a view on every tab change left the screen blank
 * while its 3D context and shaders started up, which flashed and hid the camera's sweep.
 */
const Keep = memo(function Keep({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className={`view-slot${active ? '' : ' hidden'}`} aria-hidden={!active}>{children}</div>;
}, (a, b) => !a.active && !b.active);

type ViewKey = 'corner' | 'vehicle' | 'testsStatic' | 'testsDynamic';
const VIEW_KEYS: ViewKey[] = ['corner', 'vehicle', 'testsStatic', 'testsDynamic'];

/** All the 3D views in one place: the active one shown, the others kept (built on first use, or soon after start). */
function ViewStack({ corner, vehicle, active }: { corner: ReturnType<typeof useModel>; vehicle: ReturnType<typeof useVehicle>; active: ViewKey }) {
  const test = useActiveTest();
  const [built, setBuilt] = useState<Record<ViewKey, boolean>>(() => ({ corner: false, vehicle: false, testsStatic: false, testsDynamic: false, [active]: true }));
  useEffect(() => { setBuilt((b) => (b[active] ? b : { ...b, [active]: true })); }, [active]);
  // Build the others a little after start, one at a time, so the first visit to each doesn't flash either.
  useEffect(() => {
    const timers = VIEW_KEYS.map((k, i) => window.setTimeout(() => setBuilt((b) => (b[k] ? b : { ...b, [k]: true })), 2500 + i * 700));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  return (
    <div className="viewport-stack">
      {built.corner && <Keep active={active === 'corner'}><Viewport model={corner} active={active === 'corner'} /></Keep>}
      {built.vehicle && <Keep active={active === 'vehicle'}><VehicleViewport model={vehicle} active={active === 'vehicle'} /></Keep>}
      {built.testsStatic && <Keep active={active === 'testsStatic'}><VehicleViewport model={vehicle} memoryKey="testsStatic" active={active === 'testsStatic'} /></Keep>}
      {built.testsDynamic && <Keep active={active === 'testsDynamic'}><CourseViewport model={vehicle} test={test} active={active === 'testsDynamic'} /></Keep>}
      {(active === 'testsStatic' || active === 'testsDynamic') && <TestsViewSwitch />}
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
  const testMode = useTestView((s) => s.mode);
  const activeView: ViewKey = workspace === 'tests' ? (testMode === 'static' ? 'testsStatic' : 'testsDynamic') : workspace;
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
            <ViewStack corner={model} vehicle={vehicle} active={activeView} />
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
            <ViewStack corner={model} vehicle={vehicle} active={activeView} />
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
            <ViewStack corner={model} vehicle={vehicle} active={activeView} />
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
