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
  GOAL_KINDS, GOAL_META, sampleCorner, goalValue, SCALAR_VARIABLES,
  type GoalKind, type GoalMeta, type ProgressInfo, type HardpointId, type Variable, type Hold,
} from '../../core/optimize/corner';
import {
  VEHICLE_GOAL_KINDS, VEHICLE_GOAL_META, evaluateVehicle, vehicleGoalValue, type LateralLimit, type FixedCaseKind,
  type VehicleGoalKind, type VehicleGoalMeta, BOUND_KINDS, BOUND_META, type ActiveBound,
} from '../../core/optimize/vehicle';
import { layoutOf, toGeometry,
  useApp, rootOf, defaultOptimizerSetup, defaultVehicleOptimizerSetup, defaultBounds, mergedCorners,
  POINT_KEYS, POINT_NAMES, activeParam, activePointKeys, OPT_DEFAULT_RANGE, GRIP_KEYS, GRIP_META,
  type Field, type OptimizerSetup, type PointKey, type GoalSetting, type CornerDesign,
  type VehScalar,
} from '../store';
import { adjustmentRanges } from '../testOptimize';
import { CORNER_IDS, type CornerId } from '../../core/vehicle/vehicle';
import { POINT_LABELS, pointLabel } from '../components';
import type { SuspensionKind, DoubleWishboneGeometry } from '../../core/suspension/doubleWishbone';
import { lockKeys, pointAxisLocked } from '../locks';
import { armMetrics } from '../../core/suspension/armGeometry';
import {
  buildProblem, buildVehicleProblem, runOptimizer, runVehicleOptimizer, vehUpdateOf, vehScalarKey, parseVehScalarKey, varKey, parseVarKey, vehVarKey, parseVehVarKey, customVarKey, parseCustomVarKey, customOfVariable,
  pointKeyOf, designRoots, type RunHandle, type RunResult,
} from '../optimizer';
import { ValueInput } from './ValueInput';
import { Section, FieldRows, fmt } from './FieldRows';
import { useDisplay } from '../units';
import { TireGripFields } from './TireGripPanel';
import { SearchSelect, SensitivityReport } from './SearchTools';
import { Local, Val } from './UnitText';

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
                  : 'minimize' in m && m.minimize ? <span className="muted" title="Minimized: as short as possible">min</span>
                  : <>{m.limit && <span className="muted" title="A limit: only a value above it counts">≤ </span>}{'atLeast' in m && m.atLeast && <span className="muted" title="A floor: only a value below it counts">≥ </span>}<ValueInput field={g.target} unit={m.unit} width={50} onCommit={(t) => onChange(k, { target: parseField(t, 'ratio', g.target) })} /></>}
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
  /** Suspension type and spring layout of the design (its points; labels). */
  kind: SuspensionKind;
  layout: 'coilover' | 'rocker';
  steer?: 'rack' | 'arm' | 'centerLink';
}

