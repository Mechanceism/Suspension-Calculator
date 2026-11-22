/**
 * Shared optimizer search controls: how wide the gradient search looks (local, or several starts picked
 * from a DOE), and "What matters most" (a DOE sensitivity report: which free coordinates change the
 * result most, and which pairs act together).
 */
import { useState } from 'react';
import { create } from 'zustand';
import type { VehicleProblem, VehicleSensitivity } from '../../core/optimize/vehicle';
import { VEHICLE_GOAL_META } from '../../core/optimize/vehicle';
import type { HardpointId } from '../../core/optimize/corner';
import { POINT_LABELS } from '../components';
import { pointKeyOf, runSensitivityJob, type BuiltProblem } from '../optimizer';
import { fmt } from './FieldRows';

const AXES = ['X', 'Y', 'Z'] as const;

export const SEARCH_CHOICES = [
  { starts: 1, label: 'Local (from the current design)' },
  { starts: 4, label: 'Wide: 4 starts' },
  { starts: 8, label: 'Wide: 8 starts' },
];

/** Local gradient search, or wide: also from the best samples of a design of experiments. */
export function SearchSelect({ value, onChange }: { value: number | undefined; onChange: (starts: number) => void }) {
  return (
    <select value={value ?? 1} onChange={(e) => onChange(Number(e.target.value))}
      title="Local: the gradient search starts from your design and finds the nearest best. Wide: it also starts from the best of a spread of sampled designs (design of experiments) and keeps the best result. Slower, but less likely to stop at a nearby, merely good design.">
      {SEARCH_CHOICES.map((c) => <option key={c.starts} value={c.starts}>{c.label}</option>)}
    </select>
  );
}

interface SensState { running: boolean; progress: string; result: VehicleSensitivity | null; labels: string[]; error: string | null; stop: (() => void) | null; from: unknown }
const useSens = create<SensState>(() => ({ running: false, progress: '', result: null, labels: [], error: null, stop: null, from: null }));

const varLabel = (p: VehicleProblem, i: number) => {
  const v = p.variables[i]!;
  return `${v.root} ${POINT_LABELS[pointKeyOf(v.point as HardpointId)]} ${AXES[v.axis]}`;
};

/** "What matters most": run the DOE in the worker and show the ranked effects. */
export function SensitivityReport({ build, current, what }: { build: () => BuiltProblem<VehicleProblem>; current: unknown; what: string }) {
  const st = useSens();
  const [samples, setSamples] = useState(40);
  const run = () => {
    const b = build();
    if (b.blockers.length) { useSens.setState({ error: b.blockers.join(' '), result: null }); return; }
    const p = b.problem;
    const labels = p.variables.map((_, i) => varLabel(p, i));
    const n = Math.max(samples, 2 * p.variables.length + 8);
    const job = runSensitivityJob(p, n, (q) => useSens.setState({ progress: `sample ${q.sample} of ${q.of}` }));
    useSens.setState({ running: true, progress: 'starting…', error: null, result: null, labels, stop: job.stop, from: current });
    job.done
      .then((result) => useSens.setState({ running: false, result, stop: null }))
      .catch((e: unknown) => useSens.setState({ running: false, stop: null, error: e instanceof Error && e.message === 'stopped' ? null : e instanceof Error ? e.message : String(e) }));
  };
  const r = st.result;
  const stale = !!r && st.from !== current;
  const maxEff = r ? Math.max(1e-12, ...r.cost.effects.map((e) => Math.abs(e.effect))) : 1;
  return (
    <div className="sens">
      <div className="jm-row">
        {!st.running
          ? <button className="wide-btn" onClick={run} title={`Samples designs across the free ranges (design of experiments) and fits which coordinates change ${what} most, and which pairs interact`}>What matters most?</button>
          : <button className="wide-btn" onClick={() => st.stop?.()}>■ Stop</button>}
        <select value={samples} onChange={(e) => setSamples(Number(e.target.value))} title="Designs sampled (more = surer, slower). At least 2 per free coordinate + 8 are always used.">
          {[24, 40, 80].map((n) => <option key={n} value={n}>{n}+ samples</option>)}
        </select>
      </div>
      {st.running && <p className="small-text run-line"><span className="spinner" /> Sampling designs: {st.progress}</p>}
      {st.error && <p className="hint warn-text">{st.error}</p>}
      {r && (
        <>
          {stale && <p className="hint warn-text">The design changed since: run it again.</p>}
          <p className="small-text muted">
            Change of {what} across each coordinate's whole range (lower = better; fit explains {fmt(r.cost.r2 * 100, 0)} % of the spread, {r.samples} samples).
          </p>
          <table className="opt-table sens-table">
            <tbody>
              {r.cost.effects.slice(0, 10).map((e) => (
                <tr key={e.index}>
                  <td>{st.labels[e.index]}</td>
                  <td className="sens-bar-cell"><span className={`sens-bar ${e.effect > 0 ? 'worse' : 'better'}`} style={{ width: `${(Math.abs(e.effect) / maxEff) * 100}%` }} /></td>
                  <td className="mono small-text">{e.effect > 0 ? '+' : ''}{fmt(e.effect, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.cost.interactions.filter((x) => Math.abs(x.effect) > 0.15 * maxEff).slice(0, 3).map((x) => (
            <p key={`${x.a}-${x.b}`} className="small-text">Interaction: <b>{st.labels[x.a]}</b> × <b>{st.labels[x.b]}</b> ({x.effect > 0 ? '+' : ''}{fmt(x.effect, 2)}): the best of one depends on the other.</p>
          ))}
          {r.goals.map((g) => {
            const top = g.s.effects.slice(0, 2);
            return (
              <p key={g.kind} className="small-text muted">
                {VEHICLE_GOAL_META[g.kind].short}: most from {top.map((e) => `${st.labels[e.index]} (${e.effect > 0 ? '+' : ''}${fmt(e.effect, 3)} ${VEHICLE_GOAL_META[g.kind].unit})`).join(', ')}
              </p>
            );
          })}
          <p className="hint">Positive = moving it toward the high end of its range makes {what} worse. Freeing only the top few coordinates makes the optimizer faster and its result easier to build.</p>
        </>
      )}
    </div>
  );
}
