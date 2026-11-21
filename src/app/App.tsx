import { useEffect } from 'react';
import { useModel } from './useModel';
import { useApp } from './store';
import { Viewport } from './viewport/Viewport';
import { LeftSidebar } from './panels/LeftSidebar';
import { MotionBar } from './panels/MotionBar';
import { Readout } from './panels/Readout';
import { Plots } from './panels/Plots';

export function App() {
  const model = useModel();

  // Keyboard: Esc closes the measure tool / clears the selection; M toggles measuring.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      const s = useApp.getState();
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
        <span className="muted">Chassis fixed · front-left corner</span>
      </header>
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
    </div>
  );
}
