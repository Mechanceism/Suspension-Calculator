import { useApp, SPRING_KEYS, SPRING_META, DAMPER_KEYS, DAMPER_META, type ArmChoice, type SpringKey } from '../store';
import type { Model } from '../useModel';
import { FieldRows, fmt } from './FieldRows';

/** Spring layout, rate, free length (+ fit) and the corner-load inputs it carries. */
export function SpringFields({ keys = SPRING_KEYS }: { keys?: readonly SpringKey[] }) {
  const spring = useApp((s) => s.spring);
  const setSpringField = useApp((s) => s.setSpringField);
  const damperArm = useApp((s) => s.geom.damperArm);
  const setDamperArm = useApp((s) => s.setDamperArm);
  const fitSpring = useApp((s) => s.fitSpring);
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
  const set = useApp((s) => s.set);
  const lim = model.damperLimits;
  const useLimits = () => {
    if (lim?.droop !== null && lim?.droop !== undefined) set('droop', Math.round(-lim.droop * 10) / 10);
    if (lim?.bump !== null && lim?.bump !== undefined) set('bump', Math.round(lim.bump * 10) / 10);
  };
  return (
    <>
      <FieldRows rows={DAMPER_KEYS.filter((k) => bumpStop || !k.startsWith('bumpStop')).map((k) => ({
        label: DAMPER_META[k].label, field: damper[k], unit: DAMPER_META[k].unit, onCommit: (t: string) => setDamperField(k, t),
      }))} />
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
