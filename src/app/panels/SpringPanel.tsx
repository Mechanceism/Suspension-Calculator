import { useApp, SPRING_KEYS, SPRING_META, DAMPER_KEYS, DAMPER_META, DAMPER_TWO_STAGE_KEYS, rootOf, type ArmChoice, type SpringKey } from '../store';
import { lockKeys } from '../locks';
import type { Model } from '../useModel';
import { FieldRows, fmt } from './FieldRows';
import { useState } from 'react';
import { dampingRatio, dampingForRatio } from '../../core/suspension/spring';
import { damperForce } from '../../core/vehicle/vehicle';
import { damperOf } from '../optimizer';

/** Spring layout, rate, free length (+ fit) and the corner-load inputs it carries. */
export function SpringFields({ keys = SPRING_KEYS }: { keys?: readonly SpringKey[] }) {
  const spring = useApp((s) => s.spring);
  const setSpringField = useApp((s) => s.setSpringField);
  const damperArm = useApp((s) => s.geom.damperArm);
  const setDamperArm = useApp((s) => s.setDamperArm);
  const fitSpring = useApp((s) => s.fitSpring);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  return (
    <>
      <div className="row">
        <span className="muted">Layout</span>
        <select value="coilover" disabled title="Pushrod / rocker layouts are planned">
          <option value="coilover">Coilover, arm → chassis</option>
        </select>
      </div>
      <div className="row">
        <span className="muted">Lower mount on</span>
        <select value={damperArm} onChange={(e) => setDamperArm(e.target.value as ArmChoice)}>
          <option value="lca">Lower control arm</option>
          <option value="uca">Upper control arm</option>
        </select>
      </div>
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
      </div>
      <FieldRows rows={DAMPER_KEYS.filter((k) => (bumpStop || !k.startsWith('bumpStop')) && (damperMode === 'twoStage' || !(DAMPER_TWO_STAGE_KEYS as readonly string[]).includes(k))).map((k) => ({
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
  const spec = damperOf({ damper, damperMode });
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
      <text x={cx + 4} y={pad} className="axis-text">{Math.round(fMax)} N</text>
    </svg>
  );
}
