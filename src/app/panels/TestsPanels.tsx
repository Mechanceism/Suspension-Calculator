import { racingLineRadius } from '../../core/tests/segments';
/**
 * Tests workspace (Phase A, quasi-static): build a test from segments (speed change over a distance,
 * straight / left / right turn, grade, bank, bumps), run it on the whole car, and see per segment
 * whether it passes, passes with warnings or fails (pass rules per test, overridable per segment),
 * what limits the car, and the speed that would pass.
 * Shares the one design with the Corner and Vehicle views: the center view shows the car in the
 * selected state, and "Show in Vehicle view" carries that state over.
 */
import { useState } from 'react';
import { create } from 'zustand';
import { parseValue, type Quantity } from '../../core/units/units';
import { CORNER_IDS, type CornerId } from '../../core/vehicle/vehicle';
import { segmentLongG, segmentLatG, segmentDuration, type PathKind } from '../../core/tests/segments';
import type { TestRun, StateResult } from '../../core/tests/run';
import { CHECK_IDS, CHECK_META, PROFILES, cloneProfile, type CheckProfile, type Severity, type BuiltinProfile, type Finding } from '../../core/tests/checks';
import { useApp, BRAKE_MORE_META, type Field } from '../store';
import { SEGMENT_PRESETS, TEST_PRESETS, newSegment, newTestId, segmentSpec, isOff, OFF, type TestDesign, type TestSegment } from '../tests';
import { buildVehicleProblem, runTestJob } from '../optimizer';
import { POOL_SIZE, runLimited } from '../workerPool';
import { useProfiles } from '../settings';
import { switchWorkspace } from '../viewport/SafeHtml';
import { ValueInput } from './ValueInput';
import { RoadEditor } from './RoadEditor';
import { PlaybackBar, SegmentMap } from './Playback';
import { Section, fmt, FieldRows } from './FieldRows';
import { useDisplay } from '../units';
import { useLoop, optimizeTests, exploreRanges, acceptExploration, setMaxWiden, isUnfixable, WIDEN_CHOICES, widenLabel, tuneSpringsDampers, setRateSettings, rateVars, setSizeBrakes, sizeBrakesFrom } from '../testOptimize';
import { SearchSelect, SensitivityReport } from './SearchTools';
import { EstimatedNote } from './SetupWizard';
import { VEHICLE_GOAL_KINDS, VEHICLE_GOAL_META } from '../../core/optimize/vehicle';

const parse = (text: string, q: Quantity, prev: Field): Field => {
  const r = parseValue(text, q);
  return r.ok ? { text, value: r.value } : { ...prev, text, error: r.error };
};
const parseOptional = (text: string, prev: Field): Field => (text.trim() === '' ? OFF : parse(text, 'ratio', prev));

interface RunEntry {
  result: TestRun;
  /** Design the run used (stale if it changed). */
  from: DesignRef;
  /** The test as it was run (its playback frames are reused only for the same test). */
  test?: TestDesign;
}
interface RunStore {
  running: boolean;
  /** Test being run now. */
  testId: string | null;
  /** Last result of each test. */
  results: Record<string, RunEntry>;
  error: string | null;
  cancel: (() => void) | null;
  /** Several tests at once (Run all, the optimize loop): how many are done of how many. */
  batch: { index: number; total: number } | null;
  /** Tests running now (several at once, one per worker). */
  runningIds: string[];
}
export const useRun = create<RunStore>(() => ({ running: false, testId: null, results: {}, error: null, cancel: null, batch: null, runningIds: [] }));

/** What a result depends on: when any of these change, the result is stale. */
type DesignRef = { geom: unknown; corners: unknown; settings: unknown; steer: unknown; vehicle: unknown };
const designRef = (s: ReturnType<typeof useApp.getState>): DesignRef => ({ geom: s.geom, corners: s.corners, settings: s.settings, steer: s.steer, vehicle: s.vehicle });
/** True when the design changed since `from`. */
export function useStale(from: DesignRef | undefined): boolean {
  const geom = useApp((s) => s.geom);
  const corners = useApp((s) => s.corners);
  const settings = useApp((s) => s.settings);
  const steer = useApp((s) => s.steer);
  const vehicle = useApp((s) => s.vehicle);
  return !!from && (from.geom !== geom || from.corners !== corners || from.settings !== settings || from.steer !== steer || from.vehicle !== vehicle);
}

export function useActiveTest(): TestDesign | null {
  const tests = useApp((s) => s.tests);
  const id = useApp((s) => s.activeTestId);
  return tests.find((t) => t.id === id) ?? tests[0] ?? null;
}

