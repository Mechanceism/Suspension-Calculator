import { useApp, layoutOf, rockerAllowed, toGeometry, DEFAULT_DAMPER_CURVE, type DamperCurveText, type SpringLayout, SPRING_KEYS, SPRING_META, DAMPER_KEYS, DAMPER_META, DAMPER_TWO_STAGE_KEYS, rootOf, type ArmChoice, type SpringKey } from '../store';
import { lockKeys } from '../locks';
import type { Model } from '../useModel';
import { FieldRows, fmt } from './FieldRows';
import { useState } from 'react';
import { dampingRatio, dampingForRatio } from '../../core/suspension/spring';
import { damperForce, parseDamperCurve } from '../../core/vehicle/vehicle';
import { damperOf } from '../optimizer';
import { ValueInput } from './ValueInput';
import { parseValue } from '../../core/units/units';
import { rockerRatio, rockerRatioMove } from '../../core/suspension/coilover';
import { Local, Val } from './UnitText';

/** Spring layout, rate, free length (+ fit) and the corner-load inputs it carries. */
export function SpringFields({ keys = SPRING_KEYS }: { keys?: readonly SpringKey[] }) {
  const spring = useApp((s) => s.spring);
  const setSpringField = useApp((s) => s.setSpringField);
  const damperArm = useApp((s) => s.geom.damperArm);
  const kind = useApp((s) => s.geom.kind ?? 'doubleWishbone');
  const layout = useApp((s) => layoutOf(s.geom));
  const pushrodOn = useApp((s) => s.geom.pushrodOn ?? 'lca');
  const setSpringLayout = useApp((s) => s.setSpringLayout);
  const setPushrodOn = useApp((s) => s.setPushrodOn);
  const setDamperArm = useApp((s) => s.setDamperArm);
  const fitSpring = useApp((s) => s.fitSpring);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  return (
    <>
      <div className="row" title="A coilover straight from the arm / knuckle to the frame, or a pushrod (pullrod) to a rocker on the frame with the spring on the rocker (the motion ratio then comes from the linkage)">
        <span className="muted">Layout</span>
        <select value={layout} disabled={!rockerAllowed(kind)} onChange={(e) => setSpringLayout(e.target.value as SpringLayout)}>
          <option value="coilover">{kind === 'beamLeaf' ? 'Leaf springs (rate at the seat)' : kind === 'rigid' ? 'None (no suspension)' : kind === 'macpherson' ? 'Strut (upright → top mount)' : kind === 'multilink' ? 'Coilover, upright → chassis' : 'Coilover, arm → chassis'}</option>
          {rockerAllowed(kind) && <option value="rocker">Pushrod / pullrod + rocker</option>}
        </select>
      </div>
      {layout === 'rocker' && <RockerRatioRow />}
      {layout === 'rocker' && (
        <div className="row" title="What the pushrod's lower end is fixed to (moving it keeps its spot on the arm)">
          <span className="muted">Pushrod lower end on</span>
          <select value={pushrodOn} onChange={(e) => setPushrodOn(e.target.value as ArmChoice)}>
            {kind !== 'multilink' && <option value="lca">{kind === 'singleArm' ? 'The arm' : 'Lower control arm'}</option>}
            {kind === 'doubleWishbone' && <option value="uca">Upper control arm</option>}
            <option value="upright">Upright / knuckle</option>
          </select>
        </div>
      )}
      {layout === 'coilover' && (kind === 'doubleWishbone' || kind === 'singleArm') && (
        <div className="row">
          <span className="muted">Lower mount on</span>
          <select value={kind === 'singleArm' && damperArm === 'uca' ? 'lca' : damperArm} onChange={(e) => setDamperArm(e.target.value as ArmChoice)}>
            <option value="lca">{kind === 'singleArm' ? 'The arm' : 'Lower control arm'}</option>
            {kind === 'doubleWishbone' && <option value="uca">Upper control arm</option>}
            <option value="upright">Upright / knuckle</option>
          </select>
        </div>
      )}
      <FieldRows rows={keys.map((k) => ({
        label: SPRING_META[k].label, field: spring[k], unit: SPRING_META[k].unit, onCommit: (t: string) => setSpringField(k, t),
        lockKey: lockKeys.field(root, 'spring', k),
      }))} />
      <button className="wide-btn" onClick={fitSpring} title="Free length that holds the static corner load at the design position (travel 0)">
        Fit free length to design ride height
      </button>
    </>
  );
}

