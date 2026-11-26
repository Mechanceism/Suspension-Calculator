import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { showView, slotRef, useViewFade } from './viewport/viewFade';
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
type SlotState = 'active' | 'leaving' | 'hidden';
const Keep = memo(function Keep({ viewKey, state, children }: { viewKey: string; state: SlotState; children: ReactNode }) {
  const ref = useMemo(() => slotRef(viewKey), [viewKey]);
  return <div ref={ref} className={`view-slot${state === 'active' ? '' : ` ${state}`}`} aria-hidden={state !== 'active'}>{children}</div>;
}, (a, b) => a.state === 'hidden' && b.state === 'hidden');

type ViewKey = 'corner' | 'vehicle' | 'testsStatic' | 'testsDynamic';
const VIEW_KEYS: ViewKey[] = ['corner', 'vehicle', 'testsStatic', 'testsDynamic'];

/**
 * All the 3D views in one place: the active one shown, the others kept (built on first use, or soon after
 * start). A view shown fades in over the last one with its camera's sweep (viewFade.ts); the last one is drawn
 * underneath until then.
 */
function ViewStack({ corner, vehicle, active, ghost, course }: {
  corner: ReturnType<typeof useModel>; vehicle: ReturnType<typeof useVehicle>; active: ViewKey;
  /** Compare: the snapshot's car, see-through over the current one (Vehicle and Tests static views). */
  ghost?: boolean;
  /** Compare: the course to show (the picked test) and the snapshot's run on it, as a ghost car. */
  course?: { test: TestDesign | null; ghosts: { frames: PlaybackFrame[]; color: string; label: string; wheelbase?: number }[] };
}) {
  const activeTest = useActiveTest();
  const test = course ? course.test : activeTest;
  const [built, setBuilt] = useState<Record<ViewKey, boolean>>(() => ({ corner: false, vehicle: false, testsStatic: false, testsDynamic: false, [active]: true }));
  useEffect(() => { setBuilt((b) => (b[active] ? b : { ...b, [active]: true })); }, [active]);
  // Before the first frame is drawn: the view shown starts hidden over the last one (which stays drawn).
  useLayoutEffect(() => showView(active), [active]);
  const leaving = useViewFade((s) => s.leaving);
  const st = (k: ViewKey): SlotState => (k === active ? 'active' : leaving.includes(k) ? 'leaving' : 'hidden');
  // Drawn: shown, or fading out under the one shown (a ghost car stays in it until it's gone).
  const drawn = (k: ViewKey) => st(k) !== 'hidden';
  // Build the others a little after start, one at a time, so the first visit to each doesn't flash either.
  useEffect(() => {
    const timers = VIEW_KEYS.map((k, i) => window.setTimeout(() => setBuilt((b) => (b[k] ? b : { ...b, [k]: true })), 2500 + i * 700));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  return (
    <div className="viewport-stack">
      {built.corner && <Keep viewKey="corner" state={st('corner')}><Viewport model={corner} active={active === 'corner'} /></Keep>}
      {built.vehicle && <Keep viewKey="vehicle" state={st('vehicle')}><WithGhost on={!!ghost && drawn('vehicle')}>{(g) => <VehicleViewport model={vehicle} active={active === 'vehicle'} ghost={g} />}</WithGhost></Keep>}
      {built.testsStatic && <Keep viewKey="testsStatic" state={st('testsStatic')}><WithGhost on={!!ghost && drawn('testsStatic')}>{(g) => <VehicleViewport model={vehicle} memoryKey="testsStatic" active={active === 'testsStatic'} ghost={g} />}</WithGhost></Keep>}
      {built.testsDynamic && <Keep viewKey="testsDynamic" state={st('testsDynamic')}><WithGhost on={!!ghost && !!course && drawn('testsDynamic')}>{(g) => <CourseViewport model={vehicle} test={test} ghosts={course?.ghosts.map((x) => ({ ...x, model: g }))} active={active === 'testsDynamic'} />}</WithGhost></Keep>}
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
import { LeftSidebar as LeftSidebarLive } from './panels/LeftSidebar';
import { MotionBar } from './panels/MotionBar';
import { Readout as ReadoutLive } from './panels/Readout';
import { Plots as PlotsLive } from './panels/Plots';
import { useCalm } from './playLoop';
import { useVehicle } from './useVehicle';
import { VehicleViewport } from './viewport/VehicleView';
import { switchWorkspace } from './viewport/SafeHtml';
import { VehicleSidebar as VehicleSidebarLive, VehicleResults as VehicleResultsLive, VehicleMotionBar } from './panels/VehiclePanels';
import { CompareSidebar, CompareResults, WithGhost, useCompareView, pickedRow, ghostFrames } from './panels/ComparePanels';
import { useSnapshots } from './snapshots';
import { useCompare } from './compare';
import { PlaybackBar } from './panels/Playback';
import type { TestDesign } from './tests';
import type { PlaybackFrame } from '../core/tests/run';

// The side panels redraw only when the model they're given changes: during a motion play App hands them a
// snapshot about four times a second (useCalm) while the 3D view and the motion bar get every step.
const LeftSidebar = memo(LeftSidebarLive);
const Readout = memo(ReadoutLive);
const Plots = memo(PlotsLive);
const VehicleSidebar = memo(VehicleSidebarLive);
const VehicleResults = memo(VehicleResultsLive);

export function App() {
  const liveModel = useModel();
  const workspace = useApp((s) => s.workspace);
  const setWorkspace = switchWorkspace;
  const liveVehicle = useVehicle(workspace !== 'corner');
  const playing = useApp((s) => s.playing || s.playingSteer || s.playingLateral || s.playingLongitudinal);
  const panelModel = useCalm(liveModel, playing);
  const panelVehicle = useCalm(liveVehicle, playing);
  const model = liveModel, vehicle = liveVehicle;
  // The whole car isn't worked out in the Corner workspace; its 3D views keep the last one meanwhile, so the
  // view fading out on entering Corner still shows the car (it went blank: the black flash).
  const lastVehicle = useRef(vehicle);
  if (vehicle) lastVehicle.current = vehicle;
  const vehicleShown = vehicle ?? lastVehicle.current;
  const testMode = useTestView((s) => s.mode);
  // Compare (R9): the cars in the Vehicle view (comparing vehicles), or on the picked test (comparing tests).
  const compareMode = useCompareView((s) => s.mode);
  const comparePicked = useCompareView((s) => s.picked);
  const compareRuns = useCompare((s) => s.runs);
  const snapId = useSnapshots((s) => s.activeId);
  const compareTests = workspace === 'compare' && compareMode === 'tests';
  const activeView: ViewKey = workspace === 'tests' || compareTests ? (testMode === 'static' ? 'testsStatic' : 'testsDynamic') : workspace === 'compare' ? 'vehicle' : workspace;
  const course = useMemo(() => {
    if (!compareTests) return undefined;
    const row = pickedRow();
    const snap = useSnapshots.getState().list.find((x) => x.id === useSnapshots.getState().activeId);
    const wheelbase = snap?.design.vehicle.wheelbase.value;
    const gf = ghostFrames(row);
    return { test: row ? (row.a ?? row.b)! : null, ghosts: row && gf.length ? [{ frames: gf, color: '#ffb703', label: 'Snapshot', ...(wheelbase ? { wheelbase } : {}) }] : [] };
  }, [compareTests, comparePicked, compareRuns, snapId]); // eslint-disable-line react-hooks/exhaustive-deps
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
          <button role="tab" aria-selected={workspace === 'compare'} className={workspace === 'compare' ? 'on' : ''} onClick={() => setWorkspace('compare')} title="The current design's results — vehicles, tests, setup character — on their own, or beside a snapshot (another design: File → Take snapshot / Import snapshot)">Results</button>
        </nav>
        <BusyIndicator />
        <span className="muted topbar-note">{workspace === 'corner' ? 'Chassis fixed · one corner' : workspace === 'vehicle' ? 'Whole car · quasi-static' : workspace === 'compare' ? (snapId ? 'Results · current vs a snapshot' : 'Results · current design') : 'Tests · steady states + ride over time'}</span>
        <button className="menu-btn help-btn" onClick={() => setHelp(true)} title="Keyboard & mouse help (?)">?</button>
      </header>
      {help && <HelpOverlay onClose={() => setHelp(false)} />}
      <SetupWizard />
      <Notice />
      {workspace === 'corner' ? (
        <>
          <aside className="left">
            <LeftSidebar model={panelModel} />
          </aside>
          <Splitter area="lsplit" width={leftW} setWidth={setLeftW} sign={1} />
          <main className="center">
            <ViewStack corner={model} vehicle={vehicleShown} active={activeView} />
            <MotionBar model={model} />
          </main>
          <Splitter area="rsplit" width={rightW} setWidth={setRightW} sign={-1} />
          <aside className="right">
            <Readout model={panelModel} />
            <Plots model={panelModel} />
          </aside>
        </>
      ) : workspace === 'compare' ? (
        <>
          <aside className="left"><div className="tab-body"><CompareSidebar /></div></aside>
          <Splitter area="lsplit" width={leftW} setWidth={setLeftW} sign={1} />
          <main className="center">
            {/* The 3D views first, in the same place as in the other workspaces (else they're rebuilt: a black flash). */}
            <ViewStack corner={model} vehicle={vehicleShown} active={activeView} ghost={workspace === 'compare'} course={course} />
            {compareTests ? <PlaybackBar test={course?.test ?? null} /> : <VehicleMotionBar />}
          </main>
          <Splitter area="rsplit" width={rightW} setWidth={setRightW} sign={-1} />
          <aside className="right"><CompareResults corner={model} vehicle={vehicle} /></aside>
        </>
      ) : workspace === 'tests' ? (
        <>
          <aside className="left"><div className="tab-body"><TestsSidebar /></div></aside>
          <Splitter area="lsplit" width={leftW} setWidth={setLeftW} sign={1} />
          <main className="center">
            <ViewStack corner={model} vehicle={vehicleShown} active={activeView} />
            <TestViewBar />
          </main>
          <Splitter area="rsplit" width={rightW} setWidth={setRightW} sign={-1} />
          <aside className="right"><TestResults /></aside>
        </>
      ) : (
        <>
          <aside className="left"><VehicleSidebar model={panelVehicle} /></aside>
          <Splitter area="lsplit" width={leftW} setWidth={setLeftW} sign={1} />
          <main className="center">
            <ViewStack corner={model} vehicle={vehicleShown} active={activeView} />
            <VehicleMotionBar />
          </main>
          <Splitter area="rsplit" width={rightW} setWidth={setRightW} sign={-1} />
          <aside className="right"><VehicleResults model={panelVehicle} /></aside>
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