export const updateTest = (id: string, fn: (t: TestDesign) => TestDesign) =>
  useApp.getState().updateTests((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
const updateSegment = (testId: string, segId: string, fn: (s: TestSegment) => TestSegment) =>
  updateTest(testId, (t) => ({ ...t, segments: t.segments.map((s) => (s.id === segId ? fn(s) : s)) }));

/** Show a result state in the 3D view (the Vehicle view's sliders and road). */
export function showState(st: StateResult['state']) {
  const s = useApp.getState();
  s.set('lateralG', Number(st.ay.toFixed(3)));
  s.set('longitudinalG', Number(st.ax.toFixed(3)));
  s.set('roadGrade', Number((Math.tan(st.grade) * 100).toFixed(2)));
  s.set('roadBank', Number(((st.bank * 180) / Math.PI).toFixed(2)));
  s.set('wheelBumps', { FL: 0, FR: 0, RL: 0, RR: 0, ...st.groundOffset });
  s.set('rack', Number((st.rack ?? 0).toFixed(2)));
  s.set('rideView', null);
}

/** Run a test in the worker (also used by the optimize loop). */
export function startTestRun(test: TestDesign) {
  const run = useRun.getState();
  run.cancel?.();
  const s = useApp.getState();
  const { problem } = buildVehicleProblem(s);
  const job = runTestJob(problem, test.segments.map((sg) => segmentSpec(sg, test)), { onFail: test.onFail, speedLimits: true, ride: test.ride !== false, handling: test.ride !== false && test.handling !== false, driverSpeed: !!test.driverSpeed });
  const from = designRef(s);
  useRun.setState({ running: true, testId: test.id, runningIds: [test.id], error: null, cancel: job.cancel });
  return job.done
    .then((result) => {
      useRun.setState((r) => ({ running: false, cancel: null, runningIds: [], results: { ...r.results, [test.id]: { result, from, test } } }));
      useApp.getState().set('testView', null);
      return result;
    })
    .catch((e: unknown) => { useRun.setState({ running: false, runningIds: [], error: e instanceof Error ? e.message : String(e), cancel: null }); return null; });
}

/**
 * Run several tests at once, each in its own worker (up to one per spare core); the results land in the
 * Tests panel as they finish. Answers in the tests' order (null = failed or stopped).
 */
export async function runTestsTogether(tests: TestDesign[]): Promise<(TestRun | null)[]> {
  if (tests.length === 1) return [await startTestRun(tests[0]!)];
  useRun.getState().cancel?.();
  const s = useApp.getState();
  const { problem } = buildVehicleProblem(s);
  const from = designRef(s);
  const stops = new Set<() => void>();
  let stopped = false, done = 0;
  useRun.setState({ running: true, testId: tests[0]?.id ?? null, runningIds: [], error: null, batch: { index: 0, total: tests.length }, cancel: () => { stopped = true; for (const f of [...stops]) f(); } });
  const out = await runLimited(tests, POOL_SIZE, async (test) => {
    const job = runTestJob(problem, test.segments.map((sg) => segmentSpec(sg, test)), { onFail: test.onFail, speedLimits: true, ride: test.ride !== false, handling: test.ride !== false && test.handling !== false, driverSpeed: !!test.driverSpeed });
    useRun.setState((r) => ({ runningIds: [...r.runningIds, test.id] }));
    // Stopping ends the wait too (a terminated worker never answers).
    let stop = () => {};
    const cancelled = new Promise<null>((res) => { stop = () => { job.cancel(); res(null); }; });
    stops.add(stop);
    try {
      const result = await Promise.race([job.done, cancelled]);
      if (result) useRun.setState((r) => ({ results: { ...r.results, [test.id]: { result, from, test } } }));
      return result;
    } catch (e) {
      useRun.setState({ error: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      stops.delete(stop);
      done++;
      useRun.setState((r) => ({ runningIds: r.runningIds.filter((id) => id !== test.id), batch: r.batch ? { ...r.batch, index: done } : null }));
    }
  }, () => stopped);
  useRun.setState({ running: false, cancel: null, batch: null, runningIds: [] });
  useApp.getState().set('testView', null);
  return out.map((r) => r ?? null);
}

/** Run every enabled test (several at once). */
export async function runAllTests() {
  await runTestsTogether(useApp.getState().tests.filter((t) => t.enabled !== false));
}
/** Stop the running test (and Run all). */
export function stopRuns() {
  useRun.getState().cancel?.();
  useRun.setState({ running: false, cancel: null, batch: null, error: null, runningIds: [] });
}

const SEV_LABEL: Record<Severity, string> = { pass: 'Pass', warn: 'Warning', fail: 'Fail' };
const SEV_ICON: Record<Severity, string> = { pass: '✓', warn: '⚠', fail: '✗' };

// ---------------------------------------------------------------- pass rules editor

function ProfilePicker({ value, onPick, allowInherit }: { value: string | null; onPick: (name: string | null, checks: CheckProfile | null) => void; allowInherit?: boolean }) {
  const custom = useProfiles((s) => s.profiles);
  return (
    <select value={value ?? ''} onChange={(e) => {
      const v = e.target.value;
      if (v === '') { onPick(null, null); return; }
      if (v in PROFILES) { onPick(v, cloneProfile(PROFILES[v as BuiltinProfile].checks)); return; }
      const c = custom.find((p) => `user:${p.name}` === v);
      if (c) onPick(v, cloneProfile(c.checks));
    }}>
      {allowInherit && <option value="">Same as the test</option>}
      {(Object.keys(PROFILES) as BuiltinProfile[]).map((k) => <option key={k} value={k}>{PROFILES[k].label}</option>)}
      {custom.map((p) => <option key={p.name} value={`user:${p.name}`}>{p.name} (yours)</option>)}
      {value === 'custom' && <option value="custom">Custom (edited)</option>}
    </select>
  );
}

function ChecksTable({ checks, onChange }: { checks: CheckProfile; onChange: (c: CheckProfile) => void }) {
  const set = (id: keyof CheckProfile, patch: Partial<CheckProfile[keyof CheckProfile]>) => onChange({ ...checks, [id]: { ...checks[id], ...patch } });
  const num = (v: string, prev: number | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : prev; };
  return (
    <table className="opt-table checks-table">
      <tbody>
        {CHECK_IDS.map((id) => {
          const m = CHECK_META[id];
          const c = checks[id];
          return (
            <tr key={id} title={m.hint} className={`sev-${c.severity}`}>
              <td>{m.label}</td>
              <td>
                <select value={c.severity} disabled={m.fixed} onChange={(e) => set(id, { severity: e.target.value as Severity })}>
                  {(['pass', 'warn', 'fail'] as Severity[]).map((s) => <option key={s} value={s}>{SEV_LABEL[s]}</option>)}
                </select>
              </td>
              <td className="nowrap">
                {m.threshold && (
                  <label title={m.threshold.label}>
                    <input className="value-input small" value={c.threshold ?? 0} onChange={(e) => set(id, { threshold: num(e.target.value, c.threshold) })} /> {m.threshold.unit}
                  </label>
                )}
                {m.threshold2 && (
                  <label title={m.threshold2.label}>
                    {' '}<input className="value-input small" value={c.threshold2 ?? 0} onChange={(e) => set(id, { threshold2: num(e.target.value, c.threshold2) })} /> {m.threshold2.unit}
                  </label>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PassRules({ test }: { test: TestDesign }) {
  const saveProfile = useProfiles((s) => s.saveProfile);
  return (
    <Section title="Pass rules" open={false} extra={<span className="muted small-text">{test.profile === 'custom' ? 'custom' : PROFILES[test.profile as BuiltinProfile]?.label ?? test.profile.replace('user:', '')}</span>}>
      <div className="jm-row">
        <span className="muted">Profile</span>
        <ProfilePicker value={test.profile} onPick={(name, checks) => { if (name && checks) updateTest(test.id, (t) => ({ ...t, profile: name, checks })); }} />
        <button className="chip" onClick={() => {
          const name = prompt('Save these pass rules as a profile named:');
          if (name?.trim()) { saveProfile({ name: name.trim(), checks: cloneProfile(test.checks) }); updateTest(test.id, (t) => ({ ...t, profile: `user:${name.trim()}` })); }
        }} title="Keep these rules for other tests (saved in this browser; Settings export includes them)">Save as profile…</button>
      </div>
      <ChecksTable checks={test.checks} onChange={(checks) => updateTest(test.id, (t) => ({ ...t, checks, profile: 'custom' }))} />
      <p className="hint">Pass = ignored · Warning = reported, the test still passes · Fail. The optimizer must meet Fail rules and tries to reduce Warnings.</p>
    </Section>
  );
}

// ---------------------------------------------------------------- left: builder

function segmentSummary(seg: TestSegment, disp: ReturnType<typeof useDisplay>) {
  const sp = `${disp.format(seg.speedStart.value, 'm/s', 0)} → ${disp.format(seg.speedEnd.value, 'm/s', 0)}`;
  const path = seg.path === 'straight' ? 'straight' : `${seg.path === 'left' ? '↰' : '↱'} R ${disp.format(seg.radius.value, 'm', 0)}`;
  const road = [
    seg.grade.value ? `${seg.grade.value > 0 ? '+' : ''}${seg.grade.value}%` : '',
    seg.bank.value ? `bank ${seg.bank.value}°` : '',
    CORNER_IDS.some((id) => seg.bumps[id].value) ? 'held bumps' : '',
    seg.features.length ? `${seg.features.length} bump/pothole` : '',
    seg.rough.on ? 'rough' : '',
  ].filter(Boolean).join(' · ');
  return `${sp} · ${path}${road ? ` · ${road}` : ''}`;
}

/** The segments as a plain ordered list: select, drag or ↑/↓ to reorder, duplicate, remove. */
function SegmentList({ test, selected, onSelect }: { test: TestDesign; selected: string | null; onSelect: (id: string) => void }) {
  const disp = useDisplay();
  const [drag, setDrag] = useState<number | null>(null);
  const move = (from: number, to: number) => updateTest(test.id, (t) => {
    if (to < 0 || to >= t.segments.length || from === to) return t;
    const a = [...t.segments];
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x!);
    return { ...t, segments: a };
  });
  return (
    <ol className="seg-list">
      {test.segments.map((seg, i) => (
        <li
          key={seg.id}
          className={`${seg.id === selected ? 'sel' : ''}${drag === i ? ' dragging' : ''}`}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}
          onDragEnd={() => setDrag(null)}
          onClick={() => onSelect(seg.id)}
        >
          <span className="drag-handle" title="Drag to reorder">⋮⋮</span>
          <span className="seg-num">{i + 1}</span>
          <span className="seg-text">
            <b>{seg.name}</b>
            <span className="muted small-text">{segmentSummary(seg, disp)}{seg.checks ? ' · own rules' : ''}</span>
          </span>
          <span className="seg-tools" onClick={(e) => e.stopPropagation()}>
            <RankSelect rank={seg.rank} n={test.segments.length} onChange={(r) => updateSegment(test.id, seg.id, (x) => ({ ...x, rank: r }))} />
            <button className="icon-btn" disabled={i === 0} onClick={() => move(i, i - 1)} title="Move up">↑</button>
            <button className="icon-btn" disabled={i === test.segments.length - 1} onClick={() => move(i, i + 1)} title="Move down">↓</button>
            <button className="icon-btn" title="Duplicate" onClick={() => updateTest(test.id, (t) => ({ ...t, segments: [...t.segments.slice(0, i + 1), { ...structuredClone(seg), id: newTestId('seg'), name: `${seg.name} (copy)` }, ...t.segments.slice(i + 1)] }))}>⧉</button>
            <button className="icon-btn" title="Remove" disabled={test.segments.length <= 1} onClick={() => updateTest(test.id, (t) => ({ ...t, segments: t.segments.filter((x) => x.id !== seg.id) }))}>✕</button>
          </span>
        </li>
      ))}
    </ol>
  );
}

function SegmentEditor({ test, seg, index, wheelbase }: { test: TestDesign; seg: TestSegment; index: number; wheelbase: number }) {
  const disp = useDisplay();
  const spec = segmentSpec(seg, test);
  const ax = segmentLongG(spec);
  const ay0 = segmentLatG(spec, spec.v0), ay1 = segmentLatG(spec, spec.v1);
  const dur = segmentDuration(spec);
  const upd = (fn: (s: TestSegment) => TestSegment) => updateSegment(test.id, seg.id, fn);
  return (
    <div className="seg-editor">
      <div className="locks-head">Segment {index + 1}</div>
      <table className="opt-table seg-table">
        <tbody>
          <tr><td>Name</td><td colSpan={3}><input className="value-input wide-text" value={seg.name} onChange={(e) => upd((s) => ({ ...s, name: e.target.value }))} /></td></tr>
          <tr className="seg-layer"><td colSpan={4}>Speed</td></tr>
          <tr>
            <td>Start → end</td>
            <td><ValueInput field={seg.speedStart} unit="m/s" width={56} onCommit={(t) => upd((s) => ({ ...s, speedStart: parse(t, 'speed', s.speedStart) }))} /></td>
            <td><ValueInput field={seg.speedEnd} unit="m/s" width={56} onCommit={(t) => upd((s) => ({ ...s, speedEnd: parse(t, 'speed', s.speedEnd) }))} /></td>
            <td className="unit">{disp.conv('m/s').unit}</td>
          </tr>
          <tr>
            <td>Distance</td>
            <td><ValueInput field={seg.distance} unit="m" width={56} onCommit={(t) => upd((s) => ({ ...s, distance: parse(t, 'distance', s.distance) }))} /></td>
            <td className="unit">{disp.conv('m').unit}</td><td />
          </tr>
          <tr title="Blank = from the speed change over the distance">
            <td>Accel g override</td>
            <td><ValueInput field={seg.longG} unit="g" width={56} onCommit={(t) => upd((s) => ({ ...s, longG: parseOptional(t, s.longG) }))} /></td>
            <td className="unit">g</td><td className="muted small-text">{isOff(seg.longG) ? 'auto' : 'override'}</td>
          </tr>
          <tr className="seg-layer"><td colSpan={4}>Path</td></tr>
          <tr>
            <td colSpan={4}>
              {(['straight', 'left', 'right'] as PathKind[]).map((p) => (
                <button key={p} className={`chip${seg.path === p ? ' on' : ''}`} onClick={() => upd((s) => ({ ...s, path: p }))}>
                  {p === 'straight' ? 'Straight' : p === 'left' ? '↰ Left turn' : '↱ Right turn'}
                </button>
              ))}
            </td>
          </tr>
          {seg.path !== 'straight' && (
            <>
              <tr>
                <td>Radius</td>
                <td><ValueInput field={seg.radius} unit="m" width={56} onCommit={(t) => upd((s) => ({ ...s, radius: parse(t, 'distance', s.radius) }))} /></td>
                <td className="unit">{disp.conv('m').unit}</td><td />
              </tr>
              <tr title="Usable track width for the racing line (the test's Racing line option): the turn is taken on the widest arc from the outside edge, past the inside at the apex, back out. Blank = drive the drawn path.">
                <td>Track width</td>
                <td><ValueInput field={seg.width ?? { text: '', value: 0 }} unit="m" width={56} onCommit={(t) => upd((s) => ({ ...s, width: t.trim() === '' ? undefined : parse(t, 'distance', s.width ?? { text: '', value: 0 }) }))} /></td>
                <td className="unit">{disp.conv('m').unit}</td>
                <td className="muted small-text">{test.racingLine && seg.width && seg.width.value > 0 ? `line R ${(() => { const r = racingLineRadius(seg.radius.value, seg.distance.value, seg.width.value); return Number.isFinite(r) ? disp.format(r, 'm', 0) : 'straight'; })()}` : ''}</td>
              </tr>
              <tr title="Blank = speed² ÷ radius">
                <td>Lateral g override</td>
                <td><ValueInput field={seg.latG} unit="g" width={56} onCommit={(t) => upd((s) => ({ ...s, latG: parseOptional(t, s.latG) }))} /></td>
                <td className="unit">g</td><td className="muted small-text">{isOff(seg.latG) ? 'auto' : 'override'}</td>
              </tr>
            </>
          )}
          <tr className="seg-layer"><td colSpan={4}>Road</td></tr>
          <RoadEditor seg={seg} upd={upd} />
          <tr className="seg-layer"><td colSpan={4}>Importance</td></tr>
          <tr title="Priority within the test when optimizing (P1 = most important; equal = same priority). Separate from the run order.">
            <td>Priority</td>
            <td colSpan={3}><RankSelect rank={seg.rank} n={test.segments.length} onChange={(r) => upd((s) => ({ ...s, rank: r }))} /></td>
          </tr>
          <tr>
            <td>Pass rules</td>
            <td colSpan={3}>
              <ProfilePicker value={seg.profile} allowInherit onPick={(name, checks) => upd((s) => ({ ...s, profile: name, checks }))} />
            </td>
          </tr>
        </tbody>
      </table>
      {seg.checks && <ChecksTable checks={seg.checks} onChange={(checks) => upd((s) => ({ ...s, checks, profile: 'custom' }))} />}
      <p className="small-text seg-info">
        Accel {fmt(ax, 2)} g{ax < -0.01 ? ' (braking)' : ''} · lateral {fmt(Math.abs(ay0), 2)}{Math.abs(ay1 - ay0) > 0.005 ? `–${fmt(Math.abs(ay1), 2)}` : ''} g
        {Number.isFinite(dur) ? ` · ${fmt(dur, 1)} s` : ''}
        {!isOff(seg.latG) && seg.path !== 'straight' && spec.v0 > 0 && ` · implied radius ${disp.format((spec.v0 * spec.v0) / (9.80665 * Math.abs(seg.latG.value)), 'm', 0)}`}
        {seg.path !== 'straight' && ` · road wheels ≈ ${fmt((Math.atan(wheelbase / 1000 / spec.radius) * 180) / Math.PI, 1)}°`}
      </p>
    </div>
  );
}

/** Test priorities are letters (A = most important), segment priorities P1, P2… so the two don't mix up. */
const rankLabel = (rank: number, kind: 'test' | 'segment') =>
  (kind === 'segment' ? `P${rank}` : rank <= 26 ? String.fromCharCode(64 + rank) : `Z${rank - 25}`);

/** Priority rank picker (shared ranks = equal priority). */
function RankSelect({ rank, n, onChange, kind = 'segment' }: { rank: number; n: number; onChange: (r: number) => void; kind?: 'test' | 'segment' }) {
  const max = Math.max(n, rank);
  return (
    <select className={`rank-select ${kind}-rank`} value={rank} onChange={(e) => onChange(Number(e.target.value))} onClick={(e) => e.stopPropagation()}
      title={kind === 'test'
        ? 'Test priority when optimizing several tests: A = most important; equal letters = equal priority. Not the list order.'
        : 'Segment priority within its test: P1 = most important; equal = equal priority. Not the run order.'}>
      {Array.from({ length: max }, (_, i) => <option key={i + 1} value={i + 1}>{rankLabel(i + 1, kind)}</option>)}
    </select>
  );
}

/** Pass / warning / fail icon of a test's last run (faded when the design changed since). */
function TestStatus({ test }: { test: TestDesign }) {
  const entry = useRun((s) => s.results[test.id]);
  const running = useRun((s) => s.running && (s.runningIds.includes(test.id) || (!s.batch && s.testId === test.id)));
  const stale = useStale(entry?.from);
  if (running) return <span className="spinner" title="Running…" />;
  if (!entry) return <span className="test-status muted" title="Not run yet">·</span>;
  const sev = entry.result.error ? 'fail' : entry.result.severity;
  return (
    <span className={`test-status sev-text-${sev}${stale ? ' stale' : ''}`} title={`${SEV_LABEL[sev]}${stale ? ' (the design changed since: run again)' : ''}`}>
      {SEV_ICON[sev]}
    </span>
  );
}

/** The tests as a plain list (like the segments): select, drag or up/down to reorder, priority, duplicate, delete. */
function TestList({ tests, activeId }: { tests: TestDesign[]; activeId: string | null }) {
  const set = useApp((s) => s.set);
  const runRunning = useRun((s) => s.running);
  const loopRunning = useLoop((s) => s.running);
  const running = runRunning || loopRunning;
  const [drag, setDrag] = useState<number | null>(null);
  const move = (from: number, to: number) => useApp.getState().updateTests((ts) => {
    if (to < 0 || to >= ts.length || from === to) return ts;
    const a = [...ts];
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x!);
    return a;
  });
  if (!tests.length) return <p className="muted small-text">No tests yet.</p>;
  return (
    <ol className="seg-list test-list">
      {tests.map((t, i) => (
        <li
          key={t.id}
          className={`${t.id === activeId ? 'sel' : ''}${drag === i ? ' dragging' : ''}`}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}
          onDragEnd={() => setDrag(null)}
          onClick={() => set('activeTestId', t.id)}
        >
          <span className="drag-handle" title="Drag to reorder">⋮⋮</span>
          <input
            type="checkbox" className="test-enable" checked={t.enabled !== false} onClick={(e) => e.stopPropagation()}
            onChange={(e) => updateTest(t.id, (x) => ({ ...x, enabled: e.target.checked }))}
            title="Include in Run all and Optimize all (untick to skip this test)"
          />
          <span className="seg-num">{i + 1}</span>
          <span className={`seg-text${t.enabled === false ? ' disabled-text' : ''}`}>
            <b>{t.name} <TestStatus test={t} /></b>
            <span className="muted small-text">{t.segments.length} segment{t.segments.length === 1 ? '' : 's'} · {t.profile === 'custom' ? 'custom rules' : PROFILES[t.profile as BuiltinProfile]?.label ?? t.profile.replace('user:', '')}{t.enabled === false ? ' · skipped' : ''}</span>
          </span>
          <span className="seg-tools" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" title="Run this test" disabled={running} onClick={() => { set('activeTestId', t.id); void startTestRun(t); }}>▶</button>
            <RankSelect kind="test" rank={t.rank} n={tests.length} onChange={(r) => updateTest(t.id, (x) => ({ ...x, rank: r }))} />
            <button className="icon-btn" disabled={i === 0} onClick={() => move(i, i - 1)} title="Move up">↑</button>
            <button className="icon-btn" disabled={i === tests.length - 1} onClick={() => move(i, i + 1)} title="Move down">↓</button>
            <button className="icon-btn" title="Duplicate" onClick={() => {
              const copy = { ...structuredClone(t), id: newTestId('test'), name: `${t.name} (copy)` };
              useApp.getState().updateTests((ts) => [...ts.slice(0, i + 1), copy, ...ts.slice(i + 1)]);
              set('activeTestId', copy.id);
            }}>⧉</button>
            <button className="icon-btn" title="Delete this test" onClick={() => { if (confirm(`Delete test “${t.name}”?`)) useApp.getState().updateTests((ts) => ts.filter((x) => x.id !== t.id)); }}>✕</button>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TestsSidebar() {
  const tests = useApp((s) => s.tests);
  const test = useActiveTest();
  const set = useApp((s) => s.set);
  const run = useRun();
  const loopRunning = useLoop((s) => s.running);
  const entry = useRun((s) => (test ? s.results[test.id] : undefined));
  const stale = useStale(entry?.from);
  const wheelbase = useApp((s) => s.vehicle.wheelbase.value);
  const [segPreset, setSegPreset] = useState(0);
  const [selSeg, setSelSeg] = useState<string | null>(null);

  const addTest = (make: () => Omit<TestDesign, 'id'>) => {
    const t = { ...make(), id: newTestId('test') };
    useApp.getState().updateTests((ts) => [...ts, t]);
    set('activeTestId', t.id);
  };
  const empty = TEST_PRESETS.find((p) => p.label === 'Empty test')!;
  const enabledCount = tests.filter((t) => t.enabled !== false).length;
  const severities = entry && !stale ? entry.result.segments.map((x) => x.severity) : undefined;
  const presets = TEST_PRESETS.filter((p) => p !== empty);
  const selIndex = test ? test.segments.findIndex((s) => s.id === selSeg) : -1;
  const sel = test ? (selIndex >= 0 ? test.segments[selIndex] : test.segments[0]) : undefined;

  return (
    <div className="inspector tests-sidebar">
      <h3 className="subhead">Tests (in order)</h3>
      <TestList tests={tests} activeId={test?.id ?? null} />
      <div className="jm-row">
        <button className="chip on" onClick={() => addTest(empty.make)}>+ New test</button>
        {!run.running && !run.batch
          ? <button className="chip" disabled={!enabledCount || loopRunning} onClick={() => void runAllTests()} title="Run every ticked test, in list order">▶▶ Run all ({enabledCount})</button>
          : <button className="chip" onClick={stopRuns}>■ Stop</button>}
      </div>
      {run.batch && <p className="muted small-text run-line"><span className="spinner" /> Running {run.batch.total} tests, {Math.min(POOL_SIZE, run.batch.total)} at a time · {run.batch.index} done…</p>}
      <details className="presets" open={!tests.length}>
        <summary>Presets</summary>
        {presets.map((p) => <button key={p.label} className="wide-btn" onClick={() => addTest(p.make)}>{p.label}</button>)}
      </details>
      {!test ? (
        <p className="hint">
          A test is a chain of segments. Each segment combines a <b>speed</b> change over a distance, a <b>path</b> (straight or a
          left / right turn) and the <b>road</b> (grade, bank, rough surface, bumps, potholes).
        </p>
      ) : (
        <>
          <div className="locks-head test-head">Editing: {test.name}</div>
          <table className="opt-table">
            <tbody>
              <tr><td>Name</td><td><input className="value-input wide-text" value={test.name} onChange={(e) => updateTest(test.id, (t) => ({ ...t, name: e.target.value }))} /></td></tr>
              <tr title="Priority among the tests when optimizing them together (A = most important). Not the list order.">
                <td>Test priority</td>
                <td><RankSelect kind="test" rank={test.rank} n={tests.length} onChange={(r) => updateTest(test.id, (t) => ({ ...t, rank: r }))} /></td>
              </tr>
              <tr title="Also drive the test over time (Phase B): the body and wheels move with springs, dampers and tires, bumps hit at speed, segment changes cause transients. Every moment is checked by the pass rules.">
                <td>Ride over time</td>
                <td>
                  <label className="check-label"><input type="checkbox" checked={test.ride !== false} onChange={(e) => updateTest(test.id, (t) => ({ ...t, ride: e.target.checked }))} /> dynamics (Phase B)</label>
                </td>
              </tr>
              <tr title="Over time, a driver steers the car along the path (Phase C): each tire's side force from its slip angle, the car yaws and can slide. Checks how far it runs off the line and its sideslip (spin). Off: the car follows the path exactly.">
                <td>Handling</td>
                <td>
                  <label className="check-label"><input type="checkbox" disabled={test.ride === false} checked={test.ride !== false && test.handling !== false} onChange={(e) => updateTest(test.id, (t) => ({ ...t, handling: e.target.checked }))} /> steered by a driver</label>
                  <label className="check-label" title="Take each turn on the racing line: the widest arc the segment's track width allows (outside at entry, inside at the apex, outside at exit), so a larger radius than the drawn path. Segments without a width follow the path.">
                    <input type="checkbox" checked={!!test.racingLine} onChange={(e) => updateTest(test.id, (t) => ({ ...t, racingLine: e.target.checked }))} /> racing line (with track widths)
                  </label>
                  <label className="check-label" title="The driver also works the throttle and brakes: the segments' speeds become targets; the driver brakes ahead of bends the tires can't take at the set speed, lifts when the car runs wide, and accelerates within the grip left. Ending a segment well short of its speed is reported (Speed not reached).">
                    <input type="checkbox" disabled={test.ride === false || test.handling === false} checked={test.ride !== false && test.handling !== false && !!test.driverSpeed} onChange={(e) => updateTest(test.id, (t) => ({ ...t, driverSpeed: e.target.checked }))} /> driver works the pedals
                  </label>
                </td>
              </tr>
              <tr title="Report: show the failure. Driver lifts: also re-run the failing segment at the fastest speed that passes.">
                <td>When a segment fails</td>
                <td>
                  <button className={`chip${test.onFail === 'report' ? ' on' : ''}`} onClick={() => updateTest(test.id, (t) => ({ ...t, onFail: 'report' }))}>Report</button>
                  <button className={`chip${test.onFail === 'lift' ? ' on' : ''}`} onClick={() => updateTest(test.id, (t) => ({ ...t, onFail: 'lift' }))}>Driver lifts</button>
                </td>
              </tr>
            </tbody>
          </table>
          <PassRules test={test} />
          <h3 className="subhead">Segments (in order)</h3>
          <SegmentMap test={test} selected={sel?.id ?? null} onSelect={setSelSeg} severities={severities} />
          <SegmentList test={test} selected={sel?.id ?? null} onSelect={setSelSeg} />
          <div className="jm-row add-seg-row">
            <label className="muted" htmlFor="seg-preset">Preset:</label>
            <select id="seg-preset" value={segPreset} onChange={(e) => setSegPreset(Number(e.target.value))} title="The kind of segment + Add segment adds">
              {SEGMENT_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
            </select>
            <button className="chip on" onClick={() => {
              const seg = newSegment(SEGMENT_PRESETS[segPreset]!.make());
              updateTest(test.id, (t) => ({ ...t, segments: [...t.segments, seg] }));
              setSelSeg(seg.id);
            }}>+ Add segment</button>
          </div>
          <div className="jm-row">
            {!run.running
              ? <button className="wide-btn primary" disabled={loopRunning} onClick={() => void startTestRun(test)}>▶ Run test</button>
              : <button className="wide-btn" onClick={stopRuns}>■ Stop</button>}
          </div>
          {run.running && !run.batch && <p className="muted small-text run-line"><span className="spinner" /> Running {tests.find((t) => t.id === run.testId)?.name ?? 'the test'}…</p>}
          {run.error && <p className="hint warn-text">Test failed to run: {run.error}</p>}
          {sel && <SegmentEditor test={test} seg={sel} index={Math.max(0, selIndex)} wheelbase={wheelbase} />}
          <p className="hint">
            Order = the sequence the car drives; priority (tests A, B…; segments P1, P2…) = how much it counts when optimizing. Combine in one segment
            (e.g. braking in a left turn on a decline with a pothole), chain segments for a sequence. Steady states (Phase A).
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- right: results

const STATE_TEXT: Record<string, string> = { grip: 'grip', sliding: 'sliding', 'abs-limit': 'ABS limit', locked: 'locked', wheelspin: 'wheelspin' };

function Findings({ list }: { list: Finding[] }) {
  return <>{list.map((f) => <div key={`${f.check}${f.text}`} className={`small-text finding sev-${f.severity}`}>{SEV_ICON[f.severity]} {f.text}</div>)}</>;
}

/** Every test's last result (after Run all), click to open one. */
function AllTests() {
  const tests = useApp((s) => s.tests);
  const results = useRun((s) => s.results);
  const active = useActiveTest();
  const set = useApp((s) => s.set);
  if (tests.length < 2 || !tests.some((t) => results[t.id])) return null;
  return (
    <table className="corner-table test-table all-tests">
      <thead><tr><th>#</th><th>Test</th><th title="Test priority">Pri.</th><th /></tr></thead>
      <tbody>
        {tests.map((t, i) => (
          <tr key={t.id} className={`${t.id === active?.id ? 'sel' : ''}${t.enabled === false ? ' disabled-text' : ''}`} onClick={() => set('activeTestId', t.id)} title="Show this test">
            <td>{i + 1}</td><td>{t.name}{t.enabled === false ? ' (skipped)' : ''}</td><td>{rankLabel(t.rank, 'test')}</td><td><TestStatus test={t} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TestResults() {
  const run = useRun();
  const test = useActiveTest();
  const view = useApp((s) => s.testView);
  const set = useApp((s) => s.set);
  const disp = useDisplay();
  const entry = test ? run.results[test.id] : undefined;
  const r = entry?.result;
  const stale = useStale(entry?.from);

  if (!test) return <section className="panel"><h2>Test results</h2><p className="muted">Create a test on the left.</p></section>;
  if (!r) {
    return (
      <section className="panel">
        <h2>Test results</h2>
        <AllTests />
        <p className="muted">{run.running && (run.runningIds.includes(test.id) || run.testId === test.id) ? <><span className="spinner" /> Running…</> : 'Run the test (or Run all) to see whether it passes in every segment.'}</p>
        <OptimizeSection test={test} onOpenOptimizer={() => openOptimizer(test)} />
      </section>
    );
  }
  if (r.error) return <section className="panel"><h2>Test results</h2><AllTests /><p className="hint warn-text">{r.error}</p></section>;

  const pick = (seg: number, sample: number) => {
    const st = r.states.filter((s) => s.state.segment === seg)[sample];
    if (!st) return;
    set('testView', { segment: seg, sample });
    showState(st.state);
  };
  const segStates = view ? r.states.filter((s) => s.state.segment === view.segment) : [];
  const sel = view ? segStates[view.sample] : undefined;
  const segRes = view ? r.segments[view.segment] : undefined;
  const segDef = view ? test.segments[view.segment] : undefined;

  const applyLimit = () => {
    if (!segRes?.speedLimit || !segDef) return;
    const k = segRes.speedLimit;
    updateSegment(test.id, segDef.id, (s) => ({
      ...s,
      speedStart: { text: String(Number((s.speedStart.value * k).toFixed(3))), value: s.speedStart.value * k },
      speedEnd: { text: String(Number((s.speedEnd.value * k).toFixed(3))), value: s.speedEnd.value * k },
    }));
  };
  const status = r.severity === 'fail' ? 'Failed' : r.severity === 'warn' ? 'Passed with warnings' : 'Passed';

  return (
    <section className="panel">
      <h2>
        Test results{run.running && (run.runningIds.includes(test.id) || run.testId === test.id) && <span className="spinner" title="Running…" />}
        <span className={`status ${r.severity === 'fail' ? 'status-not-converged' : r.severity === 'warn' ? 'status-singular' : 'status-converged'}`}>{status}</span>
      </h2>
      <AllTests />
      <EstimatedNote />
      {stale && <p className="hint warn-text">The design changed since this run: run again.</p>}
      <table className="corner-table test-table">
        <thead><tr><th>#</th><th>Segment</th><th title="Worst tire grip use">Grip</th>{r.segments.some((s) => s.brakeTemp) && <th title="Brake fade: rotor temperature at the end of the segment, front / rear">Brakes</th>}<th /></tr></thead>
        <tbody>
          {r.segments.map((s) => {
            const def = test.segments[s.index];
            return (
              <tr key={s.index} className={`sev-${s.severity}${view?.segment === s.index ? ' sel' : ''}`} onClick={() => pick(s.index, 0)} title="Show this segment">
                <td>{s.index + 1}</td>
                <td>{def?.name ?? ''}</td>
                <td>{Number.isFinite(s.maxUtilization) ? `${fmt(s.maxUtilization * 100, 0)} %` : '—'}</td>
                {s.brakeTemp && <td className="small-text">{disp.format(s.brakeTemp.end.front, '°C', 0)} / {disp.format(s.brakeTemp.end.rear, '°C', 0)}</td>}
                <td>{SEV_ICON[s.severity]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {r.segments.filter((s) => s.severity !== 'pass').map((s) => {
        const def = test.segments[s.index];
        const vmax = def ? Math.max(def.speedStart.value, def.speedEnd.value) : 0;
        return (
          <div key={s.index} className={`seg-fail sev-${s.severity}`}>
            <b>{s.index + 1}. {def?.name}</b>
            <Findings list={s.findings} />
            {s.impossible && <div className="small-text warn-text">No suspension change can make this pass: the tires can't give that much force. Lower the speed, enlarge the radius, or improve the tires.</div>}
            {s.findings.some((f) => f.check === 'steerLimit' && f.severity === 'fail') && <div className="small-text warn-text">Slowing down doesn't help: enlarge the radius, or allow more rack travel / a longer-reach steering arm (Corner view → Steering rack).</div>}
            {s.rideFail && <div className="small-text warn-text">Passes as steady states but fails over time (bumps at speed, transients): softer / firmer damping, more travel or a lower speed can help. Play it back to watch.</div>}
            {s.speedLimit !== undefined && !s.rideFail && !s.findings.some((f) => f.check === 'steerLimit' && f.severity === 'fail') && (
              <div className="small-text">
                {s.speedLimit > 0
                  ? <>Passes at {fmt(s.speedLimit * 100, 0)}% of its speed (max ≈ {disp.format(vmax * s.speedLimit, 'm/s', 0)}){s.lifted ? ' — driver lifts: re-run at that speed passes.' : '.'}</>
                  : 'Fails even at a crawl: check the pass rules, bumps, travel limits or powered / braked wheels.'}
              </div>
            )}
          </div>
        );
      })}
      {view && segRes && (
        <Section title={`Segment ${view.segment + 1}: ${segDef?.name ?? ''}`}>
          <div className="jm-row">
            {segStates.map((st, i) => (
              <button key={st.state.name} className={`chip${view.sample === i ? ' on' : ''}${st.severity === 'fail' ? ' bad-chip' : ''}`} onClick={() => pick(view.segment, i)}>
                {disp.format(st.state.speed, 'm/s', 0)}
              </button>
            ))}
          </div>
          {sel && (
            <>
              <p className="small-text">
                Lateral {fmt(sel.state.ay, 2)} g · longitudinal {fmt(sel.state.ax, 2)} g
                {sel.state.gravityScale < 0.9999 ? ' · on a grade / bank' : ''}{Object.keys(sel.state.groundOffset).length ? ' · bumps' : ''}
              </p>
              {segRes.steer && (
                <p className={`small-text${segRes.steer.over ? ' warn-text' : ''}`} title="Steering for the radius: atan(wheelbase ÷ radius) plus the front − rear tire slip angle (more front slip = understeer = more steering). Steady state. Over time with a driver (Handling), the HUD shows the steering actually used.">
                  {segRes.steer.none ? 'Steering: no steered wheels.' : <>
                    Steering: road wheels {fmt(Math.abs(segRes.steer.wheelAngle), 1)}° {segRes.steer.wheelAngle > 0 ? 'left' : 'right'}
                    {Math.abs(segRes.steer.slip) > 0.05 ? ` (${segRes.steer.slip > 0 ? '+' : '−'}${fmt(Math.abs(segRes.steer.slip), 1)}° for the tires' slip: ${segRes.steer.slip > 0 ? 'understeer' : 'oversteer'})` : ''}
                    {' '}· rack {fmt(Math.abs(segRes.steer.rack), 1)} of ±{fmt(segRes.steer.limit, 0)} mm
                    {Number.isFinite(segRes.steer.steeringWheel) ? ` · steering wheel ${fmt(Math.abs(segRes.steer.steeringWheel), 0)}°` : ''}
                    {segRes.steer.over ? ` · full lock gives only ${fmt(segRes.steer.maxAngle, 1)}°` : ''}
                  </>}
                </p>
              )}
              {sel.grip ? (
                <table className="corner-table grip-table">
                  <thead><tr><th /><th>Load</th><th>Grip use</th><th title="Slip angle the tire needs (— = past its peak)">Slip</th><th>State</th><th>Travel</th></tr></thead>
                  <tbody>
                    {CORNER_IDS.map((id: CornerId) => {
                      const g = sel.grip!.corners[id];
                      const c = sel.corners![id];
                      return (
                        <tr key={id} className={g.utilization > 1 ? 'bad' : g.utilization > 0.9 ? 'warn' : ''}>
                          <td><b>{id}</b></td>
                          <td>{disp.format(c.tireLoad, 'N', 0)}</td>
                          <td>{fmt(g.utilization * 100, 0)} %</td>
                          <td>{Number.isFinite(g.slipAngle) ? `${fmt(Math.abs(g.slipAngle), 1)}°` : '—'}</td>
                          <td>{STATE_TEXT[g.state]}{c.status !== 'ok' ? ` · ${c.status}` : ''}{c.onBumpStop ? ' · bump stop' : ''}</td>
                          <td>{disp.format(c.travel, 'mm', 1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : <p className="hint warn-text">This state did not settle.</p>}
              <Findings list={sel.findings} />
            </>
          )}
          <div className="jm-row">
            <button className="chip" onClick={() => { if (sel) showState(sel.state); switchWorkspace('vehicle'); }} title="Open the Vehicle view with this state (accelerations and bumps)">Show in Vehicle view</button>
            {segRes.speedLimit !== undefined && segRes.speedLimit > 0 && (
              <button className="chip" onClick={applyLimit} title="Set this segment's speeds to the fastest that passes">Apply speed limit</button>
            )}
          </div>
        </Section>
      )}
      <OptimizeSection test={test} onOpenOptimizer={() => openOptimizer(test)} />
      <p className="hint">
        Grip uses the Magic Formula tire model (generic coefficients or a .tir file: Vehicle → Optimize → Tire grip model). Steady states check each moment
        on the path; over time with a driver (Handling) the car can run wide or spin, and the playback shows the line it actually drove (grey: the path).
      </p>
    </section>
  );
}

/** Under the 3D view in the Tests workspace: playback, or which state is shown. */
export function TestViewBar() {
  const test = useActiveTest();
  return (
    <>
      <PlaybackBar test={test} />
      <SelectedStateBar />
    </>
  );
}

function SelectedStateBar() {
  const lat = useApp((s) => s.lateralG);
  const lon = useApp((s) => s.longitudinalG);
  const bumps = useApp((s) => s.wheelBumps);
  const view = useApp((s) => s.testView);
  const test = useActiveTest();
  const disp = useDisplay();
  const seg = view && test ? test.segments[view.segment] : undefined;
  const anyBump = CORNER_IDS.filter((id) => bumps[id]);
  return (
    <div className="motion-bar test-view-bar">
      <span className="muted">
        {seg ? <>Showing <b>{view!.segment + 1}. {seg.name}</b> · </> : 'Pick a segment in the results to see the car in that state · '}
        lateral {fmt(lat, 2)} g · longitudinal {fmt(lon, 2)} g{anyBump.length ? ` · bumps ${anyBump.map((id) => `${id} ${disp.format(bumps[id], 'mm', 0)}`).join(', ')}` : ''}
      </span>
    </div>
  );
}

/** Open Vehicle → Optimize with this test as the load cases. */
function openOptimizer(test: TestDesign) {
  const s = useApp.getState();
  s.updateVehicleOptimizer((o) => ({
    ...o, caseSource: test.id,
    goals: { ...o.goals, testPass: { ...o.goals.testPass, on: true } },
  }));
  s.set('vehicleTab', 'optimize');
  switchWorkspace('vehicle');
}

/** Optimize from here, for this test or every enabled test: until it passes, improve, explore wider ranges. */
function OptimizeSection({ test, onOpenOptimizer }: { test: TestDesign; onOpenOptimizer: () => void }) {
  const loop = useLoop();
  const vo = useApp((s) => s.vehicleOptimizer);
  const tests = useApp((s) => s.tests);
  const results = useRun((s) => s.results);
  const free = Object.keys(vo.ranges).length;
  const goals = VEHICLE_GOAL_KINDS.filter((k) => vo.goals[k].on && k !== 'testPass' && k !== 'testReserve').map((k) => VEHICLE_GOAL_META[k].short);
  const enabled = tests.filter((t) => t.enabled !== false);
  const inScope = loop.scope === 'all' ? enabled : [test];
  const runs = inScope.map((t) => results[t.id]?.result).filter((x): x is TestRun => !!x);
  const known = runs.length === inScope.length && inScope.length > 0;
  const failing = !known || runs.some((r) => !r.passed);
  // Fails that geometry can't change (no drive / brakes, beyond the tires, steering lock, rollover) aren't worth optimizing.
  const fixable = !known || runs.some((r) => r.segments.some((s) => !s.impossible && s.findings.some((f) => f.severity === 'fail' && !isUnfixable(f))));
  const testRunning = useRun((s) => s.running);
  const busy = loop.running || testRunning;
  const many = loop.scope === 'all';
  return (
    <Section title="Optimize">
      <div className="jm-row">
        <span className="muted">For</span>
        <button className={`chip${!many ? ' on' : ''}`} onClick={() => useLoop.setState({ scope: 'test' })} disabled={loop.running}>This test</button>
        <button className={`chip${many ? ' on' : ''}`} onClick={() => useLoop.setState({ scope: 'all' })} disabled={loop.running} title="Every ticked test together, weighted by test priority (A, B…)">All enabled tests ({enabled.length})</button>
      </div>
      <div className="jm-row" title="When the optimizer stops making progress inside your ranges, it widens them step by step (×2, ×3, ×4, ×5, ×10…) up to this, and keeps trying. Points it moves outside your ranges widen those ranges.">
        <span className="muted">Max widening</span>
        <select value={loop.maxWiden} onChange={(e) => setMaxWiden(Number(e.target.value))} disabled={loop.running}>
          {WIDEN_CHOICES.map((v) => <option key={v} value={v}>{widenLabel(v)}</option>)}
        </select>
      </div>
      <div className="jm-row" title="Geometry rounds: local from your design, or wide (several starts from a design of experiments, keeping the best)">
        <span className="muted">Search</span>
        <SearchSelect value={vo.starts} onChange={(n) => useApp.getState().updateVehicleOptimizer((o) => ({ ...o, starts: n }))} />
      </div>
      <p className="small-text">
        Free coordinates: <b>{free || 'none yet (you\'ll be asked to free all available)'}</b>
        {goals.length ? <> · other goals kept: <b>{goals.join(', ')}</b></> : ' · no other goals'}
        {' · '}<button className="link-btn" onClick={onOpenOptimizer}>edit in Vehicle → Optimize</button>
      </p>
      {!loop.running && (
        <div className="jm-row">
          {failing && fixable && <button className="wide-btn primary" disabled={busy || !inScope.length} onClick={() => void optimizeTests(loop.scope, test, 'pass')} title="Optimize, apply, re-run, until it passes; widens the ranges when it stops making progress">▶ Optimize until {many ? 'they pass' : 'it passes'}</button>}
          {(!failing || !known) && <button className="wide-btn primary" disabled={busy || !inScope.length} onClick={() => void optimizeTests(loop.scope, test, 'improve')} title="Lower grip use everywhere (priority-weighted; failing segments get extra weight)">▶ Improve (more grip reserve)</button>}
          <button className="wide-btn" disabled={busy || !inScope.length} onClick={() => void exploreRanges(loop.scope, test)} title="One run with the ranges widened to the maximum; shows the result before using it">Preview wider ranges</button>
        </div>
      )}
      {failing && !fixable && (
        <p className="hint warn-text">These failures can't be fixed by moving suspension points (no powered / braked wheels, more than the tires can give, or too tight for the steering): change the corner or steering settings, the test, or the tires.</p>
      )}
      <RateTuning test={test} busy={busy} />
      <BrakeLadderBox busy={busy} />
      {loop.running && (
        <div className="jm-row">
          <span className="run-line"><span className="spinner" /> {loop.rateProgress
            ? `Springs & dampers: try ${loop.rateProgress.evaluation} of ${loop.rateProgress.budget} · best score ${fmt(loop.rateProgress.best, 2)}`
            : loop.mode === 'explore' ? `Exploring (ranges ×${loop.widen})…` : `Round ${loop.round}${loop.widen > 1 ? ` · ranges ×${loop.widen}` : ''}…`}</span>
          <button className="chip" onClick={() => loop.cancel?.()} title="Stop (rate tuning keeps the best found so far)">■ Stop</button>
        </div>
      )}
      {loop.log.length > 0 && <ol className="loop-log">{loop.log.map((l, i) => <li key={i} className="small-text">{l}</li>)}</ol>}
      {loop.outcome === 'passed' && <p className="small-text ok-text">✓ Passes now. Each applied round can be undone (Ctrl+Z).</p>}
      {loop.outcome === 'improved' && <p className="small-text ok-text">Done improving. Each applied round can be undone (Ctrl+Z).</p>}
      {loop.outcome === 'stopped' && <p className="small-text muted">Stopped.</p>}
      {(loop.outcome === 'stuck' || loop.outcome === 'error' || loop.outcome === 'improved') && loop.explanation.map((x) => <p key={x} className={`small-text ${loop.outcome === 'improved' ? 'muted' : 'warn-text'}`}>{x}</p>)}
      {loop.exploration && (
        <div className="opt-result">
          <div className="locks-head">Wider ranges (preview)</div>
          <p className="small-text">
            Candidate {loop.exploration.candidate.passed ? (loop.exploration.candidate.severity === 'warn' ? 'passes with warnings' : 'passes') : 'still fails'}
            {' '}· score {fmt(loop.exploration.before, 2)} → <b>{fmt(loop.exploration.after, 2)}</b> (lower is better)
          </p>
          <table className="opt-table">
            <thead><tr><th>Coordinate</th><th>Now</th><th>Candidate</th><th /></tr></thead>
            <tbody>
              {loop.exploration.moves.map((m) => (
                <tr key={m.key} className={m.outside ? 'warn' : ''}>
                  <td>{m.label}</td><td className="mono">{fmt(m.before, 1)}</td><td className="mono">{fmt(m.after, 1)}</td>
                  <td className="small-text">{m.outside ? '⚠ outside your range' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="jm-row">
            <button className="wide-btn primary" disabled={loop.exploration.after >= loop.exploration.before} onClick={() => void acceptExploration()}>Use it (and widen those ranges)</button>
            <button className="wide-btn" onClick={() => useLoop.setState({ exploration: null })}>Keep my ranges</button>
          </div>
        </div>
      )}
      <details className="tire-advanced">
        <summary>What matters most for {many ? 'these tests' : 'this test'}</summary>
        <SensitivityReport
          build={() => buildVehicleProblem(useApp.getState(), { caseSource: many ? 'all' : test.id })}
          current={useApp.getState().geom} what="the miss on the tests' pass rules"
        />
      </details>
    </Section>
  );
}

/** The brake ladder: size the brakes to the tests' hardest stop, keeping a reserve. */
function BrakeLadderBox({ busy }: { busy: boolean }) {
  const loop = useLoop();
  const b = useApp((s) => s.brakes);
  const setB = useApp((s) => s.setBrakes);
  const setMore = useApp((s) => s.setBrakeMoreField);
  const [last, setLast] = useState<{ changes: string[]; blocked: string[] } | null>(null);
  if (!b.on) return null;
  const axleName = (a: 'front' | 'rear') => (a === 'front' ? 'front' : 'rear');
  return (
    <details className="tire-advanced rate-tuning" open>
      <summary>Brakes (step ladder)</summary>
      <p className="hint">Picks the smallest brakes that still have the reserve in the hardest stop of the tests (fade included): more pistons first, larger rotors last, only rotors that fit the wheel; steps down when there is a lot to spare.</p>
      <FieldRows rows={[{ label: BRAKE_MORE_META.ladderReserve.label, field: b.ladderReserve, unit: '%', hint: BRAKE_MORE_META.ladderReserve.hint, onCommit: (t: string) => setMore('ladderReserve', t) }]} />
      {(b.drumF || b.drumR) && (
        <div className="jm-row" title="A drum axle stays on drums unless you allow discs here (it depends on your project).">
          {b.drumF && <label className="check-label"><input type="checkbox" checked={b.allowDiscF} onChange={(e) => setB({ allowDiscF: e.target.checked })} /> front may switch to discs</label>}
          {b.drumR && <label className="check-label"><input type="checkbox" checked={b.allowDiscR} onChange={(e) => setB({ allowDiscR: e.target.checked })} /> rear may switch to discs</label>}
        </div>
      )}
      <label className="check-label small-text"><input type="checkbox" checked={loop.sizeBrakes} onChange={(e) => setSizeBrakes(e.target.checked)} /> also inside Optimize until it passes / Improve</label>
      {!loop.running && (
        <div className="jm-row">
          <button className="wide-btn" disabled={busy} title="From the last run of every test (run them first)"
            onClick={() => { const z = sizeBrakesFrom(); setLast(z ? { changes: z.changes, blocked: z.blocked } : { changes: [], blocked: ['Run the tests first (with the brake hydraulics on).'] }); }}>
            ▶ Size the brakes from the last test runs
          </button>
        </div>
      )}
      {last && (
        <div className="small-text">
          {last.changes.length ? last.changes.map((c) => <p key={c} className="ok-text">{c}</p>) : !last.blocked.length && <p className="muted">The brakes already fit the tests with the reserve: nothing changed.</p>}
          {last.blocked.map((c) => <p key={c} className="warn-text">{c}</p>)}
          {last.changes.length > 0 && <p className="muted">Run the tests again to see the new brakes (Ctrl+Z undoes).</p>}
        </div>
      )}
      {loop.askDisc.length > 0 && (
        <div className="jm-row">
          {loop.askDisc.map((a) => (
            <button key={a} className="chip" onClick={() => { setB(a === 'front' ? { allowDiscF: true } : { allowDiscR: true }); const z = sizeBrakesFrom(); setLast(z ? { changes: z.changes, blocked: z.blocked } : null); }}>
              Allow discs on the {axleName(a)} and size again
            </button>
          ))}
        </div>
      )}
    </details>
  );
}

/** Springs, dampers and anti-roll bars tuned on the ride over time (Bayesian optimization). */
function RateTuning({ test, busy }: { test: TestDesign; busy: boolean }) {
  const loop = useLoop();
  const r = loop.rates;
  const n = rateVars(useApp.getState(), r).length;
  const rideOff = loop.scope === 'test' ? test.ride === false : false;
  return (
    <details className="tire-advanced rate-tuning" open>
      <summary>Springs &amp; dampers (ride over time)</summary>
      <div className="jm-row" title="What to tune. Locked values (Locks tab) stay as they are.">
        <label className="check-label"><input type="checkbox" checked={r.springs} onChange={(e) => setRateSettings({ springs: e.target.checked })} /> springs</label>
        <label className="check-label"><input type="checkbox" checked={r.dampers} onChange={(e) => setRateSettings({ dampers: e.target.checked })} /> dampers</label>
        <label className="check-label"><input type="checkbox" checked={r.bars} onChange={(e) => setRateSettings({ bars: e.target.checked })} /> anti-roll bars</label>
      </div>
      <div className="jm-row">
        <span className="muted" title="Each rate is searched from its value ÷ this to × this">Range ÷/×</span>
        <select value={r.spread} onChange={(e) => setRateSettings({ spread: Number(e.target.value) })}>
          {[1.5, 2, 2.5, 4].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <span className="muted" title="Each try runs every test in scope, steady and over time">Tries</span>
        <select value={r.budget} onChange={(e) => setRateSettings({ budget: Number(e.target.value) })}>
          {[15, 30, 60, 100].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <label className="check-label small-text" title="When the geometry rounds stop helping, or the remaining failures only show over time, tune the rates too">
        <input type="checkbox" checked={r.withLoop} onChange={(e) => setRateSettings({ withLoop: e.target.checked })} /> also inside Optimize until it passes / Improve
      </label>
      {!loop.running && (
        <div className="jm-row">
          <button className="wide-btn" disabled={busy || !n || rideOff} onClick={() => void tuneSpringsDampers(loop.scope, test)}
            title="Bayesian optimization: each try runs the tests with candidate rates; a model of the results picks the next try. Your current rates are the first try, so it never ends worse.">
            ▶ Tune {n} rate{n === 1 ? '' : 's'}
          </button>
        </div>
      )}
      {rideOff && <p className="hint">Turn on Ride over time for this test to tune on it.</p>}
    </details>
  );
}