/** Damper stroke limits and bump stop. */
export function DamperFields({ model }: { model: Model }) {
  const damper = useApp((s) => s.damper);
  const setDamperField = useApp((s) => s.setDamperField);
  const bumpStop = useApp((s) => s.bumpStop);
  const damperMode = useApp((s) => s.damperMode);
  const set = useApp((s) => s.set);
  const lim = model.damperLimits;
  const root = useApp((s) => rootOf(s.activeCorner, s.links));

  const useLimits = () => {
    if (lim?.droop !== null && lim?.droop !== undefined) set('droop', Math.round(-lim.droop * 10) / 10);
    if (lim?.bump !== null && lim?.bump !== undefined) set('bump', Math.round(lim.bump * 10) / 10);
  };
  return (
    <>
      <div className="jm-row" title="Linear: one rate per direction. Two-stage: a low-speed rate up to a knee shaft speed, then a high-speed rate (most road and race dampers are digressive: softer past the knee).">
        <span className="muted">Damper curve</span>
        <button className={`chip${damperMode === 'linear' ? ' on' : ''}`} onClick={() => set('damperMode', 'linear')}>Linear</button>
        <button className={`chip${damperMode === 'twoStage' ? ' on' : ''}`} onClick={() => set('damperMode', 'twoStage')}>Two-stage</button>
        <button className={`chip${damperMode === 'curve' ? ' on' : ''}`} title="Measured force vs shaft speed from a damper dyno, with a clicker between full soft and full firm" onClick={() => set('damperMode', 'curve')}>Dyno curve</button>
      </div>
      {damperMode === 'curve' && <DynoCurveFields />}
      <FieldRows rows={DAMPER_KEYS.filter((k) => (bumpStop || !k.startsWith('bumpStop')) && (damperMode === 'twoStage' || !(DAMPER_TWO_STAGE_KEYS as readonly string[]).includes(k)) && !(damperMode === 'curve' && /Damping|Knee/.test(k))).map((k) => ({
        label: k === 'bumpDamping' && damperMode === 'twoStage' ? 'Bump, low speed' : k === 'reboundDamping' && damperMode === 'twoStage' ? 'Rebound, low speed' : DAMPER_META[k].label,
        field: damper[k], unit: DAMPER_META[k].unit, onCommit: (t: string) => setDamperField(k, t),
        lockKey: lockKeys.field(root, 'damper', k),
      }))} />
      <DamperCurve />
      <DampingFit model={model} />
      <label className="check-row">
        <input type="checkbox" checked={bumpStop} onChange={() => set('bumpStop', !bumpStop)} />
        Bump stop
      </label>
      <FieldRows rows={[
        { label: 'Droop limit from damper', value: fmt(lim?.droop ?? null, 1), unit: 'mm', hint: 'wheel-center travel where the damper is fully extended' },
        { label: 'Bump limit from damper', value: fmt(lim?.bump ?? null, 1), unit: 'mm', hint: 'wheel-center travel where the damper is fully compressed' },
      ]} />
      <button className="wide-btn" onClick={useLimits} disabled={!lim || (lim.droop === null && lim.bump === null)}>
        Use damper limits as the travel range
      </button>
    </>
  );
}

export function SpringPanel({ model }: { model: Model }) {
  return (
    <section className="panel">
      <h2>Spring & load</h2>
      <SpringFields />
      <h3 className="subhead">Damper & bump stop</h3>
      <DamperFields model={model} />
    </section>
  );
}

const G = 9.80665;

