/**
 * Optimize tab: pick goals and free coordinates (each with a range), run the corner optimizer,
 * review before → after, then Apply (with Undo). Locked coordinates never move; locked arm
 * dimensions are held.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { parseValue, type Quantity } from '../../core/units/units';
import { GOAL_KINDS, GOAL_META, sampleCorner, goalValue, type GoalKind, type ProgressInfo, type CornerReport } from '../../core/optimize/corner';
import {
  useApp, rootOf, toGeometry, defaultOptimizerSetup, POINT_KEYS, POINT_NAMES, activeParam, OPT_DEFAULT_RANGE,
  type Field, type OptimizerSetup, type PointKey, type EditableGeometry,
} from '../store';
import { CORNER_IDS } from '../../core/vehicle/vehicle';
import { POINT_LABELS } from '../components';
import { pointAxisLocked } from '../locks';
import { buildProblem, runOptimizer, varKey, parseVarKey, pointKeyOf, type RunHandle } from '../optimizer';
import { ValueInput } from './ValueInput';
import { Section, fmt } from './FieldRows';

const AXES = ['X', 'Y', 'Z'] as const;

type RunResult = CornerReport & { status: string; iterations: number; cost0: number; cost: number };
interface RunState {
  running: boolean;
  progress: ProgressInfo | null;
  result: RunResult | null;
  /** Geometry the run started from: the result is stale if the design has changed since. */
  from: EditableGeometry | null;
  error: string | null;
  handle: RunHandle | null;
}
/** Run state lives outside the component so switching tabs doesn't lose a run. */
const useRun = create<RunState>(() => ({ running: false, progress: null, result: null, from: null, error: null, handle: null }));

const parseField = (text: string, q: Quantity, prev: Field): Field => {
  const r = parseValue(text, q);
  return r.ok ? { text, value: r.value } : { ...prev, text, error: r.error };
};

function useSetup(): OptimizerSetup {
  const stored = useApp((s) => s.optimizer[rootOf(s.activeCorner, s.links)]);
  return useMemo(() => stored ?? defaultOptimizerSetup(), [stored]);
}

/** Highlight a point in the viewport without leaving this tab. */
const highlight = (k: PointKey) => useApp.setState({ selection: { kind: 'point', id: k } });

const goalNumber = (k: GoalKind, v: number | null) => (v === null ? '—' : fmt(v, k === 'motionRatio' ? 3 : k === 'bumpSteer' ? 3 : 2));

