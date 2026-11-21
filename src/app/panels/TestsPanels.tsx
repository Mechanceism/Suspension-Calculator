/**
 * Tests workspace (Phase A, quasi-static): build a test from segments (speed change over a distance,
 * straight / left / right turn, grade, bank, bumps), run it on the whole car, and see per segment
 * whether it passes, passes with warnings or fails (pass rules per test, overridable per segment),
 * what limits the car, and the speed that would pass.
 * Shares the one design with the Corner and Vehicle views: the center view shows the car in the
 * selected state, and "Show in Vehicle view" carries that state over.
 */
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { parseValue, type Quantity } from '../../core/units/units';
import { CORNER_IDS, type CornerId } from '../../core/vehicle/vehicle';
import { segmentLongG, segmentLatG, segmentDuration, type PathKind } from '../../core/tests/segments';
import type { TestRun, StateResult } from '../../core/tests/run';
import { CHECK_IDS, CHECK_META, PROFILES, cloneProfile, type CheckProfile, type Severity, type BuiltinProfile, type Finding } from '../../core/tests/checks';
import { useApp, type Field } from '../store';
import { SEGMENT_PRESETS, TEST_PRESETS, newSegment, newTestId, segmentSpec, isOff, OFF, type TestDesign, type TestSegment } from '../tests';
import { buildVehicleProblem, runTestJob } from '../optimizer';
import { useProfiles } from '../settings';
import { switchWorkspace } from '../viewport/SafeHtml';
import { ValueInput } from './ValueInput';
import { RoadEditor } from './RoadEditor';
import { PlaybackBar } from './Playback';
import { Section, fmt } from './FieldRows';
import { useDisplay } from '../units';
import { useLoop, optimizeTest, exploreRanges, acceptExploration } from '../testOptimize';
import { VEHICLE_GOAL_KINDS, VEHICLE_GOAL_META } from '../../core/optimize/vehicle';

const parse = (text: string, q: Quantity, prev: Field): Field => {
  const r = parseValue(text, q);
  return r.ok ? { text, value: r.value } : { ...prev, text, error: r.error };
};
const parseOptional = (text: string, prev: Field): Field => (text.trim() === '' ? OFF : parse(text, 'ratio', prev));

interface RunStore {
  running: boolean;
  testId: string | null;
  result: TestRun | null;
  /** Design the run used (stale if it changed). */
  from: unknown;
  error: string | null;
  cancel: (() => void) | null;
}
export const useRun = create<RunStore>(() => ({ running: false, testId: null, result: null, from: null, error: null, cancel: null }));

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
}

/** Run a test in the worker (also used by the optimize loop). */
export function startTestRun(test: TestDesign) {
  const run = useRun.getState();
  run.cancel?.();
  const s = useApp.getState();
  const { problem } = buildVehicleProblem(s);
  const job = runTestJob(problem, test.segments.map((sg) => segmentSpec(sg, test)), { onFail: test.onFail, speedLimits: true });
  useRun.setState({ running: true, testId: test.id, error: null, cancel: job.cancel, from: { geom: s.geom, corners: s.corners } });
  return job.done
    .then((result) => { useRun.setState({ running: false, result, cancel: null }); useApp.getState().set('testView', null); return result; })
    .catch((e: unknown) => { useRun.setState({ running: false, error: e instanceof Error ? e.message : String(e), cancel: null }); return null; });
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
            <span className="muted small-text">{segmentSummary(seg, disp)}{seg.checks ? ' · own rules' : ''}{seg.weight.value !== 1 ? ` · weight ${seg.weight.value}` : ''}</span>
          </span>
          <span className="seg-tools" onClick={(e) => e.stopPropagation()}>
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

function SegmentEditor({ test, seg, index }: { test: TestDesign; seg: TestSegment; index: number }) {
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
          <tr title="How much this segment counts within the test when optimizing (1 = normal)">
            <td>Weight</td>
            <td><ValueInput field={seg.weight} unit="" width={56} onCommit={(t) => upd((s) => ({ ...s, weight: parse(t, 'ratio', s.weight) }))} /></td>
            <td /><td />
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
      </p>
    </div>
  );
}