/** Damping ratio now, and set the damper rates for a target ratio (bump / rebound). */
function DampingFit({ model }: { model: Model }) {
  const damper = useApp((s) => s.damper);
  const setDamperField = useApp((s) => s.setDamperField);
  const sp = model.current?.spring;
  const [zb, setZb] = useState('0.3');
  const [zr, setZr] = useState('0.5');
  if (!sp) return null;
  const m = sp.sprungLoad / G;
  const now = (c: number) => fmt(dampingRatio(c, sp.motionRatio, sp.rideRate, m), 2);
  const fit = () => {
    const b = Number(zb), r = Number(zr);
    if (Number.isFinite(b) && b > 0) setDamperField('bumpDamping', String(Math.round(dampingForRatio(b, sp.motionRatio, sp.rideRate, m))));
    if (Number.isFinite(r) && r > 0) setDamperField('reboundDamping', String(Math.round(dampingForRatio(r, sp.motionRatio, sp.rideRate, m))));
  };
  return (
    <div className="damping-fit">
      <div className="muted small-text">
        Damping ratio now: bump <b>{now(damper.bumpDamping.value)}</b> · rebound <b>{now(damper.reboundDamping.value)}</b>
        {' '}(0.25–0.4 ride, 0.6–0.7 handling). Dampers act in motion: they matter in the time-based tests (planned); steady states don't use them.
      </div>
      <div className="jm-row">
        <span className="muted">Target ζ</span>
        <input className="value-input small" value={zb} onChange={(e) => setZb(e.target.value)} title="Bump damping ratio" />
        <input className="value-input small" value={zr} onChange={(e) => setZr(e.target.value)} title="Rebound damping ratio" />
        <button className="chip on" onClick={fit} title="Set the bump / rebound damper rates for these damping ratios at the static position">Set damper rates</button>
      </div>
    </div>
  );
}

/** Damper force vs shaft speed, bump (left, compression) and rebound (right). */
function DamperCurve() {
  const damper = useApp((s) => s.damper);
  const damperMode = useApp((s) => s.damperMode);
  const damperCurve = useApp((s) => s.damperCurve);
  const spec = damperOf({ damper, damperMode, damperCurve });
  const vMax = 0.5;
  const W = 260, H = 110, cx = W / 2, pad = 14;
  const fMax = Math.max(1, ...[-vMax, vMax].map((v) => Math.abs(damperForce(spec, v))));
  const px = (v: number) => cx + (v / vMax) * (W / 2 - pad);
  const py = (f: number) => H / 2 - (f / fMax) * (H / 2 - pad);
  const pts = Array.from({ length: 81 }, (_, i) => -vMax + (2 * vMax * i) / 80).map((v) => `${px(v).toFixed(1)},${py(damperForce(spec, v)).toFixed(1)}`).join(' ');
  return (
    <svg className="tire-plot damper-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Damper force vs shaft speed">
      <line x1={pad} x2={W - pad} y1={H / 2} y2={H / 2} className="grid-line" />
      <line x1={cx} x2={cx} y1={pad / 2} y2={H - pad / 2} className="grid-line" />
      <polyline points={pts} fill="none" stroke="#ffd166" strokeWidth={1.6} />
      <text x={pad} y={H - 3} className="axis-text">bump −{vMax} m/s</text>
      <text x={W - pad} y={H - 3} className="axis-text" textAnchor="end">rebound +{vMax} m/s</text>
      <text x={cx + 4} y={pad} className="axis-text"><Val v={Math.round(fMax)} unit="N" digits={0} /></text>
    </svg>
  );
}

/**
 * Rocker ratio: the spring end's lever about the rocker's pivot axis ÷ the pushrod end's (each its distance
 * from the axis). Typing a ratio slides the spring's rocker end along its arm (same direction from the
 * axis) and moves the coilover's frame end with it, so the coilover keeps its length and angle.
 */
