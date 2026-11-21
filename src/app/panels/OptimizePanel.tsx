/**
 * Optimizer panels.
 *  - OptimizePanel (Corner workspace): one corner design, kinematic + per-tire grip goals.
 *  - VehicleOptimizePanel (Vehicle workspace): every corner design at once, goals from the whole-car
 *    solve in chosen load cases (cornering, braking, accelerating).
 * Both: pick goals and free coordinates (each with a range), run in the background, review
 * before → after, Apply (with Undo). Locked coordinates never move; locked arm dimensions are held.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { parseValue, type Quantity } from '../../core/units/units';
import {
  GOAL_KINDS, GOAL_META, sampleCorner, goalValue,
  type GoalKind, type GoalMeta, type ProgressInfo, type HardpointId, type Variable, type Hold,
} from '../../core/optimize/corner';
import {
  VEHICLE_GOAL_KINDS, VEHICLE_GOAL_META, evaluateVehicle, vehicleGoalValue,
  type VehicleGoalKind, type VehicleGoalMeta,
} from '../../core/optimize/vehicle';
import {
  useApp, rootOf, defaultOptimizerSetup, defaultVehicleOptimizerSetup, mergedCorners,
  POINT_KEYS, POINT_NAMES, activeParam, OPT_DEFAULT_RANGE, GRIP_KEYS, GRIP_META,
  type Field, type OptimizerSetup, type PointKey, type GoalSetting, type CornerDesign,
} from '../store';
import { CORNER_IDS, type CornerId } from '../../core/vehicle/vehicle';
import { POINT_LABELS } from '../components';
import { pointAxisLocked } from '../locks';
import {
  buildProblem, buildVehicleProblem, runOptimizer, runVehicleOptimizer, varKey, parseVarKey, vehVarKey, parseVehVarKey,
  pointKeyOf, designRoots, type RunHandle, type RunResult,
} from '../optimizer';
import { ValueInput } from './ValueInput';
import { Section, FieldRows, fmt } from './FieldRows';
import { useDisplay } from '../units';

const AXES = ['X', 'Y', 'Z'] as const;

const parseField = (text: string, q: Quantity, prev: Field): Field => {
  const r = parseValue(text, q);
  return r.ok ? { text, value: r.value } : { ...prev, text, error: r.error };
};
const numField = (x: number): Field => ({ text: String(Number(x.toFixed(2))), value: x });

/** Highlight a point in the viewport without leaving this tab. */
const highlight = (k: PointKey) => useApp.setState({ selection: { kind: 'point', id: k } });

// ---------------------------------------------------------------- shared pieces

type AnyMeta = GoalMeta | VehicleGoalMeta;
const goalNumber = (unit: string, v: number | null) =>
  (v === null ? '—' : fmt(v, unit === '' || unit === 'g' || unit === '°' ? 3 : unit === 'cm²' || unit === 'N' ? 1 : 2));

