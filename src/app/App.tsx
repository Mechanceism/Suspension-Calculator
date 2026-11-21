import { useModel } from './useModel';
import { Viewport } from './viewport/Viewport';
import { Browser } from './panels/Browser';
import { Hardpoints } from './panels/Hardpoints';
import { MotionBar } from './panels/MotionBar';
import { Readout } from './panels/Readout';
import { Plots } from './panels/Plots';

export function App() {
  const model = useModel();
  return (
    <div className="app">
      <header className="topbar">
        <h1>Suspension Calculator</h1>
        <span className="muted">Kinematic mode · chassis fixed · front-left corner</span>
      </header>
      <aside className="left">
        <Browser />
        <Hardpoints />
      </aside>
      <main className="center">
        <Viewport model={model} />
        <MotionBar />
      </main>
      <aside className="right">
        <Readout model={model} />
        <Plots model={model} />
      </aside>
    </div>
  );
}
