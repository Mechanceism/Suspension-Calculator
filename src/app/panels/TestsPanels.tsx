/**
 * Tests workspace (Phase A, quasi-static): build a test from segments (speed change over a distance,
 * straight / left / right turn, grade, bank, bumps), run it on the whole car, and see per segment
 * whether every tire stays within its grip, what limits the car, and the speed that would pass.
 * Shares the one design with the Corner and Vehicle views: the center view shows the car in the
 * selected state, and "Show in Vehicle view" carries that state over.
 */
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { parseValue, type Quantity } from '../../core/units/units';
import { CORNER_IDS, type CornerId } from '../../core/vehicle/vehicle';
import { segmentLongG, segmentLatG, segmentDuration, type PathKind } from '../../core/tests/segments';
import type { TestRun, StateResult } from '../../core/tests/run';
import { useApp, type Field } from '../store';
import { SEGMENT_PRESETS, TEST_PRESETS, newSegment, newTestId, segmentSpec, isOff, OFF, type TestDesign, type TestSegment } from '../tests';
import { buildVehicleProblem, runTestJob } from '../optimizer';
import { switchWorkspace } from '../viewport/SafeHtml';
import { ValueInput } from './ValueInput';
import { Section, fmt } from './FieldRows';
import { useDisplay } from '../units';

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
const useRun = create<RunStore>(() => ({ running: false, testId: null, result: null, from: null, error: null, cancel: null }));

function useActiveTest(): TestDesign | null {
  const tests = useApp((s) => s.tests);
  const id = useApp((s) => s.activeTestId);
  return tests.find((t) => t.id === id) ?? tests[0] ?? null;
}

const updateTest = (id: string, fn: (t: TestDesign) => TestDesign) =>
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

// ---------------------------------------------------------------- left: builder

function SegmentCard({ test, seg, index }: { test: TestDesign; seg: TestSegment; index: number }) {
  const disp = useDisplay();
  const spec = segmentSpec(seg);
  const ax = segmentLongG(spec);
  const ay0 = segmentLatG(spec, spec.v0), ay1 = segmentLatG(spec, spec.v1);
  const dur = segmentDuration(spec);
  const upd = (fn: (s: TestSegment) => TestSegment) => updateSegment(test.id, seg.id, fn);
  const n = test.segments.length;
  const move = (d: -1 | 1) => updateTest(test.id, (t) => {
    const a = [...t.segments];
    const j = index + d;
    if (j < 0 || j >= a.length) return t;
    [a[index], a[j]] = [a[j]!, a[index]!];
    return { ...t, segments: a };
  });
  const summary = `${disp.format(seg.speedStart.value, 'm/s', 0)} → ${disp.format(seg.speedEnd.value, 'm/s', 0)} · ${seg.path === 'straight' ? 'straight' : `${seg.path} R ${disp.format(seg.radius.value, 'm', 0)}`}`
    + `${seg.grade.value ? ` · ${seg.grade.value > 0 ? '+' : ''}${seg.grade.value}%` : ''}${CORNER_IDS.some((id) => seg.bumps[id].value) ? ' · bumps' : ''}${seg.lumpy ? ' · lumpy' : ''}`;
  return (
    <Section
      title={`${index + 1}. ${seg.name}`}
      open={false}
      extra={(
        <span className="seg-tools" onClick={(e) => e.preventDefault()}>
          <button className="icon-btn" disabled={index === 0} onClick={() => move(-1)} title="Move up">↑</button>
          <button className="icon-btn" disabled={index === n - 1} onClick={() => move(1)} title="Move down">↓</button>
          <button className="icon-btn" title="Duplicate" onClick={() => updateTest(test.id, (t) => ({ ...t, segments: [...t.segments.slice(0, index + 1), { ...structuredClone(seg), id: newTestId('seg'), name: `${seg.name} (copy)` }, ...t.segments.slice(index + 1)] }))}>⧉</button>
          <button className="icon-btn" title="Remove" disabled={n <= 1} onClick={() => updateTest(test.id, (t) => ({ ...t, segments: t.segments.filter((x) => x.id !== seg.id) }))}>✕</button>
        </span>
      )}
    >
      <div className="muted small-text seg-summary">{summary}</div>
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
          <tr title="+ = uphill (incline), − = downhill (decline)">
            <td>Grade</td>
            <td><ValueInput field={seg.grade} unit="%" width={56} onCommit={(t) => upd((s) => ({ ...s, grade: parse(t, 'percent', s.grade) }))} /></td>
            <td className="unit">%</td><td />
          </tr>
          <tr title="+ = left side lower">
            <td>Bank</td>
            <td><ValueInput field={seg.bank} unit="°" width={56} onCommit={(t) => upd((s) => ({ ...s, bank: parse(t, 'angle', s.bank) }))} /></td>
            <td className="unit">°</td><td />
          </tr>
          <tr title="+ bump, − pothole under that wheel (held while the segment is solved)">
            <td>Bumps</td>
            <td colSpan={3}>
              <div className="bump-grid">
                {CORNER_IDS.map((id) => (
                  <label key={id}>
                    <span className="muted">{id}</span>
                    <ValueInput field={seg.bumps[id]} unit="mm" width={48} onCommit={(t) => upd((s) => ({ ...s, bumps: { ...s.bumps, [id]: parse(t, 'length', s.bumps[id]) } }))} />
                  </label>
                ))}
                <span className="unit">{disp.conv('mm').unit}</span>
              </div>
            </td>
          </tr>
          <tr title="Lumpy road needs the time-based simulation (Phase B); saved now, used then">
            <td>Lumpy road</td>
            <td colSpan={3}>
              <label className="check-inline"><input type="checkbox" checked={seg.lumpy} onChange={() => upd((s) => ({ ...s, lumpy: !s.lumpy }))} /> <span className="muted small-text">time-based (Phase B): not used yet</span></label>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="small-text seg-info">
        Accel {fmt(ax, 2)} g{ax < -0.01 ? ' (braking)' : ''} · lateral {fmt(Math.abs(ay0), 2)}{Math.abs(ay1 - ay0) > 0.005 ? `–${fmt(Math.abs(ay1), 2)}` : ''} g
        {Number.isFinite(dur) ? ` · ${fmt(dur, 1)} s` : ''}
        {!isOff(seg.latG) && seg.path !== 'straight' && spec.v0 > 0 && ` · implied radius ${disp.format((spec.v0 * spec.v0) / (9.80665 * Math.abs(seg.latG.value)), 'm', 0)}`}
      </p>
    </Section>
  );
}