/** Goal rows: on/off, target (or "max"), weight, current value. */
function GoalTable<K extends string>({ kinds, meta, goals, now, onChange }: {
  kinds: readonly K[]; meta: Record<K, AnyMeta>; goals: Record<K, GoalSetting>; now: Partial<Record<K, number | null>> | null;
  onChange: (k: K, patch: Partial<GoalSetting>) => void;
}) {
  const disp = useDisplay();
  return (
    <table className="opt-table">
      <thead><tr><th /><th>Goal</th><th>Target</th><th>Wt</th><th>Now</th><th /></tr></thead>
      <tbody>
        {kinds.map((k) => {
          const g = goals[k];
          const m = meta[k];
          return (
            <tr key={k} className={g.on ? '' : 'off'}>
              <td><input type="checkbox" checked={g.on} onChange={() => onChange(k, { on: !g.on })} aria-label={m.label} /></td>
              <td title={`${m.label}${m.unit ? ` (${m.unit})` : ''}. ${m.hint}`}>{m.short}</td>
              <td className="nowrap">
                {m.maximize
                  ? <span className="muted" title="Maximized: as large as possible">max</span>
                  : <ValueInput field={g.target} unit={m.unit} width={50} onCommit={(t) => onChange(k, { target: parseField(t, 'ratio', g.target) })} />}
              </td>
              <td><ValueInput field={g.weight} unit="" width={36} onCommit={(t) => onChange(k, { weight: parseField(t, 'ratio', g.weight) })} /></td>
              <td className="mono muted nowrap">{now ? disp.text(goalNumber(m.unit, now[k] ?? null), m.unit).text : '…'}</td>
              <td className="unit nowrap">{k === 'bumpSteer' ? '° (max)' : disp.conv(m.unit).unit}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface CoordSpec {
  /** Range key for a point axis. */
  key: (k: PointKey, axis: 0 | 1 | 2) => string;
  value: (k: PointKey, axis: 0 | 1 | 2) => number;
  locked: (k: PointKey, axis: 0 | 1 | 2) => boolean;
}

/** Point grid with X/Y/Z toggles (locked ones show 🔒). */
function CoordPicker({ spec, ranges, onToggle }: { spec: CoordSpec; ranges: Record<string, unknown>; onToggle: (k: PointKey, axis: 0 | 1 | 2) => void }) {
  return (
    <table className="opt-table">
      <tbody>
        {POINT_KEYS.map((k) => (
          <tr key={k}>
            <td><button className="link-btn" title={`${activeParam(POINT_NAMES[k])} — highlight in the view`} onClick={() => highlight(k)}>{POINT_LABELS[k]}</button></td>
            {([0, 1, 2] as const).map((a) => {
              const locked = spec.locked(k, a);
              const on = !!ranges[spec.key(k, a)];
              return (
                <td key={a}>
                  <button
                    className={`chip axis-chip${on ? ' on' : ''}${locked ? ' locked' : ''}`}
                    disabled={locked && !on}
                    title={locked ? 'Locked — the optimizer keeps it' : on ? 'Free: click to fix' : 'Fixed: click to let the optimizer move it'}
                    onClick={() => onToggle(k, a)}
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

interface RangeEntry { key: string; k: PointKey; axis: 0 | 1 | 2; label: string; now: number; locked: boolean; lo: Field; hi: Field }

/** The chosen free coordinates with their ranges. */
function RangeTable({ entries, onRange, onRemove }: {
  entries: RangeEntry[];
  onRange: (key: string, which: 'lo' | 'hi', text: string) => void;
  onRemove: (key: string) => void;
}) {
  const disp = useDisplay();
  if (!entries.length) return <p className="muted">No free coordinates yet: pick some above or use a preset.</p>;
  return (
    <table className="opt-table">
      <thead><tr><th>Coordinate</th><th>Now</th><th>Min</th><th>Max</th><th /></tr></thead>
      <tbody>
        {entries.map((e) => {
          const outside = e.now < Math.min(e.lo.value, e.hi.value) - 1e-9 || e.now > Math.max(e.lo.value, e.hi.value) + 1e-9;
          return (
            <tr key={e.key} className={e.locked ? 'off' : ''}>
              <td className="nowrap">
                <button className="link-btn" onClick={() => highlight(e.k)}>{e.label}</button>
                {e.locked && <span title="Locked: skipped"> 🔒</span>}
              </td>
              <td className={`mono nowrap${outside ? ' warn-text' : ''}`} title={outside ? 'Outside its range: the optimizer starts from the nearest limit' : undefined}>{disp.text(fmt(e.now, 1), 'mm').text}</td>
              <td><ValueInput field={e.lo} unit="mm" width={56} onCommit={(t) => onRange(e.key, 'lo', t)} /></td>
              <td><ValueInput field={e.hi} unit="mm" width={56} onCommit={(t) => onRange(e.key, 'hi', t)} /></td>
              <td><button className="icon-btn" title="Fix this coordinate (remove from the free list)" onClick={() => onRemove(e.key)}>✕</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Picker first, chosen list below it, so toggling a coordinate never moves the picker. */
function FreeCoordinates({ spec, ranges, entries, header, update }: {
  spec: CoordSpec; ranges: Record<string, { lo: Field; hi: Field }>; entries: RangeEntry[]; header?: ReactNode;
  update: (fn: (r: Record<string, { lo: Field; hi: Field }>) => Record<string, { lo: Field; hi: Field }>) => void;
}) {
  return (
    <Section title={`Free coordinates (${entries.length})`}>
      <details className="opt-picker">
        <summary>Pick coordinates…</summary>
        {header}
        <div className="jm-row">
          <button className="chip" title="Free every coordinate that isn't locked (±25 mm). Many free coordinates make each step slower."
            onClick={() => update((r0) => {
              const r = { ...r0 };
              for (const k of POINT_KEYS) for (const a of [0, 1, 2] as const) {
                const key = spec.key(k, a);
                if (!spec.locked(k, a) && !r[key]) r[key] = { lo: numField(spec.value(k, a) - OPT_DEFAULT_RANGE), hi: numField(spec.value(k, a) + OPT_DEFAULT_RANGE) };
              }
              return r;
            })}>Free all available</button>
          <button className="chip" title="Fix every coordinate (clear the list)" onClick={() => update((r0) => Object.fromEntries(Object.entries(r0).filter(([key]) => !POINT_KEYS.some((k) => [0, 1, 2].some((a) => spec.key(k, a as 0 | 1 | 2) === key)))))}>Clear</button>
        </div>
        <CoordPicker spec={spec} ranges={ranges} onToggle={(k, a) => update((r0) => {
          const key = spec.key(k, a);
          const r = { ...r0 };
          if (r[key]) delete r[key];
          else r[key] = { lo: numField(spec.value(k, a) - OPT_DEFAULT_RANGE), hi: numField(spec.value(k, a) + OPT_DEFAULT_RANGE) };
          return r;
        })} />
      </details>
      <RangeTable entries={entries}
        onRange={(key, which, text) => update((r) => ({ ...r, [key]: { ...r[key]!, [which]: parseField(text, 'length', r[key]![which]) } }))}
        onRemove={(key) => update((r0) => { const r = { ...r0 }; delete r[key]; return r; })} />
    </Section>
  );
}

/** Tire grip model inputs (shared by both optimizers). */
export function GripModelFields() {
  const grip = useApp((s) => s.grip);
  const setGripField = useApp((s) => s.setGripField);
  return (
    <>
      <FieldRows rows={GRIP_KEYS.map((k) => ({ label: GRIP_META[k].label, field: grip[k], unit: GRIP_META[k].unit, hint: GRIP_META[k].hint, onCommit: (t: string) => setGripField(k, t) }))} />
      <p className="hint">
        Placeholder until you have tire data. The patch pressure is part even (air) and part following the tire's deflection
        (carcass); rubber friction drops as pressure rises, so a larger, more even patch grips more. With the air-spring tire
        the area is set mostly by load ÷ pressure, so geometry changes it little; the stiffness tire reacts much more to inclination.
      </p>
    </>
  );
}

type Report = {
  goals: { kind: string; target: number; before: number | null; after: number | null }[];
  variables: (Variable & { root?: CornerId; before: number; after: number; atLimit: boolean })[];
};
interface RunState {
  running: boolean;
  progress: ProgressInfo | null;
  result: RunResult<Report> | null;
  /** Design the run started from: the result is stale if the design has changed since. */
  from: unknown;
  error: string | null;
  handle: RunHandle<Report> | null;
}
type RunStore = UseBoundStore<StoreApi<RunState>>;
const makeRunStore = (): RunStore => create<RunState>(() => ({ running: false, progress: null, result: null, from: null, error: null, handle: null }));
/** Run state lives outside the components so switching tabs doesn't lose a run. */
const useCornerRun = makeRunStore();
const useVehicleRun = makeRunStore();

function RunArea({ useRun, blockers, notes, label, start, current, meta, onApply, undo }: {
  useRun: RunStore;
  blockers: string[]; notes: ReactNode; label: string;
  start: (onProgress: (p: ProgressInfo) => void) => RunHandle<Report>;
  current: unknown;
  meta: Record<string, AnyMeta>;
  onApply: (r: Report) => void;
  undo: { available: boolean; run: () => void };
}) {
  const run = useRun();
  const disp = useDisplay();
  const go = () => {
    const h = start((p) => useRun.setState({ progress: p }));
    useRun.setState({ running: true, progress: null, result: null, error: null, from: current, handle: h });
    h.done
      .then(({ result }) => useRun.setState({ running: false, result, handle: null }))
      .catch((e: unknown) => useRun.setState({ running: false, error: e instanceof Error ? e.message : String(e), handle: null }));
  };
  const stale = !!run.result && run.from !== current;
  const p = run.progress;
  const pct = (a: number, b: number) => (a > 0 ? `${fmt(100 * (1 - b / a), 1)}%` : '—');
  const coordLabel = (v: Report['variables'][number]) => `${v.root ? `${v.root} ` : ''}${POINT_LABELS[pointKeyOf(v.point as HardpointId)]} ${AXES[v.axis]}`;

  return (
    <div className="opt-run">
      {blockers.map((b) => <p key={b} className="hint warn-text">{b}</p>)}
      {notes}
      <div className="jm-row">
        {!run.running
          ? <button className="wide-btn primary" disabled={blockers.length > 0} onClick={go}>▶ {label}</button>
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
              {run.result.goals.map((g) => {
                const m = meta[g.kind]!;
                return (
                  <tr key={g.kind}>
                    <td title={m.label}>{m.short}</td>
                    <td className="mono">{disp.text(goalNumber(m.unit, g.before), m.unit).text}</td>
                    <td className="mono"><b>{disp.text(goalNumber(m.unit, g.after), m.unit).text}</b></td>
                    <td className="mono muted nowrap">
                      {m.maximize ? 'max' : g.kind === 'bumpSteer' ? '0°' : disp.text(fmt(g.target, 2), m.unit).text}{' '}
                      <span className="unit">{m.maximize || g.kind === 'bumpSteer' ? '' : disp.conv(m.unit).unit}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <table className="opt-table">
            <thead><tr><th>Coordinate</th><th>Before</th><th>After</th><th>Δ</th></tr></thead>
            <tbody>
              {run.result.variables.map((v) => (
                <tr key={`${v.root ?? ''}.${v.point}.${v.axis}`}>
                  <td className="nowrap"><button className="link-btn" onClick={() => highlight(pointKeyOf(v.point as HardpointId))}>{coordLabel(v)}</button></td>
                  <td className="mono">{disp.text(fmt(v.before, 2), 'mm').text}</td>
                  <td className="mono">{disp.text(fmt(v.after, 2), 'mm').text}</td>
                  <td className="mono nowrap">
                    {disp.text(fmt(v.after - v.before, 2), 'mm').text}
                    {v.atLimit && <span className="warn-text" title="Stopped at its range limit: widen the range or free more coordinates for a better result"> ⚠ limit</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {stale && <p className="hint warn-text">The design changed since this run. Run again before applying.</p>}
          <div className="jm-row">
            <button className="wide-btn primary" disabled={stale} onClick={() => { onApply(run.result!); useRun.setState({ result: null, from: null }); }}>Apply to design</button>
            <button className="wide-btn" onClick={() => useRun.setState({ result: null, from: null })}>Discard</button>
          </div>
        </div>
      )}
      {undo.available && !run.result && (
        <div className="jm-row">
          <span className="muted">Optimization applied.</span>
          <button className="chip" onClick={undo.run}>Undo</button>
        </div>
      )}
    </div>
  );
}

const holdLabel = (h: Hold & { root?: string }) => {
  const r = h.root ? `${h.root} ` : '';
  if ('dimension' in h) {
    const d = h.dimension;
    return `${r}${POINT_LABELS[pointKeyOf(d.a)]} → ${POINT_LABELS[pointKeyOf(d.b)]} ${MEASURE_SHORT[d.measure]}`;
  }
  return `${r}${h.arm.toUpperCase()} ${h.which === 'planAngle' ? 'plan angle' : h.which === 'frontViewAngle' ? 'front-view angle' : h.which}`;
};
const MEASURE_SHORT: Record<string, string> = { distance: 'distance', dx: 'ΔX', dy: 'ΔY', dz: 'ΔZ', front: 'front-view angle', side: 'side-view angle', top: 'top-view angle', slope: 'slope' };

const skippedNote = (skipped: string[], label: (k: string) => string, holds: (Hold & { root?: string })[]) => (
  <>
    {skipped.length > 0 && <p className="hint">Skipped (locked): {skipped.map(label).join(', ')}</p>}
    {holds.length > 0 && <p className="hint">Held (locked): {holds.map(holdLabel).join(', ')}</p>}
  </>
);

/** Inputs that the problems depend on (memo key). */
const useProblemDeps = () => [
  useApp((s) => s.optimizer), useApp((s) => s.vehicleOptimizer), useApp((s) => s.geom), useApp((s) => s.corners),
  useApp((s) => s.locks), useApp((s) => s.links), useApp((s) => s.activeCorner), useApp((s) => s.droop), useApp((s) => s.bump),
  useApp((s) => s.settings), useApp((s) => s.tire), useApp((s) => s.tireModel), useApp((s) => s.volumeChange), useApp((s) => s.spring),
  useApp((s) => s.damper), useApp((s) => s.bumpStop), useApp((s) => s.vehicle), useApp((s) => s.grip), useApp((s) => s.shared),
  useApp((s) => s.cornerLoadMode), useApp((s) => s.autoPreload), useApp((s) => s.tests),
];

// ---------------------------------------------------------------- corner optimizer

function useSetup(): OptimizerSetup {
  const stored = useApp((s) => s.optimizer[rootOf(s.activeCorner, s.links)]);
  return useMemo(() => stored ?? defaultOptimizerSetup(), [stored]);
}

function CornerPresets() {
  const update = useApp((s) => s.updateOptimizer);
  const geom = useApp((s) => s.geom);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const preset = (points: [PointKey, 0 | 1 | 2][], on: GoalKind[]) => update((o) => {
    const ranges: OptimizerSetup['ranges'] = {};
    for (const [k, a] of points) {
      if (pointAxisLocked(locks, root, k, a, geom.damperArm)) continue;
      const v = geom.points[k][a].value;
      ranges[varKey(k, a)] = { lo: numField(v - OPT_DEFAULT_RANGE), hi: numField(v + OPT_DEFAULT_RANGE) };
    }
    const goals = Object.fromEntries(GOAL_KINDS.map((k) => [k, { ...o.goals[k], on: on.includes(k) }])) as OptimizerSetup['goals'];
    if (on.includes('bumpSteer')) goals.bumpSteer = { ...goals.bumpSteer, target: { text: '0', value: 0 } };
    return { ...o, ranges, goals };
  });
  return (
    <div className="jm-row">
      {/* Classic bump-steer knobs: both tie-rod heights and the tie-rod length (inner end, along the rack). */}
      <button className="chip on" onClick={() => preset([['trInner', 0], ['trInner', 1], ['trOuter', 1]], ['bumpSteer'])}
        title="Free: tie-rod inner X (length) and Y, outer Y (heights), ±25 mm. Goal: bump steer only. Locked coordinates are left out.">
        Bump steer → tie-rod mounts
      </button>
      <button className="chip on" onClick={() => preset([['ucaFwd', 1], ['ucaAft', 1], ['ucaOut', 1], ['lcaOut', 0], ['trInner', 1], ['trOuter', 1]], ['grip', 'bumpSteer'])}
        title="Free: UCA pivot and ball-joint heights, LCA ball joint X, tie-rod heights, ±25 mm. Goals: grip (static + outside wheel in roll) and bump steer.">
        Grip → arm geometry
      </button>
      <button className="chip" onClick={() => update(() => defaultOptimizerSetup())}>Reset</button>
    </div>
  );
}

export function OptimizePanel() {
  const setup = useSetup();
  const update = useApp((s) => s.updateOptimizer);
  const geom = useApp((s) => s.geom);
  const locks = useApp((s) => s.locks);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const interacting = useApp((s) => s.interacting);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const links = useApp((s) => s.links);
  const optUndo = useApp((s) => s.optUndo);
  const applyOptimized = useApp((s) => s.applyOptimized);
  const undoOptimized = useApp((s) => s.undoOptimized);
  const notify = useApp((s) => s.notify);
  const sharers = CORNER_IDS.filter((id) => rootOf(id, links) === root);
  const deps = useProblemDeps();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => buildProblem(useApp.getState()), deps);

  // Current goal values for the "Now" column (skipped while dragging).
  const now = useMemo(() => {
    if (interacting) return null;
    const p = built.problem;
    const s = sampleCorner(p.geometry, { droop: p.droop, bump: p.bump, samples: p.samples, rackPositions: p.rackPositions, rollAngle: p.rollAngle, tire: p.tire });
    if (!s) return null;
    return Object.fromEntries(GOAL_KINDS.map((k) => [k, goalValue(k, s, setup.goals[k].target.value)])) as Record<GoalKind, number | null>;
  }, [built, setup, interacting]);

  const setField = (k: 'rollAngle' | 'rackCheck' | 'keepClose' | 'rollLoadFactor', q: Quantity, text: string) =>
    update((o) => ({ ...o, [k]: parseField(text, q, o[k]) }));
  const spec: CoordSpec = {
    key: varKey,
    value: (k, a) => geom.points[k][a].value,
    locked: (k, a) => pointAxisLocked(locks, root, k, a, geom.damperArm),
  };
  const entries: RangeEntry[] = Object.keys(setup.ranges).map((key) => ({ key, v: parseVarKey(key) })).filter((e) => e.v)
    .sort((a, b) => POINT_KEYS.indexOf(a.v!.k) - POINT_KEYS.indexOf(b.v!.k) || a.key.localeCompare(b.key))
    .map(({ key, v }) => ({
      key, k: v!.k, axis: v!.axis, label: `${POINT_LABELS[v!.k]} ${AXES[v!.axis]}`,
      now: spec.value(v!.k, v!.axis), locked: spec.locked(v!.k, v!.axis), lo: setup.ranges[key]!.lo, hi: setup.ranges[key]!.hi,
    }));

  return (
    <div className="inspector optimize-panel">
      <p className="hint">
        Optimizes the <b>{root}</b> design{sharers.length > 1 ? ` (shared with ${sharers.filter((s) => s !== root).join(', ')})` : ''}: it moves only the
        free coordinates, each within its range, to meet the goals. Locked values never move; locked arm dimensions are held.
        Travel range {-Math.abs(droop)} to +{Math.abs(bump)} mm (motion bar). For goals across the whole car, use Optimize in the Vehicle view.
      </p>
      <CornerPresets />
      <Section title="Goals">
        <GoalTable kinds={GOAL_KINDS} meta={GOAL_META} goals={setup.goals} now={now}
          onChange={(k, patch) => update((o) => ({ ...o, goals: { ...o.goals, [k]: { ...o.goals[k], ...patch } } }))} />
        <table className="opt-table">
          <tbody>
            <tr title="Body roll for the outside-wheel inclination, contact-area and grip goals">
              <td>Roll angle</td>
              <td className="nowrap"><ValueInput field={setup.rollAngle} unit="°" width={52} onCommit={(t) => setField('rollAngle', 'angle', t)} /> °</td>
            </tr>
            <tr title="Outside-wheel tire load in roll, as a multiple of the static corner load (contact-area and grip goals)">
              <td>Outside-wheel load in roll</td>
              <td className="nowrap"><ValueInput field={setup.rollLoadFactor} unit="×" width={52} onCommit={(t) => setField('rollLoadFactor', 'ratio', t)} /> × static</td>
            </tr>
            <tr title="Bump steer is also checked with the rack moved this far each way (0 = straight ahead only)">
              <td>Bump steer also at rack ±</td>
              <td className="nowrap"><ValueInput field={setup.rackCheck} unit="mm" width={52} onCommit={(t) => setField('rackCheck', 'length', t)} /> mm</td>
            </tr>
            <tr title="Keeps the result near the current design when the goals alone don't pin it down. 0 = off.">
              <td>Prefer small changes</td>
              <td><ValueInput field={setup.keepClose} unit="" width={52} onCommit={(t) => setField('keepClose', 'ratio', t)} /></td>
            </tr>
          </tbody>
        </table>
      </Section>
      <Section title="Tire grip model" open={false}>
        <GripModelFields />
      </Section>
      <FreeCoordinates spec={spec} ranges={setup.ranges} entries={entries} update={(fn) => update((o) => ({ ...o, ranges: fn(o.ranges) }))} />
      <Section title="Run">
        <RunArea
          useRun={useCornerRun} blockers={built.blockers} meta={GOAL_META} current={geom}
          label={`Optimize ${sharers.length > 1 ? `${root} (+ ${sharers.length - 1} linked)` : root}`}
          notes={skippedNote(built.skippedLocked, (k) => { const v = parseVarKey(k)!; return `${POINT_LABELS[v.k]} ${AXES[v.axis]}`; }, built.problem.holds ?? [])}
          start={(onP) => runOptimizer(built.problem, onP)}
          onApply={(r) => {
            applyOptimized(r.variables.map((v) => ({ key: pointKeyOf(v.point), axis: v.axis, value: v.after })));
            notify(`Optimized design applied to ${sharers.join(', ')}. Undo is in the Optimize tab.`);
          }}
          undo={{ available: !!optUndo && optUndo.root === root, run: undoOptimized }}
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- vehicle optimizer

function VehiclePresets() {
  const update = useApp((s) => s.updateVehicleOptimizer);
  const preset = (points: [PointKey, 0 | 1 | 2][], on: VehicleGoalKind[]) => update((o) => {
    const s = useApp.getState();
    const all = mergedCorners(s);
    const ranges: typeof o.ranges = {};
    for (const { root } of designRoots(s)) {
      const g = all[root].geom;
      for (const [k, a] of points) {
        if (pointAxisLocked(s.locks, root, k, a, g.damperArm)) continue;
        const v = g.points[k][a].value;
        ranges[vehVarKey(root, k, a)] = { lo: numField(v - OPT_DEFAULT_RANGE), hi: numField(v + OPT_DEFAULT_RANGE) };
      }
    }
    const goals = Object.fromEntries(VEHICLE_GOAL_KINDS.map((k) => [k, { ...o.goals[k], on: on.includes(k) }])) as typeof o.goals;
    return { ...o, ranges, goals };
  });
  return (
    <div className="jm-row">
      <button className="chip on" onClick={() => preset([['ucaFwd', 1], ['ucaAft', 1], ['ucaOut', 1], ['lcaOut', 0], ['trInner', 1], ['trOuter', 1]], ['grip', 'bumpSteer'])}
        title="Every design: UCA pivot and ball-joint heights, LCA ball joint X, tie-rod heights (±25 mm). Goals: total grip and bump steer.">
        Grip → arm geometry
      </button>
      <button className="chip on" onClick={() => preset([['ucaFwd', 1], ['ucaAft', 1], ['lcaFwd', 1], ['lcaAft', 1], ['trInner', 1], ['trOuter', 1]], ['lltd', 'bumpSteer'])}
        title="Every design: arm pivot and tie-rod heights (roll centers). Goals: front share of lateral load transfer and bump steer.">
        Load-transfer split → roll centers
      </button>
      <button className="chip" onClick={() => update(() => defaultVehicleOptimizerSetup())}>Reset</button>
    </div>
  );
}

export function VehicleOptimizePanel() {
  const o = useApp((s) => s.vehicleOptimizer);
  const update = useApp((s) => s.updateVehicleOptimizer);
  const tests = useApp((s) => s.tests);
  const links = useApp((s) => s.links);
  const locks = useApp((s) => s.locks);
  const interacting = useApp((s) => s.interacting);
  const vehOptUndo = useApp((s) => s.vehOptUndo);
  const applyVehicleOptimized = useApp((s) => s.applyVehicleOptimized);
  const undoVehicleOptimized = useApp((s) => s.undoVehicleOptimized);
  const notify = useApp((s) => s.notify);
  const deps = useProblemDeps();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => buildVehicleProblem(useApp.getState()), deps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => mergedCorners(useApp.getState()), deps);
  const roots = designRoots({ links });
  // A result goes stale only when the geometry it started from changes.
  const geomNow = useApp((s) => s.geom);
  const cornersNow = useApp((s) => s.corners);
  const geometryKey = useMemo(() => ({}), [geomNow, cornersNow, links]);

  // "Now" values from the whole-car solve, debounced (one evaluation takes ~0.1–0.3 s).
  const [now, setNow] = useState<Partial<Record<VehicleGoalKind, number | null>> | null>(null);
  useEffect(() => {
    if (interacting) return;
    setNow(null);
    const t = setTimeout(() => {
      const p = built.problem;
      const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
      const e = evaluateVehicle(p, geoms);
      setNow(e ? Object.fromEntries(VEHICLE_GOAL_KINDS.map((k) => [k, vehicleGoalValue(k, p, e)])) : {});
    }, 500);
    return () => clearTimeout(t);
  }, [built, interacting]);

  const setField = (k: 'lateralG' | 'brakingG' | 'accelG' | 'keepClose', text: string) =>
    update((v) => ({ ...v, [k]: parseField(text, 'ratio', v[k]) }));
  const [pickRoot, setPickRoot] = useState<CornerId | null>(null);
  const picked = pickRoot && roots.some((r) => r.root === pickRoot) ? pickRoot : roots[0]!.root;
  const g = all[picked].geom;
  const spec: CoordSpec = {
    key: (k, a) => vehVarKey(picked, k, a),
    value: (k, a) => g.points[k][a].value,
    locked: (k, a) => pointAxisLocked(locks, picked, k, a, g.damperArm),
  };
  const entries: RangeEntry[] = Object.keys(o.ranges).map((key) => ({ key, v: parseVehVarKey(key) })).filter((e) => e.v)
    .sort((a, b) => a.v!.root.localeCompare(b.v!.root) || POINT_KEYS.indexOf(a.v!.k) - POINT_KEYS.indexOf(b.v!.k) || a.key.localeCompare(b.key))
    .map(({ key, v }) => {
      const d: CornerDesign = all[v!.root];
      const live = roots.some((r) => r.root === v!.root);
      return {
        key, k: v!.k, axis: v!.axis, label: `${v!.root} ${POINT_LABELS[v!.k]} ${AXES[v!.axis]}`,
        now: d.geom.points[v!.k][v!.axis].value,
        locked: !live || pointAxisLocked(locks, v!.root, v!.k, v!.axis, d.geom.damperArm),
        lo: o.ranges[key]!.lo, hi: o.ranges[key]!.hi,
      };
    });

  return (
    <div className="inspector optimize-panel">
      <p className="hint">
        Optimizes every corner design together, judged by the whole-car solve in the load cases below.
        Designs: {roots.map((r) => `${r.root}${r.corners.length > 1 ? ` (${r.corners.join(', ')})` : ''}`).join(' · ')}.
        Locked values never move; locked arm dimensions are held. Every step solves the whole car, so a run takes seconds to a minute.
      </p>
      <VehiclePresets />
      {o.goals.lltd.on && !roots.some((r) => r.corners.includes('RL') && !r.corners.includes('FL')) && (
        <p className="hint warn-text">
          Front and rear share one design, so the optimizer can't make them differ, and the front share of load transfer
          (LLTD) depends on exactly that difference. Untick “Rear same dimensions as front” (Corner box) to optimize them separately.
        </p>
      )}
      <Section title="Load cases">
        <div className="jm-row">
          <span className="muted">Use</span>
          <select value={o.caseSource && (o.caseSource === 'all' || tests.some((t) => t.id === o.caseSource)) ? o.caseSource : ''}
            onChange={(e) => update((v) => ({ ...v, caseSource: e.target.value || undefined }))}
            title="Fixed cases below, every segment of one test, or all tests weighted by their priority (Tests workspace)">
            <option value="">Fixed cases (below)</option>
            {tests.length > 1 && <option value="all">All tests (by priority)</option>}
            {tests.map((t) => <option key={t.id} value={t.id}>Test: {t.name}</option>)}
          </select>
        </div>
        {built.problem.states && (
          <p className="hint">Every segment's speed samples of that test are load cases ({built.problem.states?.length ?? 0} states). Turn on <b>Test passes</b> to make every tire stay within its grip.</p>
        )}
        <table className="opt-table">
          <tbody>
            <tr><td>Cornering (left turn)</td><td className="nowrap"><ValueInput field={o.lateralG} unit="g" width={52} onCommit={(t) => setField('lateralG', t)} /> g</td></tr>
            <tr><td>Braking</td><td className="nowrap"><ValueInput field={o.brakingG} unit="g" width={52} onCommit={(t) => setField('brakingG', t)} /> g</td></tr>
            <tr title="Needs powered corners"><td>Accelerating</td><td className="nowrap"><ValueInput field={o.accelG} unit="g" width={52} onCommit={(t) => setField('accelG', t)} /> g</td></tr>
          </tbody>
        </table>
        <p className="hint">0 = off. Grip and contact area are averaged over the cases that are on.</p>
      </Section>
      <Section title="Goals">
        <GoalTable kinds={VEHICLE_GOAL_KINDS} meta={VEHICLE_GOAL_META} goals={o.goals} now={now}
          onChange={(k, patch) => update((v) => ({ ...v, goals: { ...v.goals, [k]: { ...v.goals[k], ...patch } } }))} />
        <table className="opt-table">
          <tbody>
            <tr title="Keeps the result near the current design when the goals alone don't pin it down. 0 = off.">
              <td>Prefer small changes</td>
              <td><ValueInput field={o.keepClose} unit="" width={52} onCommit={(t) => setField('keepClose', t)} /></td>
            </tr>
          </tbody>
        </table>
      </Section>
      <Section title="Tire grip model" open={false}>
        <GripModelFields />
      </Section>
      <FreeCoordinates
        spec={spec} ranges={o.ranges} entries={entries} update={(fn) => update((v) => ({ ...v, ranges: fn(v.ranges) }))}
        header={roots.length > 1 && (
          <div className="jm-row">
            <span className="muted">Design</span>
            {roots.map((r) => (
              <button key={r.root} className={`chip${r.root === picked ? ' on' : ''}`} onClick={() => setPickRoot(r.root)} title={`Used by ${r.corners.join(', ')}`}>{r.root}</button>
            ))}
          </div>
        )}
      />
      <Section title="Run">
        <RunArea
          useRun={useVehicleRun} blockers={built.blockers} meta={VEHICLE_GOAL_META} current={geometryKey}
          label="Optimize vehicle"
          notes={skippedNote(built.skippedLocked, (k) => { const v = parseVehVarKey(k)!; return `${v.root} ${POINT_LABELS[v.k]} ${AXES[v.axis]}`; }, built.problem.holds ?? [])}
          start={(onP) => runVehicleOptimizer(built.problem, onP)}
          onApply={(r) => {
            applyVehicleOptimized(r.variables.map((v) => ({ root: v.root!, key: pointKeyOf(v.point), axis: v.axis, value: v.after })));
            notify('Optimized geometry applied to the corner designs. Undo is in the Optimize tab.');
          }}
          undo={{ available: !!vehOptUndo, run: undoVehicleOptimized }}
        />
      </Section>
    </div>
  );
}