function RockerRatioRow() {
  const geom = useApp((s) => s.geom);
  const g = toGeometry(geom);
  if (!g.rocker || !g.damper) return null;
  const { ratio, pushrodLever: lp, springLever: ls } = rockerRatio(g);
  const commit = (text: string) => {
    const v = parseValue(text, 'ratio');
    const d = v.ok ? rockerRatioMove(g, v.value) : null;
    if (!d) { useApp.getState().notify('Enter a rocker ratio above 0.', 'warn'); return; }
    const s = useApp.getState();
    const pts = s.geom.points;
    s.setPointsAxis(([0, 1, 2] as const).flatMap((a) => [
      { key: 'dmpArm' as const, axis: a, value: Number((pts.dmpArm[a].value + [d.x, d.y, d.z][a]!).toFixed(4)) },
      { key: 'dmpChassis' as const, axis: a, value: Number((pts.dmpChassis[a].value + [d.x, d.y, d.z][a]!).toFixed(4)) },
    ]));
  };
  return (
    <div className="row" title="Spring end's lever about the rocker pivot ÷ the pushrod end's. Above 1 the spring moves more than the pushrod. Typing a value slides the spring's rocker end along its arm (and the coilover with it, keeping its length).">
      <span className="muted">Rocker ratio (spring ÷ pushrod lever)</span>
      <ValueInput field={{ text: Number.isFinite(ratio) ? ratio.toFixed(3) : '', value: ratio }} unit="" width={64} onCommit={commit} />
      <span className="muted small-text"><Local text={`${fmtMm(lp)} / ${fmtMm(ls)} mm`} /></span>
    </div>
  );
}

const fmtMm = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '—');

/**
 * Dyno curves: "shaft speed mm/s, force N" per line for bump and rebound at full soft and (optionally) full
 * firm; with a click count, the current click blends between them (0 = full soft).
 */
function DynoCurveFields() {
  const c = useApp((s) => s.damperCurve) ?? DEFAULT_DAMPER_CURVE;
  const put = (patch: Partial<DamperCurveText>) => useApp.setState({ damperCurve: { ...c, ...patch }, presetId: 'custom' });
  const area = (key: 'softBump' | 'softRebound' | 'firmBump' | 'firmRebound', label: string) => {
    const bad = parseDamperCurve(c[key]).bad;
    return (
      <label className="dyno-curve">
        <span className="muted small-text">{label}</span>
        <textarea rows={4} defaultValue={c[key]} key={c[key]} placeholder="mm/s, N" onBlur={(e) => { if (e.target.value !== c[key]) put({ [key]: e.target.value }); }} />
        {bad.length > 0 && <span className="small-text warn-text">Couldn&apos;t read: {bad.slice(0, 2).join(' · ')}</span>}
      </label>
    );
  };
  const firm = c.firmBump.trim() !== '' || c.firmRebound.trim() !== '';
  return (
    <div className="dyno-fields">
      <p className="hint small-text">Pairs of shaft speed (mm/s) and force (N), one per line, from a dyno sheet; straight between the points and the last slope beyond them.</p>
      <div className="jm-row">{area('softBump', firm ? 'Bump, full soft' : 'Bump')}{area('softRebound', firm ? 'Rebound, full soft' : 'Rebound')}</div>
      <details open={firm}>
        <summary className="small-text">Clicker (full firm curves)</summary>
        <div className="jm-row">{area('firmBump', 'Bump, full firm')}{area('firmRebound', 'Rebound, full firm')}</div>
        <div className="row small-text">
          <span className="muted">Clicks</span>
          <input type="number" min={0} max={60} value={c.clicks} style={{ width: 56 }} onChange={(e) => put({ clicks: Math.max(0, Math.round(Number(e.target.value) || 0)), click: Math.min(c.click, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
          {c.clicks > 0 && (
            <>
              <span className="muted">Setting</span>
              <input type="range" min={0} max={c.clicks} step={1} value={c.click} onChange={(e) => put({ click: Number(e.target.value) })} />
              <b>{c.click}</b><span className="muted">/ {c.clicks} (0 = full soft)</span>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
