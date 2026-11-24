/**
 * What's running, always visible in the top bar: a test run (or Run all), the Tests optimize loop,
 * playback being prepared, the Corner / Vehicle optimizer. A spinner, what it is, and Stop. A thin
 * moving strip along the top of the window shows that something is busy from anywhere.
 */
import { useApp } from '../store';
import { useRun, stopRuns } from './TestsPanels';
import { useLoop } from '../testOptimize';
import { usePlayback } from './Playback';
import { useCornerRun, useVehicleRun } from './OptimizePanel';

export function BusyIndicator() {
  const run = useRun();
  const loop = useLoop();
  const playback = usePlayback((s) => s.computing);
  const corner = useCornerRun();
  const vehicle = useVehicleRun();
  const tests = useApp((s) => s.tests);
  const nameOf = (id: string | null) => tests.find((t) => t.id === id)?.name ?? 'test';

  let label: string | null = null;
  let stop: (() => void) | null = null;
  let where: 'tests' | 'vehicle' | 'corner' = 'tests';
  if (loop.running && loop.rateProgress) {
    label = `Tuning springs & dampers · try ${loop.rateProgress.evaluation} of ${loop.rateProgress.budget}`;
    stop = () => loop.cancel?.();
  } else if (loop.running) {
    label = loop.mode === 'rates' ? 'Tuning springs & dampers' : loop.mode === 'explore'
      ? `Exploring wider ranges (×${loop.widen})`
      : `${loop.mode === 'improve' ? 'Improving' : 'Optimizing'} ${loop.scope === 'all' ? 'all enabled tests' : 'the test'} · round ${loop.round}${loop.widen > 1 ? ` · ranges ×${loop.widen}` : ''}`;
    stop = () => loop.cancel?.();
  } else if (run.batch) {
    label = `Running ${run.batch.total} tests · ${run.batch.index} done`;
    stop = stopRuns;
  } else if (run.running) {
    label = `Running ${nameOf(run.testId)}`;
    stop = stopRuns;
  } else if (playback) {
    label = 'Preparing playback';
  } else if (vehicle.running) {
    label = `Vehicle optimizer${vehicle.progress ? ` · iteration ${vehicle.progress.iteration}` : ''}`;
    stop = () => vehicle.handle?.stop();
    where = 'vehicle';
  } else if (corner.running) {
    label = `Corner optimizer${corner.progress ? ` · iteration ${corner.progress.iteration}` : ''}`;
    stop = () => corner.handle?.stop();
    where = 'corner';
  }
  if (!label) return null;
  return (
    <>
      <div className="busy-strip" aria-hidden />
      <span className="busy-pill" role="status" aria-live="polite" title={`Running in the ${where === 'tests' ? 'Tests' : where === 'vehicle' ? 'Vehicle' : 'Corner'} workspace`}>
        <span className="spinner" /> {label}…
        {stop && <button className="busy-stop" onClick={stop} title="Stop">■</button>}
      </span>
    </>
  );
}
