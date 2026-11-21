import { useEffect } from 'react';
import { useModel } from './useModel';
import { useApp, pickDesign } from './store';
import { designSnapshot } from './project';
import { FileMenu, Notice } from './panels/FileMenu';
import { save, useDirty } from './fileActions';
import { Viewport } from './viewport/Viewport';
import { LeftSidebar } from './panels/LeftSidebar';
import { MotionBar } from './panels/MotionBar';
import { Readout } from './panels/Readout';
import { Plots } from './panels/Plots';
import { useVehicle } from './useVehicle';
import { VehicleViewport } from './viewport/VehicleView';
import { switchWorkspace } from './viewport/SafeHtml';
import { VehicleInputs, VehicleResults, VehicleMotionBar } from './panels/VehiclePanels';

export function App() {
  const model = useModel();
  const workspace = useApp((s) => s.workspace);
  const setWorkspace = switchWorkspace;
  const vehicle = useVehicle(workspace === 'vehicle');
  const dirty = useDirty();

  // The startup layout counts as "saved" (nothing to lose yet).
  useEffect(() => {
    const s = useApp.getState();
    if (s.savedSnapshot === null && s.fileName === null) s.markSaved(null, designSnapshot(pickDesign(s)));
  }, []);

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
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      const s = useApp.getState();
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

  return (
    <div className="app">
      <header className="topbar">
        <h1>Suspension Calculator</h1>
        <FileMenu />
        <nav className="workspace-switch" role="tablist" aria-label="Workspace">
          <button role="tab" aria-selected={workspace === 'corner'} className={workspace === 'corner' ? 'on' : ''} onClick={() => setWorkspace('corner')}>Corner</button>
          <button role="tab" aria-selected={workspace === 'vehicle'} className={workspace === 'vehicle' ? 'on' : ''} onClick={() => setWorkspace('vehicle')}>Vehicle</button>
        </nav>
        <span className="muted topbar-note">{workspace === 'corner' ? 'Chassis fixed · one corner' : 'Whole car · quasi-static'}</span>
      </header>
      <Notice />
      {workspace === 'corner' ? (
        <>
          <aside className="left">
            <LeftSidebar model={model} />
          </aside>
          <main className="center">
            <Viewport model={model} />
            <MotionBar model={model} />
          </main>
          <aside className="right">
            <Readout model={model} />
            <Plots model={model} />
          </aside>
        </>
      ) : (
        <>
          <aside className="left"><div className="tab-body"><VehicleInputs model={vehicle} /></div></aside>
          <main className="center">
            <VehicleViewport model={vehicle} />
            <VehicleMotionBar />
          </main>
          <aside className="right"><VehicleResults model={vehicle} /></aside>
        </>
      )}
    </div>
  );
}