export function TestsSidebar() {
  const tests = useApp((s) => s.tests);
  const test = useActiveTest();
  const set = useApp((s) => s.set);
  const run = useRun();
  const [segPreset, setSegPreset] = useState(0);
  const [selSeg, setSelSeg] = useState<string | null>(null);

  const addTest = (i: number) => {
    const t = { ...TEST_PRESETS[i]!.make(), id: newTestId('test') };
    useApp.getState().updateTests((ts) => [...ts, t]);
    set('activeTestId', t.id);
  };

  if (!test) {
    return (
      <div className="inspector tests-sidebar">
        <p className="hint">
          A test is a chain of segments. Each segment combines a <b>speed</b> change over a distance, a <b>path</b> (straight or a
          left / right turn) and the <b>road</b> (grade, bank, bumps, potholes). Start from a preset:
        </p>
        {TEST_PRESETS.map((p, i) => <button key={p.label} className="wide-btn" onClick={() => addTest(i)}>{p.label}</button>)}
      </div>
    );
  }
  const selIndex = test.segments.findIndex((s) => s.id === selSeg);
  const sel = selIndex >= 0 ? test.segments[selIndex] : test.segments[0];
  return (
    <div className="inspector tests-sidebar">
      <div className="jm-row">
        <select value={test.id} onChange={(e) => set('activeTestId', e.target.value)} title="Test">
          {tests.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value="" onChange={(e) => { if (e.target.value !== '') addTest(Number(e.target.value)); }} title="New test">
          <option value="">+ New test…</option>
          {TEST_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </select>
        <button className="icon-btn" title="Delete this test" onClick={() => { if (confirm(`Delete test “${test.name}”?`)) useApp.getState().updateTests((ts) => ts.filter((t) => t.id !== test.id)); }}>🗑</button>
      </div>
      <table className="opt-table">
        <tbody>
          <tr><td>Name</td><td><input className="value-input wide-text" value={test.name} onChange={(e) => updateTest(test.id, (t) => ({ ...t, name: e.target.value }))} /></td></tr>
          <tr title="How much this test counts when optimizing several tests (e.g. 80 for paved-road tests, 20 for rough-road tests)">
            <td>Priority</td>
            <td className="nowrap"><ValueInput field={test.priority} unit="%" width={48} onCommit={(t) => updateTest(test.id, (x) => ({ ...x, priority: parse(t, 'percent', x.priority) }))} /> %</td>
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
      <SegmentList test={test} selected={sel?.id ?? null} onSelect={setSelSeg} />
      <div className="jm-row">
        <select value={segPreset} onChange={(e) => setSegPreset(Number(e.target.value))}>
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
          ? <button className="wide-btn primary" onClick={() => void startTestRun(test)}>▶ Run test</button>
          : <button className="wide-btn" onClick={() => { run.cancel?.(); useRun.setState({ running: false, cancel: null }); }}>■ Stop</button>}
      </div>
      {run.running && <p className="muted small-text">Running…</p>}
      {run.error && <p className="hint warn-text">Test failed to run: {run.error}</p>}
      {sel && <SegmentEditor test={test} seg={sel} index={Math.max(0, selIndex)} />}
      <p className="hint">
        Combine in one segment (e.g. braking in a left turn on a decline with a pothole), chain segments for a sequence.
        Steady states (Phase A): each segment is checked at a few speeds across its range; order and transients come with the time-based Phase B.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- right: results

const STATE_TEXT: Record<string, string> = { grip: 'grip', sliding: 'sliding', 'abs-limit': 'ABS limit', locked: 'locked', wheelspin: 'wheelspin' };

function Findings({ list }: { list: Finding[] }) {
  return <>{list.map((f) => <div key={`${f.check}${f.text}`} className={`small-text finding sev-${f.severity}`}>{SEV_ICON[f.severity]} {f.text}</div>)}</>;
}

export function TestResults() {
  const run = useRun();
  const test = useActiveTest();
  const geom = useApp((s) => s.geom);
  const corners = useApp((s) => s.corners);
  const view = useApp((s) => s.testView);
  const set = useApp((s) => s.set);
  const disp = useDisplay();
  const r = run.result;
  const stale = useMemo(() => {
    const f = run.from as { geom: unknown; corners: unknown } | null;
    return !!f && (f.geom !== geom || f.corners !== corners);
  }, [run.from, geom, corners]);

  if (!test) return <section className="panel"><h2>Test results</h2><p className="muted">Create a test on the left.</p></section>;
  if (!r || run.testId !== test.id) return <section className="panel"><h2>Test results</h2><p className="muted">Run the test to see whether it passes in every segment.</p></section>;
  if (r.error) return <section className="panel"><h2>Test results</h2><p className="hint warn-text">{r.error}</p></section>;

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
  const makePass = () => {
    const s = useApp.getState();
    s.updateVehicleOptimizer((o) => ({
      ...o, caseSource: test.id,
      goals: { ...o.goals, testPass: { ...o.goals.testPass, on: true } },
    }));
    s.set('vehicleTab', 'optimize');
    switchWorkspace('vehicle');
  };
  const status = r.severity === 'fail' ? 'Failed' : r.severity === 'warn' ? 'Passed with warnings' : 'Passed';
  // Fails that geometry can't change (no drive / brakes, beyond the tires, rollover) aren't worth optimizing.
  const UNFIXABLE = new Set(['beyondGrip', 'rollover', 'noSolution']);
  const fixable = r.segments.some((s) => !s.impossible && s.findings.some((f) => f.severity === 'fail' && !UNFIXABLE.has(f.check)
    && !(f.check === 'speedNotReached' && /No (powered|braked) wheels/.test(f.text))));

  return (
    <section className="panel">
      <h2>
        Test results
        <span className={`status ${r.severity === 'fail' ? 'status-not-converged' : r.severity === 'warn' ? 'status-singular' : 'status-converged'}`}>{status}</span>
      </h2>
      {stale && <p className="hint warn-text">The design changed since this run: run again.</p>}
      <table className="corner-table test-table">
        <thead><tr><th>#</th><th>Segment</th><th title="Worst tire grip use">Grip</th><th /></tr></thead>
        <tbody>
          {r.segments.map((s) => {
            const def = test.segments[s.index];
            return (
              <tr key={s.index} className={`sev-${s.severity}${view?.segment === s.index ? ' sel' : ''}`} onClick={() => pick(s.index, 0)} title="Show this segment">
                <td>{s.index + 1}</td>
                <td>{def?.name ?? ''}</td>
                <td>{Number.isFinite(s.maxUtilization) ? `${fmt(s.maxUtilization * 100, 0)} %` : '—'}</td>
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
            {s.speedLimit !== undefined && (
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
              {sel.grip ? (
                <table className="corner-table grip-table">
                  <thead><tr><th /><th>Load</th><th>Grip use</th><th>State</th><th>Travel</th></tr></thead>
                  <tbody>
                    {CORNER_IDS.map((id: CornerId) => {
                      const g = sel.grip!.corners[id];
                      const c = sel.corners![id];
                      return (
                        <tr key={id} className={g.utilization > 1 ? 'bad' : g.utilization > 0.9 ? 'warn' : ''}>
                          <td><b>{id}</b></td>
                          <td>{disp.format(c.tireLoad, 'N', 0)}</td>
                          <td>{fmt(g.utilization * 100, 0)} %</td>
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
      <OptimizeSection test={test} run={r} fixable={fixable} onOpenOptimizer={makePass} />
      <p className="hint">
        Grip uses the placeholder tire grip model (not the official one yet). Steady states: what the car does after a tire slides
        (runs wide, spins) needs the handling model (Phase C).
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

/** Optimize from here: until it passes, improve, explore beyond the ranges. */
function OptimizeSection({ test, run, fixable, onOpenOptimizer }: { test: TestDesign; run: TestRun; fixable: boolean; onOpenOptimizer: () => void }) {
  const loop = useLoop();
  const vo = useApp((s) => s.vehicleOptimizer);
  const free = Object.keys(vo.ranges).length;
  const goals = VEHICLE_GOAL_KINDS.filter((k) => vo.goals[k].on && k !== 'testPass' && k !== 'testReserve').map((k) => VEHICLE_GOAL_META[k].short);
  const failing = !run.passed;
  return (
    <Section title="Optimize">
      <p className="small-text">
        Free coordinates: <b>{free || 'none yet (you\'ll be asked to free all available)'}</b>
        {goals.length ? <> · other goals kept: <b>{goals.join(', ')}</b></> : ' · no other goals'}
        {' · '}<button className="link-btn" onClick={onOpenOptimizer}>edit in Vehicle → Optimize</button>
      </p>
      {!loop.running && (
        <div className="jm-row">
          {failing && fixable && <button className="wide-btn primary" onClick={() => void optimizeTest(test, 'pass')} title="Optimize, apply, re-run the test, until it passes or stops improving">▶ Optimize until it passes</button>}
          {!failing && <button className="wide-btn primary" onClick={() => void optimizeTest(test, 'improve')} title="Lower grip use everywhere (priority-weighted; failing segments get extra weight)">▶ Improve (more grip reserve)</button>}
          <button className="wide-btn" onClick={() => void exploreRanges(test)} title="Try once with the free ranges widened ×2; shows the result before using it">Explore beyond the ranges…</button>
        </div>
      )}
      {failing && !fixable && (
        <p className="hint warn-text">These failures can't be fixed by moving suspension points (no powered / braked wheels, or more than the tires can give): change the corner settings, the test, or the tires.</p>
      )}
      {loop.running && (
        <div className="jm-row">
          <span className="muted">{loop.mode === 'explore' ? 'Exploring…' : `Round ${loop.round}…`}</span>
          <button className="chip" onClick={() => loop.cancel?.()}>■ Stop</button>
        </div>
      )}
      {loop.log.length > 0 && <ol className="loop-log">{loop.log.map((l, i) => <li key={i} className="small-text">{l}</li>)}</ol>}
      {loop.outcome === 'passed' && <p className="small-text ok-text">✓ Passes now. Each applied round can be undone (Ctrl+Z).</p>}
      {loop.outcome === 'improved' && <p className="small-text ok-text">Done improving. Each applied round can be undone (Ctrl+Z).</p>}
      {loop.outcome === 'stopped' && <p className="small-text muted">Stopped.</p>}
      {(loop.outcome === 'stuck' || loop.outcome === 'error' || loop.outcome === 'improved') && loop.explanation.map((x) => <p key={x} className={`small-text ${loop.outcome === 'improved' ? 'muted' : 'warn-text'}`}>{x}</p>)}
      {loop.exploration && (
        <div className="opt-result">
          <div className="locks-head">Beyond the ranges</div>
          <p className="small-text">
            Candidate {loop.exploration.candidateRun.passed ? (loop.exploration.candidateRun.severity === 'warn' ? 'passes with warnings' : 'passes') : 'still fails'}
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
            <button className="wide-btn primary" disabled={loop.exploration.after >= loop.exploration.before} onClick={() => acceptExploration(test)}>Use it (and widen those ranges)</button>
            <button className="wide-btn" onClick={() => useLoop.setState({ exploration: null })}>Keep my ranges</button>
          </div>
        </div>
      )}
    </Section>
  );
}
