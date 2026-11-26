/**
 * The Results tab (R9; "Compare" until round 5): the current design's results — its vehicles, its tests, its setup
 * character — on their own, or against a snapshot (another design: model, tests, results) when one is picked.
 * - Left: the snapshots (take, import, pick the one compared, remove), what to compare, and running it.
 * - Right: *Vehicles* — the Corner results of both (the active corner, at the current travel / steer), their
 *   curves overlaid, and the design values that differ; *Tests* — both models on both sets of tests (the
 *   scores side by side, with the snapshot's saved last run), and the whole car's results of both.
 *   Any row can be pinned (☆): pinned rows are listed first, so the ones that matter needn't be searched for.
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { useApp, type DesignState } from '../store';
import { DesignOverride, withActiveCorner, type DesignOverrideValue } from '../designOverride';
import { useModel, type Model } from '../useModel';
import { useVehicle, type VehicleModel } from '../useVehicle';
import { cornerResultRows, vehicleResultRows, type ResultRow } from '../resultRows';
import { useSnapshots, takeSnapshot, importSnapshot, removeSnapshot, setActiveSnapshot, type Snapshot } from '../snapshots';
import { useCompare, runCompare, runKey, designDifferences, compareTests, type CompareTest } from '../compare';
import { useRun, currentResult } from './TestsPanels';
import { Section, fmt } from './FieldRows';
import { CharacterPanel } from './CharacterPanel';
import { Plots } from './Plots';
import { useDisplay } from '../units';
import type { TestRun, PlaybackFrame } from '../../core/tests/run';
import { usePlayback, framePatch, frameAt } from './Playback';
import type { SavedResult } from '../savedResults';
import type { Severity } from '../../core/tests/checks';

export type CompareMode = 'vehicles' | 'tests' | 'character';
const loadPins = (): string[] => { try { return JSON.parse(localStorage.getItem('susp.comparePins') ?? '[]') as string[]; } catch { return []; } };
export const useCompareView = create<{ mode: CompareMode; pins: string[]; onlyDiff: boolean; picked: string | null }>(() => ({ mode: 'vehicles', pins: loadPins(), onlyDiff: false, picked: null }));
/** Vehicles: the cars at the Vehicle view's sliders (no playback pose). */
export function setCompareMode(mode: CompareMode) {
  useCompareView.setState({ mode });
  if (mode !== 'tests') { usePlayback.setState({ playing: false }); useApp.setState({ rideView: null }); }
  else { const row = pickedRow(); if (row) pickRow(row); }
}
/** The row shown in the 3D views and played (Tests): its runs' frames, the current design's driven, the snapshot's as the ghost. */
export const pickedRow = (): CompareTest | null => {
  const c = useCompare.getState();
  // (Without a snapshot or a run here, the current design's own tests.)
  const rows = c.rows.length ? c.rows : compareTests(useApp.getState().tests, []);
  return rows.find((r) => r.key === useCompareView.getState().picked) ?? rows[0] ?? null;
};
export function pickRow(row: CompareTest) {
  useCompareView.setState({ picked: row.key });
  const run = useCompare.getState().runs[runKey(row, 'A')] ?? (row.a ? currentResult(row.a.id) ?? undefined : undefined);
  const frames = run?.ride?.frames ?? [];
  const test = (row.a ?? row.b)!;
  const s = useApp.getState();
  usePlayback.setState({ testId: test.id, frames, t: 0, playing: false, error: null, computing: false, from: { geom: s.geom, corners: s.corners, test } });
  if (frames[0]) useApp.setState(framePatch(frames[0]));
}
/** The snapshot's frames for the picked row (its ghost car). */
export const ghostFrames = (row: CompareTest | null): PlaybackFrame[] => (row ? useCompare.getState().runs[runKey(row, 'B')]?.ride?.frames ?? [] : []);
function togglePin(key: string) {
  const pins = useCompareView.getState().pins;
  const next = pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
  useCompareView.setState({ pins: next });
  try { localStorage.setItem('susp.comparePins', JSON.stringify(next)); } catch { /* private mode */ }
}

const SEV_ICON: Record<Severity, string> = { pass: '✓', warn: '⚠', fail: '✗' };
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(); };