function GoalRows({ setup, now }: { setup: OptimizerSetup; now: Record<GoalKind, number | null> | null }) {
  const update = useApp((s) => s.updateOptimizer);
  const setGoal = (k: GoalKind, patch: Partial<OptimizerSetup['goals'][GoalKind]>) =>
    update((o) => ({ ...o, goals: { ...o.goals, [k]: { ...o.goals[k], ...patch } } }));
  return (
    <table className="opt-table">
      <thead><tr><th /><th>Goal</th><th>Target</th><th>Wt</th><th>Now</th><th /></tr></thead>
      <tbody>
        {GOAL_KINDS.map((k) => {
          const g = setup.goals[k];
          const meta = GOAL_META[k];
          return (
            <tr key={k} className={g.on ? '' : 'off'}>
              <td><input type="checkbox" checked={g.on} onChange={() => setGoal(k, { on: !g.on })} aria-label={meta.label} /></td>
              <td title={`${meta.label}${meta.unit ? ` (${meta.unit})` : ''}. ${meta.hint}`}>{meta.short}</td>
              <td className="nowrap">
                <ValueInput field={g.target} unit={meta.unit} width={50} onCommit={(t) => setGoal(k, { target: parseField(t, 'ratio', g.target) })} />
              </td>
              <td><ValueInput field={g.weight} unit="" width={36} onCommit={(t) => setGoal(k, { weight: parseField(t, 'ratio', g.weight) })} /></td>
              <td className="mono muted nowrap" title={k === 'bumpSteer' ? 'Largest toe deviation from the target slope over the travel range, °' : undefined}>
                {now ? goalNumber(k, now[k]) : '…'}
              </td>
              <td className="unit nowrap">{k === 'bumpSteer' ? '° (max)' : meta.unit}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function VariablePicker({ setup }: { setup: OptimizerSetup }) {
  const geom = useApp((s) => s.geom);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const update = useApp((s) => s.updateOptimizer);
  const toggle = (k: PointKey, axis: 0 | 1 | 2) => update((o) => {
    const key = varKey(k, axis);
    const ranges = { ...o.ranges };
    if (ranges[key]) delete ranges[key];
    else {
      const v = geom.points[k][axis].value;
      const f = (x: number): Field => ({ text: String(Number(x.toFixed(2))), value: x });
      ranges[key] = { lo: f(v - OPT_DEFAULT_RANGE), hi: f(v + OPT_DEFAULT_RANGE) };
    }
    return { ...o, ranges };
  });
  return (
    <table className="opt-table">
      <tbody>
        {POINT_KEYS.map((k) => (
          <tr key={k}>
            <td><button className="link-btn" title={`${activeParam(POINT_NAMES[k])} — highlight in the view`} onClick={() => highlight(k)}>{POINT_LABELS[k]}</button></td>
            {([0, 1, 2] as const).map((a) => {
              const locked = pointAxisLocked(locks, root, k, a, geom.damperArm);
              const on = !!setup.ranges[varKey(k, a)];
              return (
                <td key={a}>
                  <button
                    className={`chip axis-chip${on ? ' on' : ''}${locked ? ' locked' : ''}`}
                    disabled={locked && !on}
                    title={locked ? 'Locked — the optimizer keeps it' : on ? 'Free: click to fix' : 'Fixed: click to let the optimizer move it'}
                    onClick={() => toggle(k, a)}
                  >
                    {locked ? `${AXES[a]}🔒` : AXES[a]}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RangeRows({ setup }: { setup: OptimizerSetup }) {
  const geom = useApp((s) => s.geom);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const update = useApp((s) => s.updateOptimizer);
  const keys = Object.keys(setup.ranges).filter((k) => parseVarKey(k)).sort(
    (a, b) => POINT_KEYS.indexOf(parseVarKey(a)!.k) - POINT_KEYS.indexOf(parseVarKey(b)!.k) || a.localeCompare(b),
  );
  if (!keys.length) return <p className="muted">No free coordinates yet: pick some above or use a preset.</p>;
  const setRange = (key: string, which: 'lo' | 'hi', text: string) => update((o) => {
    const r = o.ranges[key]!;
    return { ...o, ranges: { ...o.ranges, [key]: { ...r, [which]: parseField(text, 'length', r[which]) } } };
  });
  return (
    <table className="opt-table">
      <thead><tr><th>Coordinate</th><th>Now</th><th>Min</th><th>Max</th><th /></tr></thead>
      <tbody>
        {keys.map((key) => {
          const { k, axis } = parseVarKey(key)!;
          const r = setup.ranges[key]!;
          const now = geom.points[k][axis].value;
          const locked = pointAxisLocked(locks, root, k, axis, geom.damperArm);
          const outside = now < Math.min(r.lo.value, r.hi.value) - 1e-9 || now > Math.max(r.lo.value, r.hi.value) + 1e-9;
          return (
            <tr key={key} className={locked ? 'off' : ''}>
              <td className="nowrap">
                <button className="link-btn" onClick={() => highlight(k)}>{POINT_LABELS[k]} {AXES[axis]}</button>
                {locked && <span title="Locked: skipped"> 🔒</span>}
              </td>
              <td className={`mono nowrap${outside ? ' warn-text' : ''}`} title={outside ? 'Outside its range: the optimizer will start from the nearest limit' : undefined}>{fmt(now, 1)}</td>
              <td><ValueInput field={r.lo} unit="mm" width={56} onCommit={(t) => setRange(key, 'lo', t)} /></td>
              <td><ValueInput field={r.hi} unit="mm" width={56} onCommit={(t) => setRange(key, 'hi', t)} /></td>
              <td><button className="icon-btn" title="Fix this coordinate (remove from the free list)" onClick={() => update((o) => { const ranges = { ...o.ranges }; delete ranges[key]; return { ...o, ranges }; })}>✕</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Presets() {
  const update = useApp((s) => s.updateOptimizer);
  const geom = useApp((s) => s.geom);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const bumpSteer = () => update((o) => {
    const ranges: OptimizerSetup['ranges'] = {};
    // Classic bump-steer knobs: both tie-rod heights and the tie-rod length (inner end, along the rack).
    for (const [k, a] of [['trInner', 0], ['trInner', 1], ['trOuter', 1]] as const) {
      if (pointAxisLocked(locks, root, k, a, geom.damperArm)) continue;
      const v = geom.points[k][a].value;
      ranges[varKey(k, a)] = {
        lo: { text: String(Number((v - OPT_DEFAULT_RANGE).toFixed(2))), value: v - OPT_DEFAULT_RANGE },
        hi: { text: String(Number((v + OPT_DEFAULT_RANGE).toFixed(2))), value: v + OPT_DEFAULT_RANGE },
      };
    }
    const goals = Object.fromEntries(GOAL_KINDS.map((k) => [k, { ...o.goals[k], on: k === 'bumpSteer' }])) as OptimizerSetup['goals'];
    goals.bumpSteer = { ...goals.bumpSteer, target: { text: '0', value: 0 } };
    return { ...o, ranges, goals };
  });
  const clear = () => update(() => defaultOptimizerSetup());
  return (
    <div className="jm-row">
      <button className="chip on" onClick={bumpSteer} title="Free: tie-rod inner X (length) and Y, outer Y (heights), ±25 mm. Goal: bump steer only. Locked coordinates are left out.">
        Bump steer → tie-rod mounts
      </button>
      <button className="chip" onClick={clear}>Reset</button>
    </div>
  );
}

function RunArea() {
  const run = useRun();
  const geom = useApp((s) => s.geom);
  const deps = [
    useApp((s) => s.optimizer), geom, useApp((s) => s.locks), useApp((s) => s.links), useApp((s) => s.activeCorner),
    useApp((s) => s.droop), useApp((s) => s.bump), useApp((s) => s.settings),
  ];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => buildProblem(useApp.getState()), deps);
  const applyOptimized = useApp((s) => s.applyOptimized);
  const notify = useApp((s) => s.notify);
  const optUndo = useApp((s) => s.optUndo);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const links = useApp((s) => s.links);
  const undo = useApp((s) => s.undoOptimized);
  const sharers = CORNER_IDS.filter((id) => rootOf(id, links) === root);

  const start = () => {
    const h = runOptimizer(built.problem, (p) => useRun.setState({ progress: p }));
    useRun.setState({ running: true, progress: null, result: null, error: null, from: useApp.getState().geom, handle: h });
    h.done
      .then(({ result }) => useRun.setState({ running: false, result, handle: null }))
      .catch((e: unknown) => useRun.setState({ running: false, error: e instanceof Error ? e.message : String(e), handle: null }));
  };
  const stale = !!run.result && run.from !== geom;
  const apply = () => {
    const r = run.result;
    if (!r) return;
    applyOptimized(r.variables.map((v) => ({ key: pointKeyOf(v.point), axis: v.axis, value: v.after })));
    useRun.setState({ result: null, from: null });
    notify(`Optimized design applied to ${sharers.join(', ')}. Undo is in the Optimize tab.`);
  };
  const p = run.progress;
  const pct = (a: number, b: number) => (a > 0 ? `${fmt(100 * (1 - b / a), 1)}%` : '—');

  return (
    <div className="opt-run">
      {built.blockers.map((b) => <p key={b} className="hint warn-text">{b}</p>)}
      {built.skippedLocked.length > 0 && (
        <p className="hint">Skipped (locked): {built.skippedLocked.map((k) => { const v = parseVarKey(k)!; return `${POINT_LABELS[v.k]} ${AXES[v.axis]}`; }).join(', ')}</p>
      )}
      {built.problem.holds && built.problem.holds.length > 0 && (
        <p className="hint">Held (locked): {built.problem.holds.map((h) => `${h.arm.toUpperCase()} ${h.which === 'planAngle' ? 'plan angle' : h.which}`).join(', ')}</p>
      )}
      <div className="jm-row">
        {!run.running
          ? <button className="wide-btn primary" disabled={built.blockers.length > 0} onClick={start}>▶ Optimize {sharers.length > 1 ? `${root} (+ ${sharers.length - 1} linked)` : root}</button>
          : <button className="wide-btn" onClick={() => run.handle?.stop()}>■ Stop (keep best so far)</button>}
      </div>
      {run.running && (
        <p className="mono small-text">
          {p ? `Iteration ${p.iteration} · miss ${fmt(p.cost0, 1)} → ${fmt(p.cost, 3)} (−${pct(p.cost0, p.cost)}) · ${p.evaluations} solves` : 'Starting…'}
        </p>
      )}
      {run.error && <p className="hint warn-text">Optimizer failed: {run.error}</p>}
      {run.result && (
        <div className="opt-result">
          <div className="locks-head">
            Result <span className="muted">({run.result.status}, {run.result.iterations} iterations, miss −{pct(run.result.cost0, run.result.cost)})</span>
          </div>
          <table className="opt-table">
            <thead><tr><th>Goal</th><th>Before</th><th>After</th><th>Target</th></tr></thead>
            <tbody>
              {run.result.goals.map((g) => (
                <tr key={g.kind}>
                  <td title={GOAL_META[g.kind].label}>{GOAL_META[g.kind].short}</td>
                  <td className="mono">{goalNumber(g.kind, g.before)}</td>
                  <td className="mono"><b>{goalNumber(g.kind, g.after)}</b></td>
                  <td className="mono muted nowrap">{g.kind === 'bumpSteer' ? '0°' : fmt(g.target, 2)} <span className="unit">{g.kind === 'bumpSteer' ? '' : GOAL_META[g.kind].unit}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="opt-table">
            <thead><tr><th>Coordinate</th><th>Before</th><th>After</th><th>Δ</th></tr></thead>
            <tbody>
              {run.result.variables.map((v) => (
                <tr key={`${v.point}.${v.axis}`}>
                  <td className="nowrap"><button className="link-btn" onClick={() => highlight(pointKeyOf(v.point))}>{POINT_LABELS[pointKeyOf(v.point)]} {AXES[v.axis]}</button></td>
                  <td className="mono">{fmt(v.before, 2)}</td>
                  <td className="mono">{fmt(v.after, 2)}</td>
                  <td className="mono nowrap">
                    {fmt(v.after - v.before, 2)}
                    {v.atLimit && <span className="warn-text" title="Stopped at its range limit: widen the range or free more coordinates for a better result"> ⚠ limit</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {stale && <p className="hint warn-text">The design changed since this run. Run again before applying.</p>}
          <div className="jm-row">
            <button className="wide-btn primary" disabled={stale} onClick={apply}>Apply to design</button>
            <button className="wide-btn" onClick={() => useRun.setState({ result: null, from: null })}>Discard</button>
          </div>
        </div>
      )}
      {optUndo && optUndo.root === root && !run.result && (
        <div className="jm-row">
          <span className="muted">Optimization applied.</span>
          <button className="chip" onClick={undo}>Undo</button>
        </div>
      )}
    </div>
  );
}

export function OptimizePanel() {
  const setup = useSetup();
  const update = useApp((s) => s.updateOptimizer);
  const geom = useApp((s) => s.geom);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const interacting = useApp((s) => s.interacting);
  const steered = useApp((s) => s.settings[s.activeCorner].steered);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const links = useApp((s) => s.links);
  const sharers = CORNER_IDS.filter((id) => rootOf(id, links) === root);

  // Current goal values for the "Now" column (skipped while dragging).
  const now = useMemo(() => {
    if (interacting) return null;
    const rack = Math.abs(setup.rackCheck.value);
    const s = sampleCorner(toGeometry(geom), {
      droop: -Math.abs(droop), bump: Math.abs(bump), samples: 9,
      rackPositions: rack > 0 && steered ? [-rack, rack] : [], rollAngle: setup.rollAngle.value,
    });
    if (!s) return null;
    return Object.fromEntries(GOAL_KINDS.map((k) => [k, goalValue(k, s, setup.goals[k].target.value)])) as Record<GoalKind, number | null>;
  }, [geom, droop, bump, steered, setup, interacting]);

  const setField = (k: 'rollAngle' | 'rackCheck' | 'keepClose', q: Quantity, text: string) =>
    update((o) => ({ ...o, [k]: parseField(text, q, o[k]) }));

  return (
    <div className="inspector optimize-panel">
      <p className="hint">
        Optimizes the <b>{root}</b> design{sharers.length > 1 ? ` (shared with ${sharers.filter((s) => s !== root).join(', ')})` : ''}: it moves only the
        free coordinates, each within its range, to meet the goals. Locked values never move; locked arm dimensions are held.
        Travel range {-Math.abs(droop)} to +{Math.abs(bump)} mm (motion bar).
      </p>
      <Presets />
      <Section title="Goals">
        <GoalRows setup={setup} now={now} />
        <table className="opt-table">
          <tbody>
            <tr title="Body roll for the outside-wheel inclination goal">
              <td>Roll angle (inclination goal)</td>
              <td><ValueInput field={setup.rollAngle} unit="°" width={52} onCommit={(t) => setField('rollAngle', 'angle', t)} /> °</td>
            </tr>
            <tr title={steered ? 'Bump steer is also checked with the rack moved this far each way (0 = straight ahead only)' : 'This corner does not steer'}>
              <td>Bump steer also at rack ±</td>
              <td><ValueInput field={setup.rackCheck} unit="mm" width={52} onCommit={(t) => setField('rackCheck', 'length', t)} /> mm</td>
            </tr>
            <tr title="Keeps the result near the current design when the goals alone don't pin it down. 0 = off.">
              <td>Prefer small changes</td>
              <td><ValueInput field={setup.keepClose} unit="" width={52} onCommit={(t) => setField('keepClose', 'ratio', t)} /></td>
            </tr>
          </tbody>
        </table>
      </Section>
      <Section title={`Free coordinates (${Object.keys(setup.ranges).length})`}>
        <RangeRows setup={setup} />
        <details className="opt-picker">
          <summary>Pick coordinates…</summary>
          <VariablePicker setup={setup} />
        </details>
      </Section>
      <Section title="Run">
        <RunArea />
      </Section>
    </div>
  );
}