export function TestsSidebar() {
  const tests = useApp((s) => s.tests);
  const test = useActiveTest();
  const set = useApp((s) => s.set);
  const run = useRun();
  const geom = useApp((s) => s.geom);
  const corners = useApp((s) => s.corners);
  const [segPreset, setSegPreset] = useState(0);

  const addTest = (i: number) => {
    const t = { ...TEST_PRESETS[i]!.make(), id: newTestId('test') };
    useApp.getState().updateTests((ts) => [...ts, t]);
    set('activeTestId', t.id);
  };
  const start = () => {
    if (!test) return;
    run.cancel?.();
    const { problem } = buildVehicleProblem(useApp.getState());
    const job = runTestJob(problem, test.segments.map(segmentSpec), {
      margin: Math.min(0.9, Math.max(0, test.margin.value / 100)), onFail: test.onFail, speedLimits: true,
    });
    useRun.setState({ running: true, testId: test.id, error: null, cancel: job.cancel, from: { geom, corners } });
    job.done
      .then((result) => { useRun.setState({ running: false, result, cancel: null }); set('testView', null); })
      .catch((e: unknown) => useRun.setState({ running: false, error: e instanceof Error ? e.message : String(e), cancel: null }));
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
          <tr title="Grip reserve needed to pass: 10% = no tire above 90% of its grip">
            <td>Grip reserve to pass</td>
            <td className="nowrap"><ValueInput field={test.margin} unit="%" width={48} onCommit={(t) => updateTest(test.id, (x) => ({ ...x, margin: parse(t, 'percent', x.margin) }))} /> %</td>
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
      <h3 className="subhead">Segments (in order)</h3>
      {test.segments.map((seg, i) => <SegmentCard key={seg.id} test={test} seg={seg} index={i} />)}
      <div className="jm-row">
        <select value={segPreset} onChange={(e) => setSegPreset(Number(e.target.value))}>
          {SEGMENT_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </select>
        <button className="chip on" onClick={() => updateTest(test.id, (t) => ({ ...t, segments: [...t.segments, newSegment(SEGMENT_PRESETS[segPreset]!.make())] }))}>+ Add segment</button>
      </div>
      <p className="hint">
        Combine in one segment (e.g. braking in a left turn on a decline with a pothole), chain segments for a sequence.
        Steady states (Phase A): each segment is checked at a few speeds across its range; order and transients come with the time-based Phase B.
      </p>
      <div className="jm-row">
        {!run.running
          ? <button className="wide-btn primary" onClick={start}>▶ Run test</button>
          : <button className="wide-btn" onClick={() => { run.cancel?.(); useRun.setState({ running: false, cancel: null }); }}>■ Stop</button>}
      </div>
      {run.running && <p className="muted small-text">Running…</p>}
      {run.error && <p className="hint warn-text">Test failed to run: {run.error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- right: results

const STATE_TEXT: Record<string, string> = { grip: 'grip', sliding: 'sliding', 'abs-limit': 'ABS limit', locked: 'locked', wheelspin: 'wheelspin' };

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
  if (!r || run.testId !== test.id) return <section className="panel"><h2>Test results</h2><p className="muted">Run the test to see whether every tire stays within its grip in every segment.</p></section>;
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
      goals: { ...o.goals, testPass: { ...o.goals.testPass, on: true, target: { text: String(100 - test.margin.value), value: 100 - test.margin.value } } },
    }));
    s.set('vehicleTab', 'optimize');
    switchWorkspace('vehicle');
  };

  return (
    <section className="panel">
      <h2>
        Test results
        <span className={`status ${r.passed ? 'status-converged' : 'status-not-converged'}`}>{r.passed ? 'Passed' : 'Failed'}</span>
      </h2>
      {stale && <p className="hint warn-text">The design changed since this run: run again.</p>}
      <table className="corner-table test-table">
        <thead><tr><th>#</th><th>Segment</th><th title="Worst tire grip use">Grip</th><th /></tr></thead>
        <tbody>
          {r.segments.map((s) => {
            const def = test.segments[s.index];
            return (
              <tr key={s.index} className={`${s.passed ? '' : 'bad'}${view?.segment === s.index ? ' sel' : ''}`} onClick={() => pick(s.index, 0)} title="Show this segment">
                <td>{s.index + 1}</td>
                <td>{def?.name ?? ''}</td>
                <td>{Number.isFinite(s.maxUtilization) ? `${fmt(s.maxUtilization * 100, 0)} %` : '—'}</td>
                <td>{s.passed ? '✓' : '✗'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {r.segments.filter((s) => !s.passed).map((s) => {
        const def = test.segments[s.index];
        const vmax = def ? Math.max(def.speedStart.value, def.speedEnd.value) : 0;
        return (
          <div key={s.index} className="seg-fail">
            <b>{s.index + 1}. {def?.name}</b>
            {s.reasons.map((x) => <div key={x} className="small-text warn-text">{x}</div>)}
            {s.speedLimit !== undefined && (
              <div className="small-text">
                {s.speedLimit > 0
                  ? <>Passes at {fmt(s.speedLimit * 100, 0)}% of its speed (max ≈ {disp.format(vmax * s.speedLimit, 'm/s', 0)}){s.lifted ? ' — driver lifts: re-run at that speed passes.' : '.'}</>
                  : 'Fails even at a crawl: check grip reserve, bumps or travel limits.'}
              </div>
            )}
          </div>
        );
      })}
      {view && segRes && (
        <Section title={`Segment ${view.segment + 1}: ${segDef?.name ?? ''}`}>
          <div className="jm-row">
            {segStates.map((st, i) => (
              <button key={st.state.name} className={`chip${view.sample === i ? ' on' : ''}${st.passed ? '' : ' bad-chip'}`} onClick={() => pick(view.segment, i)}>
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
                          <td>{STATE_TEXT[g.state]}{c.status !== 'ok' ? ` · ${c.status}` : ''}</td>
                          <td>{disp.format(c.travel, 'mm', 1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : <p className="hint warn-text">This state did not settle.</p>}
              {sel.grip?.limits.map((l) => <p key={l.text} className="hint warn-text">{l.text}</p>)}
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
      {!r.passed && (
        <div className="jm-row">
          <button className="wide-btn primary" onClick={makePass} title="Open the vehicle optimizer with this test as its load cases and a 'test passes' goal">
            Make it pass with the optimizer…
          </button>
        </div>
      )}
      <p className="hint">
        Grip uses the placeholder tire grip model (not the official one yet). Steady states: a sliding tire's lost force and what the car
        does next (runs wide, spins) need the handling model (Phase C).
      </p>
    </section>
  );
}

/** Under the 3D view in the Tests workspace: which state is shown. */
export function TestViewBar() {
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