/** Point grid with X/Y/Z toggles (locked ones show 🔒). */
function CoordPicker({ spec, ranges, onToggle }: { spec: CoordSpec; ranges: Record<string, unknown>; onToggle: (k: PointKey, axis: 0 | 1 | 2) => void }) {
  return (
    <table className="opt-table">
      <tbody>
        {activePointKeys(spec.kind, spec.layout, spec.steer).map((k) => (
          <tr key={k}>
            <td><button className="link-btn" title={`${activeParam(POINT_NAMES[k])} — highlight in the view`} onClick={() => highlight(k)}>{pointLabel(k, spec.kind, spec.layout)}</button></td>
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

interface RangeEntry { key: string; k?: PointKey; axis: 0 | 1 | 2; label: string; now: number; locked: boolean; lo: Field; hi: Field }

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
                {e.k ? <button className="link-btn" onClick={() => highlight(e.k!)}>{e.label}</button> : <span>{e.label}</span>}
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
  return <TireGripFields />;
}

type Report = {
  goals: { kind: string; target: number; before: number | null; after: number | null }[];
  variables: (Variable & { root?: CornerId; before: number; after: number; atLimit: boolean })[];
  /** F28: the characteristic bounds the result is at (vehicle optimizer). */
  atBounds?: ActiveBound[];
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
export const useCornerRun = makeRunStore();
export const useVehicleRun = makeRunStore();

function RunArea({ useRun, blockers, notes, label, start, current, meta, onApply, undo, preview }: {
  useRun: RunStore;
  blockers: string[]; notes: ReactNode; label: string;
  start: (onProgress: (p: ProgressInfo) => void) => RunHandle<Report>;
  current: unknown;
  meta: Record<string, AnyMeta>;
  onApply: (r: Report) => void;
  undo: { available: boolean; run: () => void };
  /** The result's geometry, to show as a ghost in the Corner view before applying. */
  preview?: (r: Report) => DoubleWishboneGeometry | null;
}) {
  const run = useRun();
  const previewing = useApp((s) => !!s.previewGeometry);
  const clearPreview = () => useApp.setState({ previewGeometry: null });
  const disp = useDisplay();
  const go = () => {
    const h = start((p) => useRun.setState({ progress: p }));
    clearPreview();
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
                      {m.maximize ? 'max' : g.kind === 'bumpSteer' ? '0°' : `${m.limit ? '≤ ' : 'atLeast' in m && m.atLeast ? '≥ ' : ''}${disp.text(fmt(g.target, 2), m.unit).text}`}{' '}
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
          {!!run.result.atBounds?.length && (
            <p className="hint warn-text" title="The result sits at (or past) these characteristic limits: widen them under Limits to let it go further">
              At a limit: {atBoundsText(run.result.atBounds)}.
            </p>
          )}
          {stale && <p className="hint warn-text">The design changed since this run. Run again before applying.</p>}
          <div className="jm-row">
            <button className="wide-btn primary" disabled={stale} onClick={() => { clearPreview(); onApply(run.result!); useRun.setState({ result: null, from: null }); }}>Apply to design</button>
            <button className="wide-btn" onClick={() => { clearPreview(); useRun.setState({ result: null, from: null }); }}>Discard</button>
          </div>
          {preview && preview(run.result) && (
            <label className="check-row" title="Draw the optimized design faintly over the current one in the Corner view (it follows the travel and steering sliders) before deciding">
              <input type="checkbox" checked={previewing} onChange={(e) => useApp.setState({ previewGeometry: e.target.checked ? preview(run.result!) : null })} /> Preview in the view (ghost)
            </label>
          )}
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
  useApp((s) => s.cornerLoadMode), useApp((s) => s.autoPreload), useApp((s) => s.tests), useApp((s) => s.steer), useApp((s) => s.steerCurve),
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
      if (pointAxisLocked(locks, root, k, a, geom.damperArm, geom.kind, layoutOf(geom), geom.steerMechanism, geom.steeredAxle)) continue;
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

/** Setup values the corner optimizer can move (key → label, typical ± range, hint). */
const SCALAR_LABEL: Record<string, { label: string; range: number; hint: string }> = {
  staticCamber: { label: 'Static camber (°)', range: 1, hint: 'The wheel\'s camber at ride height (deg): moves with the grip and inclination goals' },
  staticToe: { label: 'Static toe (°)', range: 0.3, hint: 'The wheel\'s toe at ride height (deg)' },
  tirePressure: { label: 'Tire pressure (kPa)', range: 20, hint: 'The set pressure (gas tire model): changes the contact patch and the grip goals' },
};

/** Arm and tie-rod lengths the optimizer must keep within a min / max. */
function LengthRanges({ setup, update }: { setup: OptimizerSetup; update: (fn: (o: OptimizerSetup) => OptimizerSetup) => void }) {
  const geom = useApp((s) => s.geom);
  const g = toGeometry(geom);
  const now = { uca: armMetrics(g.uca).length, lca: armMetrics(g.lca).length, tieRod: Math.hypot(g.tieRod.outer.x - g.tieRod.inner.x, g.tieRod.outer.y - g.tieRod.inner.y, g.tieRod.outer.z - g.tieRod.inner.z) };
  const label = { uca: 'Upper arm length', lca: 'Lower arm length', tieRod: 'Tie-rod length' } as const;
  const lr = setup.lengthRanges ?? {};
  const set = (k: keyof typeof now, v: { lo: Field; hi: Field } | undefined) => update((o) => {
    const next = { ...(o.lengthRanges ?? {}) };
    if (v) next[k] = v; else delete next[k];
    return { ...o, lengthRanges: next };
  });
  return (
    <Section title={`Length ranges (${Object.keys(lr).length})`} open={Object.keys(lr).length > 0}>
      <p className="hint small-text">Keep a length between a min and max while the points move (an arm: pivot axis to ball joint). Lock it instead to hold it exactly.</p>
      <table className="opt-table">
        <thead><tr><th /><th>Now</th><th>Min</th><th>Max</th></tr></thead>
        <tbody>
          {(Object.keys(now) as (keyof typeof now)[]).map((k) => {
            const r = lr[k];
            return (
              <tr key={k}>
                <td><label className="check-label"><input type="checkbox" checked={!!r} onChange={(e) => set(k, e.target.checked ? { lo: numField(Math.round(now[k] - 10)), hi: numField(Math.round(now[k] + 10)) } : undefined)} /> {label[k]}</label></td>
                <td className="mono">{fmt(now[k], 1)}</td>
                <td>{r && <ValueInput field={r.lo} unit="mm" width={56} onCommit={(t) => set(k, { ...r, lo: parseField(t, 'length', r.lo) })} />}</td>
                <td>{r && <ValueInput field={r.hi} unit="mm" width={56} onCommit={(t) => set(k, { ...r, hi: parseField(t, 'length', r.hi) })} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

export function OptimizePanel() {
  const setup = useSetup();
  const update = useApp((s) => s.updateOptimizer);
  const geom = useApp((s) => s.geom);
  const tirePr = useApp((s) => s.tire.pressure.value);
  const gas = useApp((s) => s.tireModel === 'gas');
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
    const s = sampleCorner(p.geometry, { droop: p.droop, bump: p.bump, samples: p.samples, rackPositions: p.rackPositions, rollAngle: p.rollAngle, tire: p.tire, steering: p.steering });
    if (!s) return null;
    return Object.fromEntries(GOAL_KINDS.map((k) => [k, goalValue(k, s, setup.goals[k].target.value)])) as Record<GoalKind, number | null>;
  }, [built, setup, interacting]);

  const setField = (k: 'rollAngle' | 'rackCheck' | 'keepClose' | 'rollLoadFactor', q: Quantity, text: string) =>
    update((o) => ({ ...o, [k]: parseField(text, q, o[k]) }));
  const spec: CoordSpec = {
    key: varKey,
    value: (k, a) => geom.points[k][a].value,
    locked: (k, a) => pointAxisLocked(locks, root, k, a, geom.damperArm, geom.kind, layoutOf(geom), geom.steerMechanism, geom.steeredAxle),
    kind: geom.kind, layout: layoutOf(geom), steer: geom.steerMechanism,
  };
  const entries: RangeEntry[] = Object.keys(setup.ranges).map((key) => ({ key, v: parseVarKey(key) })).filter((e) => e.v)
    .sort((a, b) => POINT_KEYS.indexOf(a.v!.k) - POINT_KEYS.indexOf(b.v!.k) || a.key.localeCompare(b.key))
    .map(({ key, v }) => ({
      key, k: v!.k, axis: v!.axis, label: `${POINT_LABELS[v!.k]} ${AXES[v!.axis]}`,
      now: spec.value(v!.k, v!.axis), locked: spec.locked(v!.k, v!.axis), lo: setup.ranges[key]!.lo, hi: setup.ranges[key]!.hi,
    } as RangeEntry));
  // Setup values: static camber / toe, tire pressure.
  const scalarNow = (k: string) => (k === 'staticCamber' ? geom.scalars.staticCamber.value : k === 'staticToe' ? geom.scalars.staticToe.value : tirePr);
  for (const key of Object.keys(setup.ranges)) {
    const k = key.startsWith('scalar.') ? key.slice(7) : null;
    if (!k || !SCALAR_LABEL[k]) continue;
    entries.push({ key, axis: 0, label: SCALAR_LABEL[k]!.label, now: scalarNow(k), locked: false, lo: setup.ranges[key]!.lo, hi: setup.ranges[key]!.hi });
  }
  // Custom linkage joint points.
  const customPoint = (joint: string, which: 'p' | 'q') => { const j = geom.custom?.joints.find((x) => x.id === joint); return j ? (which === 'q' ? j.q : j.p) : undefined; };
  if (geom.kind === 'custom') {
    for (const key of Object.keys(setup.ranges)) {
      const cv = parseCustomVarKey(key);
      const j = cv && geom.custom?.joints.find((x) => x.id === cv.joint);
      const v = cv && customPoint(cv.joint, cv.which);
      if (!cv || !j || !v) continue;
      entries.push({ key, axis: cv.axis, label: `${j.name}${j.kind === 'ball' ? '' : cv.which === 'p' ? ' (1)' : ' (2)'} ${AXES[cv.axis]}`, now: [v.x, v.y, v.z][cv.axis]!, locked: false, lo: setup.ranges[key]!.lo, hi: setup.ranges[key]!.hi });
    }
  }

  return (
    <div className="inspector optimize-panel">
      <p className="hint">
        Optimizes the <b>{root}</b> design{sharers.length > 1 ? ` (shared with ${sharers.filter((s) => s !== root).join(', ')})` : ''}: it moves only the
        free coordinates, each within its range, to meet the goals. Locked values never move; locked arm dimensions are held.
        Travel range <Val v={-Math.abs(droop)} unit="mm" digits={0} /> to +<Val v={Math.abs(bump)} unit="mm" digits={0} /> (motion bar). For goals across the whole car, use Optimize in the Vehicle view.
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
            <tr>
              <td>Search</td>
              <td><SearchSelect value={setup.starts} onChange={(n) => update((o) => ({ ...o, starts: n }))} /></td>
            </tr>
          </tbody>
        </table>
      </Section>
      <Section title="Tire grip model" open={false}>
        <GripModelFields />
      </Section>
      <FreeCoordinates spec={spec} ranges={setup.ranges} entries={entries} update={(fn) => update((o) => ({ ...o, ranges: fn(o.ranges) }))}
        header={<><table className="opt-table">
          <thead><tr><th>Setup values</th><th /></tr></thead>
          <tbody>
            {Object.entries(SCALAR_LABEL).filter(([k]) => k !== 'tirePressure' || gas).map(([k, m]) => {
              const key = `scalar.${k}`, on = !!setup.ranges[key];
              const isLocked = !!locks[k === 'tirePressure' ? lockKeys.field(root, 'tire', 'pressure') : lockKeys.field(root, 'scalar', k)];
              return (
                <tr key={k} title={m.hint}>
                  <td>{m.label}</td>
                  <td><button className={`chip axis-chip${on ? ' on' : ''}${isLocked ? ' locked' : ''}`} disabled={isLocked && !on}
                    title={isLocked ? 'Locked — the optimizer keeps it' : undefined} onClick={() => update((o) => {
                    const r = { ...o.ranges };
                    if (r[key]) delete r[key];
                    else { const now = scalarNow(k); r[key] = { lo: numField(now - m.range), hi: numField(now + m.range) }; }
                    return { ...o, ranges: r };
                  })}>{isLocked ? 'fixed🔒' : on ? 'free' : 'fixed'}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {geom.kind === 'custom' && geom.custom ? (
          <table className="opt-table">
            <thead><tr><th>Linkage points</th><th /><th /><th /></tr></thead>
            <tbody>
              {geom.custom.joints.flatMap((j) => (j.kind === 'ball' ? ['p'] as const : ['p', 'q'] as const).map((w) => (
                <tr key={`${j.id}-${w}`}>
                  <td>{j.name}{j.kind === 'ball' ? '' : w === 'p' ? ' (1)' : ' (2)'}</td>
                  {([0, 1, 2] as const).map((a) => {
                    const key = customVarKey(j.id, w, a);
                    const on = !!setup.ranges[key];
                    const v = customPoint(j.id, w);
                    return (
                      <td key={a}>
                        <button className={`chip axis-chip${on ? ' on' : ''}`} title={on ? 'Free: click to fix' : 'Fixed: click to let the optimizer move it'}
                          onClick={() => update((o) => {
                            const r = { ...o.ranges };
                            if (r[key]) delete r[key];
                            else if (v) { const now = [v.x, v.y, v.z][a]!; r[key] = { lo: numField(now - OPT_DEFAULT_RANGE), hi: numField(now + OPT_DEFAULT_RANGE) }; }
                            return { ...o, ranges: r };
                          })}>{AXES[a]}</button>
                      </td>
                    );
                  })}
                </tr>
              )))}
            </tbody>
          </table>
        ) : null}</>} />
      <LengthRanges setup={setup} update={update} />
      <Section title="Run">
        <RunArea
          useRun={useCornerRun} blockers={built.blockers} meta={GOAL_META} current={geom}
          label={`Optimize ${sharers.length > 1 ? `${root} (+ ${sharers.length - 1} linked)` : root}`}
          notes={skippedNote(built.skippedLocked, (k) => {
            if (k.startsWith('scalar.')) return SCALAR_LABEL[k.slice(7) as keyof typeof SCALAR_LABEL]?.label ?? k;
            const v = parseVarKey(k);
            return v ? `${POINT_LABELS[v.k]} ${AXES[v.axis]}` : k;
          }, built.problem.holds ?? [])}
          start={(onP) => runOptimizer(built.problem, onP)}
          preview={(r) => (r as unknown as { geometry?: DoubleWishboneGeometry }).geometry ?? null}
          onApply={(r) => {
            // Setup values into their fields.
            const st = useApp.getState();
            for (const v of r.variables) {
              if (v.point === 'staticCamber' || v.point === 'staticToe') st.setScalar(v.point, String(Number(v.after.toFixed(4))));
              else if (v.point === 'tirePressure') st.setTireField('pressure', String(Number(v.after.toFixed(2))));
            }
            // Hardpoints through the optimizer's apply (its Undo); a custom linkage's joint points into the linkage.
            const pts = r.variables.filter((v) => !customOfVariable(v.point) && !(SCALAR_VARIABLES as readonly string[]).includes(v.point));
            if (pts.length) applyOptimized(pts.map((v) => ({ key: pointKeyOf(v.point), axis: v.axis, value: v.after })));
            const cust = r.variables.filter((v) => customOfVariable(v.point));
            const c0 = useApp.getState().geom.custom;
            if (cust.length && c0) {
              const joints = c0.joints.map((j) => {
                let out = j;
                for (const v of cust) {
                  const cv = customOfVariable(v.point)!;
                  if (cv.joint !== j.id) continue;
                  const p = cv.which === 'q' ? out.q : out.p;
                  if (!p) continue;
                  const np = { ...p, [AXES[v.axis].toLowerCase()]: v.after };
                  out = { ...out, [cv.which]: np };
                }
                return out;
              });
              useApp.getState().setCustom({ ...c0, joints });
            }
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
        if (pointAxisLocked(s.locks, root, k, a, g.damperArm, g.kind, layoutOf(g), g.steerMechanism, g.steeredAxle)) continue;
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

/** "KPI (FL, FR) 20° max · Trail (RL) 0 mm min" — the bounds a result is at, grouped by kind and side. */
export function atBoundsText(list: ActiveBound[]): string {
  const groups = new Map<string, { a: ActiveBound; roots: string[] }>();
  for (const a of list) {
    const k = `${a.kind}.${a.side}`;
    const g = groups.get(k) ?? { a, roots: [] };
    if (a.root) g.roots.push(a.root);
    groups.set(k, g);
  }
  return [...groups.values()].map(({ a, roots }) => `${BOUND_META[a.kind].label}${roots.length ? ` (${roots.join(', ')})` : ''} ${fmt(a.bound, 2)} ${BOUND_META[a.kind].unit} ${a.side}${a.held ? ` (held at its start value, past the ${fmt(a.set!, 2)} limit)` : ''}`).join(' · ');
}

/**
 * F28 (round 5): bounds on the characteristics. The optimizer moves the points for the goals; these keep it from
 * wandering into what no one would build. Generic and wide (the same for every car); past one costs heavily.
 */
function Limits() {
  const o = useApp((s) => s.vehicleOptimizer);
  const update = useApp((s) => s.updateVehicleOptimizer);
  const setB = (k: (typeof BOUND_KINDS)[number], fn: (b: (typeof o.bounds)[typeof k]) => (typeof o.bounds)[typeof k]) =>
    update((v) => ({ ...v, bounds: { ...v.bounds, [k]: fn(v.bounds[k]) } }));
  const setN = (k: (typeof BOUND_KINDS)[number], which: 'min' | 'max', text: string) => {
    const n = Number(text);
    if (Number.isFinite(n)) setB(k, (b) => ({ ...b, [which]: { text, value: n } }));
  };
  const on = BOUND_KINDS.filter((k) => o.bounds[k].on).length;
  return (
    <Section title={`Limits (${on} on)`} open={false}>
      <p className="hint">Bounds on the characteristics: inside them the optimizer is free; past one costs heavily, so it stops there. They are wide and generic on purpose (the same for every car and use) — they only stop designs no one would build. The steering ones apply to steered designs; anti-dive and anti-squat to the car. These also apply to the Tests optimizer.</p>
      <label className="check-row" title="When the Tests optimizer reaches a limit (or an adjustment's range end), ask whether to let it go further. Off: it stays within them.">
        <input type="checkbox" checked={o.askLimits} onChange={(e) => update((v) => ({ ...v, askLimits: e.target.checked }))} /> Ask before going past a limit
      </label>
      <table className="opt-table">
        <thead><tr><th>On</th><th>Characteristic</th><th>Min</th><th>Max</th></tr></thead>
        <tbody>
          {BOUND_KINDS.map((k) => {
            const b = o.bounds[k], m = BOUND_META[k];
            return (
              <tr key={k} title={m.hint}>
                <td><input type="checkbox" checked={b.on} onChange={(e) => setB(k, (x) => ({ ...x, on: e.target.checked }))} /></td>
                <td>{m.label}</td>
                <td className="nowrap"><input key={`${k}.min.${b.min.text}`} type="number" style={{ width: 60 }} disabled={!b.on} defaultValue={b.min.text} onBlur={(e) => setN(k, 'min', e.target.value)} /></td>
                <td className="nowrap"><input key={`${k}.max.${b.max.text}`} type="number" style={{ width: 60 }} disabled={!b.on} defaultValue={b.max.text} onBlur={(e) => setN(k, 'max', e.target.value)} /> <span className="unit">{m.unit}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="jm-row">
        <button className="chip" onClick={() => update((v) => ({ ...v, bounds: defaultBounds() }))}>Default limits</button>
      </div>
    </Section>
  );
}

const ADJ_LABEL: Record<VehScalar, string> = { staticCamber: 'Static camber', staticToe: 'Static toe', tirePressure: 'Tire pressure', rideHeight: 'Ride height' };
const ADJ_UNIT: Record<VehScalar, string> = { staticCamber: '°', staticToe: '°', tirePressure: 'kPa', rideHeight: 'mm' };

/**
 * Round 5: the vehicle optimizer's other variables — what a mechanic adjusts without moving a pickup point: each
 * design's static camber, toe and tire pressure, each axle's static ride height. Free / fixed and their ranges.
 */
function Adjustments({ roots, all, ranges, update }: {
  roots: CornerId[]; all: Record<CornerId, CornerDesign>; ranges: Record<string, { lo: Field; hi: Field }>;
  update: (fn: (r: Record<string, { lo: Field; hi: Field }>) => Record<string, { lo: Field; hi: Field }>) => void;
}) {
  const rideHeight = useApp((s) => s.rideHeight);
  const rows: { key: string; label: string; name: VehScalar; now: string }[] = [];
  for (const root of roots) {
    const d = all[root];
    rows.push({ key: vehScalarKey(root, 'staticCamber'), label: `${root} static camber`, name: 'staticCamber', now: d.geom.scalars.staticCamber.text });
    rows.push({ key: vehScalarKey(root, 'staticToe'), label: `${root} static toe`, name: 'staticToe', now: d.geom.scalars.staticToe.text });
    if (d.tireModel === 'gas') rows.push({ key: vehScalarKey(root, 'tirePressure'), label: `${root} tire pressure`, name: 'tirePressure', now: d.tire.pressure.text });
  }
  for (const [root, axle] of [['FL', 'front'], ['RL', 'rear']] as const) {
    rows.push({ key: vehScalarKey(root, 'rideHeight'), label: `Ride height, ${axle}`, name: 'rideHeight', now: rideHeight.on ? rideHeight[axle].text : 'design' });
  }
  const setBound = (key: string, which: 'lo' | 'hi', text: string) => update((r) => {
    const n = Number(text);
    return r[key] && Number.isFinite(n) ? { ...r, [key]: { ...r[key]!, [which]: { text, value: n } } } : r;
  });
  const free = (key: string, on: boolean) => update((r) => {
    if (!on) { const { [key]: _drop, ...rest } = r; void _drop; return rest; }
    const def = adjustmentRanges(useApp.getState())[key];
    return def ? { ...r, [key]: def } : r;
  });
  return (
    <Section title="Adjustments" open={rows.some((x) => ranges[x.key])}>
      <p className="hint">What a mechanic sets without moving a pickup point: static camber and toe (the wheel's alignment at the design position — moving points changes how they change with travel, not these), tire pressure (gas tire model) and ride height (the spring preload). Free ones move with the points; locked ones (Locks tab) can't be freed.</p>
      <div className="jm-row">
        <button className="chip" onClick={() => update((r) => ({ ...r, ...adjustmentRanges(useApp.getState()) }))} title="Free every adjustment that isn't locked, with its default range">Free all</button>
        <button className="chip" onClick={() => update((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !parseVehScalarKey(k))))} title="Fix every adjustment">Fix all</button>
      </div>
      <table className="opt-table">
        <thead><tr><th>Free</th><th>Adjustment</th><th>Now</th><th>Range</th></tr></thead>
        <tbody>
          {rows.map((x) => {
            const r = ranges[x.key];
            return (
              <tr key={x.key}>
                <td><input type="checkbox" checked={!!r} onChange={(e) => free(x.key, e.target.checked)} /></td>
                <td>{x.label}</td>
                <td className="num">{x.now} {x.now !== 'design' ? ADJ_UNIT[x.name] : ''}</td>
                <td className="nowrap">{r ? (
                  <>
                    <input type="number" style={{ width: 64 }} defaultValue={r.lo.text} onBlur={(e) => setBound(x.key, 'lo', e.target.value)} />
                    {' – '}
                    <input type="number" style={{ width: 64 }} defaultValue={r.hi.text} onBlur={(e) => setBound(x.key, 'hi', e.target.value)} /> {ADJ_UNIT[x.name]}
                  </>
                ) : <span className="muted">fixed</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
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
  const [limitNow, setLimitNow] = useState<LateralLimit | null>(null);
  useEffect(() => {
    if (interacting) return;
    setNow(null);
    setLimitNow(null);
    const t = setTimeout(() => {
      const p = built.problem;
      const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
      const e = evaluateVehicle(p, geoms);
      setNow(e ? Object.fromEntries(VEHICLE_GOAL_KINDS.map((k) => [k, vehicleGoalValue(k, p, e)])) : {});
      setLimitNow(e?.limit ?? null);
    }, 500);
    return () => clearTimeout(t);
  }, [built, interacting]);

  const setField = (k: 'lateralG' | 'brakingG' | 'accelG' | 'keepClose' | 'combinedLatG' | 'combinedBrakeG', text: string) =>
    update((v) => ({ ...v, [k]: parseField(text, 'ratio', v[k] ?? { text: '0', value: 0 }) }));
  const zeroG = { text: '0', value: 0 };
  const weightCell = (k: FixedCaseKind, on: boolean) => (
    <td title="Weight of this case in the averaged goals (total grip, contact area, test reserve) and in Test passes">
      {on && <input type="number" min={0} step={0.5} style={{ width: 48 }} value={o.caseWeights?.[k] ?? 1}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0) update((v) => ({ ...v, caseWeights: { ...v.caseWeights, [k]: n } })); }} />}
    </td>
  );
  const combinedOn = !!(o.combinedLatG?.value && o.combinedBrakeG?.value);
  const [pickRoot, setPickRoot] = useState<CornerId | null>(null);
  const picked = pickRoot && roots.some((r) => r.root === pickRoot) ? pickRoot : roots[0]!.root;
  const g = all[picked].geom;
  const spec: CoordSpec = {
    key: (k, a) => vehVarKey(picked, k, a),
    value: (k, a) => g.points[k][a].value,
    locked: (k, a) => pointAxisLocked(locks, picked, k, a, g.damperArm, g.kind, layoutOf(g), g.steerMechanism, g.steeredAxle),
    kind: g.kind, layout: layoutOf(g), steer: g.steerMechanism,
  };
  const entries: RangeEntry[] = Object.keys(o.ranges).map((key) => ({ key, v: parseVehVarKey(key) })).filter((e) => e.v)
    .sort((a, b) => a.v!.root.localeCompare(b.v!.root) || POINT_KEYS.indexOf(a.v!.k) - POINT_KEYS.indexOf(b.v!.k) || a.key.localeCompare(b.key))
    .map(({ key, v }) => {
      const d: CornerDesign = all[v!.root];
      const live = roots.some((r) => r.root === v!.root);
      return {
        key, k: v!.k, axis: v!.axis, label: `${v!.root} ${POINT_LABELS[v!.k]} ${AXES[v!.axis]}`,
        now: d.geom.points[v!.k][v!.axis].value,
        locked: !live || pointAxisLocked(locks, v!.root, v!.k, v!.axis, d.geom.damperArm, d.geom.kind, layoutOf(d.geom), d.geom.steerMechanism, d.geom.steeredAxle),
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
          <thead><tr><th /><th>g</th><th>Weight</th></tr></thead>
          <tbody>
            <tr><td>Cornering (left turn)</td><td className="nowrap"><ValueInput field={o.lateralG} unit="g" width={52} onCommit={(t) => setField('lateralG', t)} /> g</td>{weightCell('lateral', o.lateralG.value > 0)}</tr>
            <tr><td>Braking</td><td className="nowrap"><ValueInput field={o.brakingG} unit="g" width={52} onCommit={(t) => setField('brakingG', t)} /> g</td>{weightCell('braking', o.brakingG.value > 0)}</tr>
            <tr title="Needs powered corners"><td>Accelerating</td><td className="nowrap"><ValueInput field={o.accelG} unit="g" width={52} onCommit={(t) => setField('accelG', t)} /> g</td>{weightCell('accel', o.accelG.value > 0)}</tr>
            <tr title="Trail braking: cornering and braking at once (both on = the case is on). The outside front tire carries the most load.">
              <td>Braking in a turn</td>
              <td className="nowrap">
                <ValueInput field={o.combinedLatG ?? zeroG} unit="g" width={44} onCommit={(t) => setField('combinedLatG', t)} /> lat
                {' '}<ValueInput field={o.combinedBrakeG ?? zeroG} unit="g" width={44} onCommit={(t) => setField('combinedBrakeG', t)} /> brake
              </td>
              {weightCell('combined', combinedOn)}
            </tr>
          </tbody>
        </table>
        <p className="hint">0 = off. Grip, contact area and test reserve are averaged over the cases that are on, by weight. The cornering limit goal finds its own cases.</p>
      </Section>
      <Section title="Goals">
        <GoalTable kinds={VEHICLE_GOAL_KINDS} meta={VEHICLE_GOAL_META} goals={o.goals} now={now}
          onChange={(k, patch) => update((v) => ({ ...v, goals: { ...v.goals, [k]: { ...v.goals[k], ...patch } } }))} />
        {o.goals.lateralLimit.on && limitNow && (
          <p className="hint">
            Now: the {limitNow.axle} axle runs out of grip first at {limitNow.g.toFixed(3)} g, with the {limitNow.axle === 'front' ? 'rear' : 'front'} at {(limitNow.other * 100).toFixed(0)}%
            {limitNow.axle === 'front' ? ' (the car pushes wide at the limit).' : ' (the rear slides at the limit).'} The closer the other axle is to 100%, the more of the car's grip is used.
          </p>
        )}
        <table className="opt-table">
          <tbody>
            <tr title="Keeps the result near the current design when the goals alone don't pin it down. 0 = off.">
              <td>Prefer small changes</td>
              <td><ValueInput field={o.keepClose} unit="" width={52} onCommit={(t) => setField('keepClose', t)} /></td>
            </tr>
            <tr>
              <td>Search</td>
              <td><SearchSelect value={o.starts} onChange={(n) => update((v) => ({ ...v, starts: n }))} /></td>
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
      <Adjustments roots={roots.map((r) => r.root)} all={all} ranges={o.ranges} update={(fn) => update((v) => ({ ...v, ranges: fn(v.ranges) }))} />
      <Limits />
      <Section title="What matters most" open={false}>
        <SensitivityReport build={() => buildVehicleProblem(useApp.getState())} current={geometryKey} what="the optimizer's miss" />
      </Section>
      <Section title="Run">
        <RunArea
          useRun={useVehicleRun} blockers={built.blockers} meta={VEHICLE_GOAL_META} current={geometryKey}
          label="Optimize vehicle"
          notes={skippedNote(built.skippedLocked, (k) => { const sv = parseVehScalarKey(k); if (sv) return `${sv.name === 'rideHeight' ? (sv.root === 'FL' ? 'front' : 'rear') : sv.root} ${ADJ_LABEL[sv.name].toLowerCase()}`; const v = parseVehVarKey(k)!; return `${v.root} ${POINT_LABELS[v.k]} ${AXES[v.axis]}`; }, built.problem.holds ?? [])}
          start={(onP) => runVehicleOptimizer(built.problem, onP)}
          onApply={(r) => {
            applyVehicleOptimized(r.variables.map((v) => vehUpdateOf(v, v.after)));
            notify('Optimized geometry applied to the corner designs. Undo is in the Optimize tab.');
          }}
          undo={{ available: !!vehOptUndo, run: undoVehicleOptimized }}
        />
      </Section>
    </div>
  );
}