/** Left: the snapshots and what to compare. */
export function CompareSidebar() {
  const { list, activeId } = useSnapshots();
  const mode = useCompareView((s) => s.mode);
  const input = useRef<HTMLInputElement>(null);
  const cmp = useCompare();
  const active = list.find((x) => x.id === activeId) ?? null;
  return (
    <div className="compare-side">
      <Section title="Compare with a snapshot">
        <p className="hint">Optional: another whole design — model, tests and their last results — to set beside the current one. Each is its own file; the list lasts while the page is open.</p>
        <div className="jm-row">
          <button className="wide-btn" onClick={() => takeSnapshot()} title="Save the current design (model, tests and their up-to-date results) as a file and add it here">Take snapshot</button>
          <button className="wide-btn" onClick={() => input.current?.click()} title="Any project file as a snapshot (the current design stays as it is)">Import…</button>
        </div>
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSnapshot(f); e.target.value = ''; }} />
        {!list.length && <p className="muted small-text">No snapshots yet: the results are the current design's alone.</p>}
        <ul className="snapshot-list">
          {list.length > 0 && (
            <li className={activeId === null ? 'on' : ''}>
              <label><input type="radio" name="snapshot" checked={activeId === null} onChange={() => setActiveSnapshot(null)} /> <span><b>None</b><br /><span className="muted small-text">the current design alone</span></span></label>
            </li>
          )}
          {list.map((sn) => (
            <li key={sn.id} className={sn.id === activeId ? 'on' : ''}>
              <label title={sn.fileName}>
                <input type="radio" name="snapshot" checked={sn.id === activeId} onChange={() => setActiveSnapshot(sn.id)} />
                <span><b>{sn.name}</b><br /><span className="muted small-text">{sn.source === 'taken' ? 'taken' : 'imported'} {when(sn.takenAt)} · {sn.design.tests.length} test{sn.design.tests.length === 1 ? '' : 's'} · {Object.keys(sn.results).length} result{Object.keys(sn.results).length === 1 ? '' : 's'}</span></span>
              </label>
              <button className="icon-btn" title={`Remove “${sn.name}” from the list (its file stays)`} onClick={() => removeSnapshot(sn.id)}>✕</button>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Show">
        <div className="jm-row" role="tablist">
          <button className={`chip${mode === 'vehicles' ? ' on' : ''}`} onClick={() => setCompareMode('vehicles')} title="The two cars: the Corner results, their curves, and the design values that differ">Vehicles</button>
          <button className={`chip${mode === 'tests' ? ' on' : ''}`} onClick={() => setCompareMode('tests')} title="Both cars on both sets of tests: the scores side by side, and the whole car's results">Tests</button>
          <button className={`chip${mode === 'character' ? ' on' : ''}`} onClick={() => setCompareMode('character')} title="The setup's character: each axle's characteristics against the ranges typical for each kind of driving (no snapshot needed)">Character</button>
        </div>
        {mode === 'tests' && (
          <>
            {!cmp.running
              ? (active
                ? <button className="wide-btn primary" onClick={() => void runCompare(active)} title="Run the current design and the snapshot on every ticked test of both (a track both have runs once per design)">▶ Run both on both sets of tests</button>
                : <button className="wide-btn primary" onClick={() => void runCompare(null)} title="Run the current design on every ticked test">▶ Run all tests</button>)
              : <div className="jm-row"><span className="muted">Running {cmp.done} of {cmp.total}…</span><button className="wide-btn" onClick={() => cmp.cancel?.()}>Stop</button></div>}
            {cmp.error && <p className="hint warn-text">{cmp.error}</p>}
          </>
        )}
        {!active && <p className="hint">The current design alone; take or import a snapshot (above) to see another design beside it.</p>}
      </Section>
    </div>
  );
}

export interface SnapshotModels { corner: Model; vehicle: VehicleModel | null }

/**
 * The snapshot's models, worked out by the same hooks with its design in place (the app's sliders kept; the
 * same active corner). Comparing tests, its car is posed by its own run at the playhead (its ghost).
 * Rendered once (App) and handed to the tables and the 3D views.
 */
/**
 * The snapshot's design as the model hooks should see it (null: none): the same active corner as the app;
 * comparing tests, posed by its own run at the playhead (its ghost). Each consumer works its models out
 * itself under a DesignOverride — nothing is handed back up (an earlier hand-over through the App's state,
 * repeated at every slider / playback tick, piled up into React's "maximum update depth" inside the play
 * loop, which then stopped while still showing ❚❚).
 */
export function useSnapshotDesign(on = true): DesignOverrideValue | null {
  const snap = useSnapshots((s) => (on ? s.list.find((x) => x.id === s.activeId) ?? null : null));
  const activeCorner = useApp((s) => s.activeCorner);
  const mode = useCompareView((s) => s.mode);
  const picked = useCompareView((s) => s.picked);
  const runs = useCompare((s) => s.runs);
  const t = usePlayback((s) => (on && mode === 'tests' ? s.t : 0));
  const base = useMemo(() => (snap ? withActiveCorner(snap.design, activeCorner) : null), [snap, activeCorner]);
  const frames = useMemo(() => (on && mode === 'tests' ? ghostFrames(pickedRow()) : []), [on, mode, picked, runs]); // eslint-disable-line react-hooks/exhaustive-deps
  const frame = frames.length ? frameAt(frames, t) : undefined;
  return useMemo(() => (base && frame ? { ...base, ...framePatch(frame) } : base), [base, frame]);
}

/** The snapshot's car for a 3D view (`on`: in Compare), drawn as its ghost; null otherwise. */
export function WithGhost({ on, children }: { on: boolean; children: (ghost: VehicleModel | null) => ReactNode }) {
  const value = useSnapshotDesign(on);
  return <DesignOverride.Provider value={value}><GhostInner on={!!value}>{children}</GhostInner></DesignOverride.Provider>;
}
function GhostInner({ on, children }: { on: boolean; children: (ghost: VehicleModel | null) => ReactNode }) {
  const ghost = useVehicle(on);
  return <>{children(on ? ghost : null)}</>;
}

/**
 * A value that, while `on`, changes at most every `ms` (the last one shown after a pause). The tables follow the
 * playback a few times a second instead of every frame: in turns each frame costs more to work out, and the
 * panel recomputing the snapshot and redrawing all its rows each frame made the playback lag.
 */
function useThrottled<T>(v: T, ms: number, on: boolean): T {
  const [shown, setShown] = useState(v);
  const last = useRef(0);
  const latest = useRef(v);
  latest.current = v;
  const timer = useRef(0);
  useEffect(() => {
    if (!on || timer.current) return;
    // Outside React's commit (a timer), so a stream of ticks never chains updates.
    timer.current = window.setTimeout(() => { timer.current = 0; last.current = performance.now(); setShown(latest.current); }, Math.max(0, ms - (performance.now() - last.current)));
  }, [v, on, ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return on ? shown : v;
}
const usePlaying = () => {
  const pb = usePlayback((s) => s.playing);
  const app = useApp((s) => s.playingLateral || s.playingLongitudinal || s.playingSteer);
  return pb || app;
};

/** Right: the comparison (the snapshot's models worked out here; while playing, 5 times a second). */
export function CompareResults({ corner, vehicle }: { corner: Model; vehicle: VehicleModel | null }) {
  const snap = useSnapshots((s) => s.list.find((x) => x.id === s.activeId) ?? null);
  const playing = usePlaying();
  const value = useThrottled(useSnapshotDesign(true), 200, playing);
  const cornerT = useThrottled(corner, 200, playing), vehicleT = useThrottled(vehicle, 200, playing);
  const a = useMemo(() => ({ corner: cornerT, vehicle: vehicleT }), [cornerT, vehicleT]);
  const mode = useCompareView((s) => s.mode);
  // F29: the setup's character needs no snapshot (the snapshot's shown alongside when there is one).
  if (mode === 'character') return <CharacterPanel snap={snap} />;
  // No snapshot: the current design's results on their own.
  if (!snap || !value) return <CompareBody a={a} b={null} snap={null} />;
  return <DesignOverride.Provider value={value}><ResultsInner a={a} snap={snap} /></DesignOverride.Provider>;
}
function ResultsInner({ a, snap }: { a: { corner: Model; vehicle: VehicleModel | null }; snap: Snapshot }) {
  const m = useModel();
  const vehicle = useVehicle(true);
  // useModel answers a new object each render: one per set of parts, so the body redraws only when they change.
  const corner = useMemo(() => m, [m.error, m.corner, m.sweep, m.current, m.steerSweep, m.damperLimits]); // eslint-disable-line react-hooks/exhaustive-deps
  const b = useMemo(() => ({ corner, vehicle }), [corner, vehicle]);
  return <CompareBody a={a} b={b} snap={snap} />;
}

interface Pair { key: string; group: string; label: string; unit: string; digits: number; hint?: string; a?: ResultRow; b?: ResultRow }
const pairRows = (prefix: string, as: ResultRow[], bs: ResultRow[]): Pair[] => {
  const out = new Map<string, Pair>();
  for (const [side, rows] of [['a', as], ['b', bs]] as const) {
    for (const r of rows) {
      const key = `${prefix}|${r.group}|${r.label}`;
      const p = out.get(key) ?? { key, group: r.group, label: r.label, unit: r.unit, digits: r.digits, ...(r.hint ? { hint: r.hint } : {}) };
      p[side] = r;
      out.set(key, p);
    }
  }
  return [...out.values()];
};
const differs = (p: Pair) => {
  const a = p.a?.value, b = p.b?.value;
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return (p.a?.text ?? String(a)) !== (p.b?.text ?? String(b));
  return Math.abs(a - b) >= 0.5 * 10 ** -p.digits;
};

const CompareBody = memo(function CompareBody({ a, b, snap }: { a: { corner: Model; vehicle: VehicleModel | null }; b: { corner: Model; vehicle: VehicleModel | null } | null; snap: Snapshot | null }) {
  const mode = useCompareView((s) => s.mode);
  const damperA = useApp((s) => s.damper);
  const current = useApp((s) => s.corners), geom = useApp((s) => s.geom), links = useApp((s) => s.links);
  const activeCorner = useApp((s) => s.activeCorner);
  const bDamper = snap ? withActiveCorner(snap.design, activeCorner).damper : null;
  const cornerPairs = pairRows('corner', cornerResultRows(a.corner, { bump: damperA.bumpDamping.value, rebound: damperA.reboundDamping.value }), b && bDamper ? cornerResultRows(b.corner, { bump: bDamper.bumpDamping.value, rebound: bDamper.reboundDamping.value }) : []);
  const vehiclePairs = pairRows('vehicle', vehicleResultRows(a.vehicle), b ? vehicleResultRows(b.vehicle) : []);
  // The design values that differ (recomputed when either design changes).
  const diffs = useMemo(() => (snap ? designDifferences(useApp.getState(), snap.design) : []), [snap, current, geom, links]); // eslint-disable-line react-hooks/exhaustive-deps
  const single = !snap || !b;
  return (
    <section className="panel compare-panel">
      <h2>Results</h2>
      <p className="small-text muted compare-who">{snap ? <>Current design · snapshot “{snap.name}” ({snap.source === 'taken' ? 'taken' : 'imported'} {when(snap.takenAt)})</> : 'Current design (no snapshot to compare with)'}</p>
      {mode === 'vehicles' ? (
        <>
          <PairTable title={`Corner results (${activeCorner})`} pairs={cornerPairs} single={single} />
          {snap && (
            <Section title={`Design values that differ (${diffs.length})`} open={diffs.length > 0 && diffs.length < 40}>
              {diffs.length ? <DiffTable diffs={diffs} /> : <p className="muted small-text">The two models are the same.</p>}
            </Section>
          )}
          <PairTable title="Vehicle results (the Vehicle view’s state)" pairs={vehiclePairs} single={single} />
          <Plots model={a.corner} {...(b ? { other: b.corner } : {})} />
        </>
      ) : (
        <>
          <TestScores snap={snap} />
          <PairTable title="Vehicle results (the Vehicle view’s state)" pairs={vehiclePairs} single={single} />
        </>
      )}
    </section>
  );
});

/** Rows of both designs: pinned first, then by group; optionally only the ones that differ. */
function PairTable({ title, pairs, single = false }: { title: string; pairs: Pair[]; single?: boolean }) {
  const pins = useCompareView((s) => s.pins);
  const onlyDiff = useCompareView((s) => s.onlyDiff);
  const d = useDisplay();
  const pinned = pairs.filter((p) => pins.includes(p.key));
  const rest = pairs.filter((p) => !pins.includes(p.key) && (single || !onlyDiff || differs(p)));
  const groups = [...new Set(rest.map((p) => p.group))];
  const cell = (r: ResultRow | undefined, unit: string, digits: number) => (r?.text ?? (r?.value === undefined || !Number.isFinite(r.value) ? '—' : d.text(fmt(r.value, digits), unit).text));
  const delta = (p: Pair) => {
    const x = p.a?.value, y = p.b?.value;
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y) || !differs(p)) return '';
    const t = d.text(fmt(x - y, p.digits), p.unit).text;
    return x - y > 0 ? `+${t}` : t;
  };
  const Row = ({ p }: { p: Pair }) => (
    <tr className={!single && differs(p) ? 'differs' : ''} title={p.hint}>
      <td><button className={`pin${pins.includes(p.key) ? ' on' : ''}`} onClick={() => togglePin(p.key)} title={pins.includes(p.key) ? 'Unpin' : 'Pin: listed first'}>{pins.includes(p.key) ? '★' : '☆'}</button></td>
      <td>{p.label}</td>
      <td className="num">{cell(p.a, p.unit, p.digits)}</td>
      {!single && <td className="num">{cell(p.b, p.unit, p.digits)}</td>}
      {!single && <td className="num delta">{delta(p)}</td>}
      <td className="unit">{d.conv(p.unit).unit}</td>
    </tr>
  );
  const head = single
    ? <thead><tr><th /><th /><th>Current</th><th /></tr></thead>
    : <thead><tr><th /><th /><th>Current</th><th>Snapshot</th><th title="Current − snapshot: negative = the current one is lower">Δ</th><th /></tr></thead>;
  return (
    <Section title={title} extra={single ? undefined : <label className="small-text muted" title="Hide the rows that are the same in both"><input type="checkbox" checked={onlyDiff} onChange={() => useCompareView.setState({ onlyDiff: !onlyDiff })} /> only differences</label>}>
      {pinned.length > 0 && (
        <table className="compare-table pinned">
          <caption>Pinned</caption>
          {head}
          <tbody>{pinned.map((p) => <Row key={p.key} p={p} />)}</tbody>
        </table>
      )}
      {groups.map((g) => (
        <table key={g} className="compare-table">
          <caption>{g}</caption>
          {head}
          <tbody>{rest.filter((p) => p.group === g).map((p) => <Row key={p.key} p={p} />)}</tbody>
        </table>
      ))}
      {!pinned.length && !groups.length && <p className="muted small-text">{!single && onlyDiff ? 'Nothing differs.' : 'No results.'}</p>}
    </Section>
  );
}

function DiffTable({ diffs }: { diffs: { path: string; a: string; b: string }[] }) {
  const [filter, setFilter] = useState('');
  const shown = diffs.filter((x) => !filter || x.path.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      {diffs.length > 8 && <input className="value-input" placeholder="Filter (e.g. FL, UCA, spring)" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <table className="compare-table diffs">
        <thead><tr><th /><th>Current</th><th>Snapshot</th></tr></thead>
        <tbody>{shown.slice(0, 300).map((x) => <tr key={x.path}><td className="small-text">{x.path}</td><td className="num">{x.a}</td><td className="num">{x.b}</td></tr>)}</tbody>
      </table>
      {shown.length > 300 && <p className="muted small-text">…and {shown.length - 300} more (filter to narrow).</p>}
    </>
  );
}

/**
 * The test scores: both models on each row's test, and the snapshot's saved last run. Without a snapshot: the
 * current design's tests — its runs from here, or else its up-to-date results from the Tests tab.
 */
function TestScores({ snap }: { snap: Snapshot | null }) {
  const cmp = useCompare();
  const pins = useCompareView((s) => s.pins);
  const [open, setOpen] = useState<string | null>(null);
  const picked = useCompareView((s) => s.picked);
  const tests = useApp((s) => s.tests);
  useRun((s) => s.results); // (re-render when the Tests tab's results change)
  // The playhead: the segment being driven (of the picked test).
  const playSeg = usePlayback((s) => (s.frames.length ? frameAt(s.frames, s.t)?.segment : undefined));
  const fresh = cmp.snapshotId === (snap?.id ?? null) && cmp.rows.length > 0;
  // When the runs are in, show the first test (or the one picked) in the 3D views.
  const allIn = fresh && !cmp.running && cmp.rows.length > 0;
  useEffect(() => { if (allIn) { const row = pickedRow(); if (row) pickRow(row); } }, [allIn, cmp.runs]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = fresh ? cmp.rows : snap ? [] : compareTests(tests, []);
  // Without a snapshot, a test not run here shows the Tests tab's result for it (if the design hasn't changed since).
  const runA = (row: CompareTest): TestRun | undefined => cmp.runs[runKey(row, 'A')] ?? (!snap && row.a ? currentResult(row.a.id) ?? undefined : undefined);
  const order = [...rows].sort((x, y) => Number(pins.includes(`test|${y.name}`)) - Number(pins.includes(`test|${x.name}`)));
  // A run that went off course / spun didn't finish: no time (round 4, F25).
  const dnf = (r: TestRun | SavedResult) => r.segments.some((s) => s.findings.some((f) => f.check === 'offCourse' || (f.check === 'rollover' && f.text.startsWith('Rolled over'))));
  const score = (r: TestRun | SavedResult | undefined) => (r ? <span className={`sev-text-${r.severity}`}>{SEV_ICON[r.severity]}{dnf(r) ? ' did not finish' : typeof r.time === 'number' ? ` ${r.time.toFixed(2)} s` : ''}</span> : <span className="muted">—</span>);
  const dt = (x?: number, y?: number) => {
    if (typeof x !== 'number' || typeof y !== 'number') return '';
    const d = Math.abs(x - y) < 0.005 ? 0 : x - y;
    return `${d > 0 ? '+' : ''}${d.toFixed(2)} s`;
  };
  return (
    <Section title="Test scores">
      {!rows.length && <p className="muted small-text">{cmp.running ? 'Running…' : snap ? 'Run both on both sets of tests (left) to compare their scores.' : 'No enabled tests (Tests tab).'}</p>}
      {rows.length > 0 && (
        <table className="compare-table">
          <thead>{snap
            ? <tr><th /><th>Test</th><th>Current</th><th>Snapshot</th><th title="Current − snapshot: negative = the current one is lower">Δ time</th><th title="The snapshot's own results, saved with it (its last run)">Last run</th></tr>
            : <tr><th /><th>Test</th><th>Result</th></tr>}</thead>
          <tbody>
            {order.map((row: CompareTest) => {
              const ra = runA(row), rb = snap ? cmp.runs[runKey(row, 'B')] : undefined;
              const saved = snap && row.b ? snap.results[row.b.id] : undefined;
              const k = `test|${row.name}`;
              return (
                <Fragment key={row.key}>
                  <tr className={`${ra && rb && (ra.severity !== rb.severity || Math.abs((ra.time ?? 0) - (rb.time ?? 0)) > 0.005) ? 'differs' : ''}${picked === row.key ? ' picked' : ''}`}>
                    <td><button className={`pin${pins.includes(k) ? ' on' : ''}`} onClick={() => togglePin(k)} title="Pin: listed first">{pins.includes(k) ? '★' : '☆'}</button></td>
                    <td><button className="link-btn" onClick={() => { setOpen(open === row.key ? null : row.key); pickRow(row); }} title={`${row.from === 'both' ? 'A track both designs have' : row.from === 'A' ? 'The current design’s test' : 'The snapshot’s test'} — click for its segments; it is shown and played in the 3D views (the snapshot as the ghost)`}>{row.name}</button> {snap && <span className="muted small-text">{row.from === 'both' ? 'both' : row.from === 'A' ? 'current' : 'snapshot'}</span>}</td>
                    <td className="num">{score(ra)}</td>
                    {snap && <td className="num">{score(rb)}</td>}
                    {snap && <td className="num delta">{dt(ra && !dnf(ra) ? ra.time : undefined, rb && !dnf(rb) ? rb.time : undefined)}</td>}
                    {snap && <td className="num">{score(saved)}</td>}
                  </tr>
                  {(open === row.key || (open === null && picked === row.key)) && ra && (rb || !snap) && (
                    <tr key={`${row.key}-segs`} className="segs"><td /><td colSpan={snap ? 5 : 2}>
                      <table className="compare-table inner">
                        <thead><tr><th>Segment</th><th>{snap ? 'Current' : 'Result'}</th>{snap && <th>Snapshot</th>}</tr></thead>
                        <tbody>
                          {(row.a ?? row.b)!.segments.map((sg, i) => {
                            const x = ra.segments[i], y = rb?.segments[i];
                            const cellOf = (s?: TestRun['segments'][number]) => (s ? <span className={`sev-text-${s.severity}`} title={s.findings.filter((f) => f.severity !== 'pass').map((f) => f.text).join('\n')}>{SEV_ICON[s.severity]}{typeof s.time === 'number' ? ` ${s.time.toFixed(2)} s` : ''} · {Math.round(s.maxUtilization * 100)} %</span> : '—');
                            return <tr key={sg.id} className={`${x && y && x.severity !== y.severity ? 'differs' : ''}${picked === row.key && playSeg === i ? ' playing' : ''}`}><td className="small-text">{sg.name}</td><td className="num">{cellOf(x)}</td>{snap && <td className="num">{cellOf(y)}</td>}</tr>;
                          })}
                        </tbody>
                      </table>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}
