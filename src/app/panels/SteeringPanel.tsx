import { useEffect, useState } from 'react';
import { parseSteerCurve } from '../../core/tests/steer';
import { useApp, angleInput, STEER_META, rackAhead, rootOf, type SteerKey } from '../store';
import { parseValue } from '../../core/units/units';
import { lockKeys } from '../locks';
import { deg } from '../../core/suspension/characteristics';
import type { Model } from '../useModel';
import { FieldRows, fmt } from './FieldRows';

const SYSTEM: SteerKey[] = ['cFactor', 'cFactorLock', 'rackLimit'];
/** Labels and units of the steering inputs for the mechanism (arm: degrees instead of mm). */
export function steerLabel(k: SteerKey, arm: boolean): { label: string; unit: string } {
  const m = STEER_META[k];
  if (!arm) return { label: m.label, unit: m.unit };
  if (k === 'cFactor') return { label: 'Arm angle per steering-wheel rev', unit: '°/rev' };
  if (k === 'cFactorLock') return { label: 'Same at full lock (geared cam; 0 = constant)', unit: '°/rev' };
  if (k === 'rackLimit') return { label: 'Arm angle limit (±)', unit: '°' };
  return { label: m.label, unit: m.unit };
}
const FORCES: SteerKey[] = ['lateral', 'longitudinal', 'pneumaticTrail', 'mu', 'effortG'];

export function SteerFields({ keys }: { keys: SteerKey[] }) {
  const steer = useApp((s) => s.steer);
  const setSteerField = useApp((s) => s.setSteerField);
  const arm = useApp((s) => angleInput(s.geom.steerMechanism));
  return (
    <FieldRows rows={keys.map((k) => ({
      label: steerLabel(k, arm).label, field: steer[k], unit: steerLabel(k, arm).unit, onCommit: (t: string) => setSteerField(k, t),
      lockKey: `steer.${k}`, hint: STEER_META[k].hint,
    }))} />
  );
}

export const SteeringSystemFields = () => <><MechanismRow /><SteerFields keys={SYSTEM} /><RatioCurveField /><RackLayoutFields /></>;

/**
 * A measured steering ratio: steering-wheel angle vs input (rack mm, or arm ° with a steering arm) from
 * center out, one pair per line. When it reads, it replaces the c-factors above (mirrored the other way).
 */
function RatioCurveField() {
  const text = useApp((s) => s.steerCurve ?? '');
  const arm = useApp((s) => angleInput(s.geom.steerMechanism));
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const parsed = draft.trim() ? parseSteerCurve(draft) : null;
  return (
    <details className="ratio-curve" open={!!text}>
      <summary title="Measured or published steering ratio: steering-wheel angle and the rack travel (or arm angle) at it, from center to lock">Measured ratio curve {text ? '(in use)' : '(optional)'}</summary>
      <textarea rows={4} value={draft} placeholder={`steering-wheel °, ${arm ? 'arm °' : 'rack mm'} — e.g.\n90, 18\n180, 38\n360, 82\n540, 120`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== text) useApp.setState({ steerCurve: draft.trim() ? draft : undefined, presetId: 'custom' }); }} />
      {parsed && (
        <div className={`small-text ${parsed.ok && !parsed.bad.length ? 'muted' : 'warn-text'}`}>
          {parsed.ok ? `${parsed.curve.length} pairs read; it replaces the c-factors (the local ratio comes from its slope).` : 'Needs pairs that both grow from center out (steering-wheel °, then input).'}
          {parsed.bad.length > 0 && ` Couldn't read: ${parsed.bad.slice(0, 3).join(' · ')}`}
        </div>
      )}
    </details>
  );
}

/** Rack, or steering arm / plate (ATV plate on the column, pitman / idler arm with a center link). */
function MechanismRow() {
  const m = useApp((s) => s.geom.steerMechanism ?? 'rack');
  const setM = useApp((s) => s.setSteerMechanism);
  return (
    <div className="row" title="Rack: the inner tie-rod joints slide across the car. Steering arm / plate: they swing about a pivot axis (an ATV plate on the steering column, or a steering box's pitman arm / idler arm carrying a center link). Applies to every corner.">
      <span className="muted">Mechanism</span>
      <select value={m} onChange={(e) => setM(e.target.value as 'rack' | 'arm' | 'centerLink')}>
        <option value="rack">Rack and pinion</option>
        <option value="arm">Steering arm / plate (box, cam, ATV)</option>
        <option value="centerLink">Pitman arm, idler arm and center link</option>
      </select>
    </div>
  );
}

/**
 * Where the rack sits and how long it is: ahead of / behind the axle, and the distance between its inner
 * ball joints (left and right mirror images: 2 × the inner joint's X). The tie rods reach from there to the
 * steering arms.
 */
export function RackLayoutFields() {
  const geom = useApp((s) => s.geom);
  const setRackSide = useApp((s) => s.setRackSide);
  const setPointsAxis = useApp((s) => s.setPointsAxis);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const pt = (k: 'trInner' | 'trOuter') => geom.points[k].map((f) => f.value);
  const [ix, iy, iz] = pt('trInner'), [ox, oy, oz] = pt('trOuter');
  const length = 2 * Math.abs(ix!);
  if (geom.steerMechanism === 'centerLink') {
    // Pitman / idler arm lengths (ball end to its pivot axis) and the center link.
    const v = (k: 'strPiv1' | 'strPiv2' | 'pitEnd' | 'idlPiv1' | 'idlPiv2' | 'idlEnd' | 'trInner') => geom.points[k].map((f) => f.value) as [number, number, number];
    const armLen = (a1: [number, number, number], a2: [number, number, number], q: [number, number, number]) => {
      const a = [a2[0] - a1[0], a2[1] - a1[1], a2[2] - a1[2]], r = [q[0] - a1[0], q[1] - a1[1], q[2] - a1[2]];
      const t = (r[0]! * a[0]! + r[1]! * a[1]! + r[2]! * a[2]!) / Math.max(a[0]! ** 2 + a[1]! ** 2 + a[2]! ** 2, 1e-12);
      return Math.hypot(r[0]! - t * a[0]!, r[1]! - t * a[1]!, r[2]! - t * a[2]!);
    };
    const pe = v('pitEnd'), ie = v('idlEnd');
    return (
      <FieldRows rows={[
        { label: 'Pitman arm length', value: fmt(armLen(v('strPiv1'), v('strPiv2'), pe), 1), unit: 'mm', hint: 'Its ball end (FL_Pitman_End) to its pivot axis (FL_Str_Piv1 / 2)' },
        { label: 'Idler arm length', value: fmt(armLen(v('idlPiv1'), v('idlPiv2'), ie), 1), unit: 'mm', hint: 'Its ball end (FL_Idler_End) to its pivot axis (FL_Idler_Piv1 / 2). Equal to the pitman and parallel to it: the center link slides across the car without turning.' },
        { label: 'Center link length', value: fmt(Math.hypot(ie[0] - pe[0], ie[1] - pe[1], ie[2] - pe[2]), 1), unit: 'mm' },
        { label: 'Tie-rod length', value: fmt(Math.hypot(ox! - ix!, oy! - iy!, oz! - iz!), 1), unit: 'mm' },
      ]} />
    );
  }
  if (geom.steerMechanism === 'arm') {
    const [p1x, p1y, p1z] = geom.points.strPiv1.map((f) => f.value), [p2x, p2y, p2z] = geom.points.strPiv2.map((f) => f.value);
    // Arm length: the inner joint's distance from the pivot axis.
    const a = [p2x! - p1x!, p2y! - p1y!, p2z! - p1z!], r = [ix! - p1x!, iy! - p1y!, iz! - p1z!];
    const al = Math.hypot(...a);
    const t = (r[0]! * a[0]! + r[1]! * a[1]! + r[2]! * a[2]!) / (al * al);
    const armLen = Math.hypot(r[0]! - t * a[0]!, r[1]! - t * a[1]!, r[2]! - t * a[2]!);
    return (
      <FieldRows rows={[
        { label: 'Steering arm length', value: fmt(armLen, 1), unit: 'mm', hint: 'Inner tie-rod joint to the arm\'s pivot axis (move FL_Str_Piv1 / 2 or FL_TR_In to change it)' },
        { label: 'Tie-rod length', value: fmt(Math.hypot(ox! - ix!, oy! - iy!, oz! - iz!), 1), unit: 'mm' },
      ]} />
    );
  }
  return (
    <>
      <div className="row" title="Behind the axle (the steering arms point back) or ahead of it (they point forward). Switching mirrors the steering arm through the steering axis.">
        <span className="muted">Rack position</span>
        <select value={rackAhead(geom) ? 'ahead' : 'behind'} onChange={(e) => setRackSide(e.target.value === 'ahead')}>
          <option value="behind">Behind the axle</option>
          <option value="ahead">Ahead of the axle</option>
        </select>
      </div>
      <FieldRows rows={[
        {
          label: 'Rack length (inner ball joint to ball joint)', field: { text: fmt(length, 1), value: length }, unit: 'mm',
          hint: 'Racks come in fixed lengths: set it here (moves both inner tie-rod joints in X); the tie rods then reach to the steering arms. Lock it with the inner joint\'s X.',
          onCommit: (t: string) => { const r = parseValue(t, 'length'); if (r.ok && r.value > 0) setPointsAxis([{ key: 'trInner', axis: 0, value: (Math.sign(ix!) || 1) * r.value / 2 }]); },
          lockKey: lockKeys.point(root, 'trInner', 0),
        },
        { label: 'Tie-rod length', value: fmt(Math.hypot(ox! - ix!, oy! - iy!, oz! - iz!), 1), unit: 'mm', hint: 'Inner to outer ball joint (follows from the rack length and the steering arm)' },
      ]} />
    </>
  );
}
export const TireForceFields = () => <SteerFields keys={FORCES} />;

/** Steering results: angles, ratio, and the forces back to the rack and steering wheel. */
export function SteeringReadout({ model }: { model: Model }) {
  const st = model.current?.steering;
  if (!st) return null;
  const l = st.loads;
  // Ackermann: at this steering position (nearest sample), and at full lock.
  const sw = model.steerSweep;
  const here = sw.reduce<(typeof sw)[number] | null>((b, q) => (!b || Math.abs(q.steeringWheelAngle - st.steeringWheelAngle) < Math.abs(b.steeringWheelAngle - st.steeringWheelAngle) ? q : b), null);
  const lock = sw.at(-1);
  return (
    <FieldRows rows={[
      { label: 'Steering-wheel angle', value: fmt(st.steeringWheelAngle, 1), unit: '°' },
      { label: 'Road-wheel angle', value: fmt(deg(st.roadWheelAngle), 2), unit: '°', hint: '+ = front of wheel toward outboard (left turn for FL)' },
      { label: 'Steering ratio', value: fmt(st.ratio, 2), unit: ':1', hint: 'steering-wheel deg per road-wheel deg, at this position' },
      { label: 'Ackermann (here)', value: fmt(here?.ackermann, 0), unit: '%', hint: 'With the mirrored corner and the vehicle wheelbase: (inside − outside angle) ÷ (ideal inside − outside) × 100. 100 = ideal Ackermann, 0 = parallel, < 0 = anti-Ackermann. — near straight ahead' },
      { label: 'Ackermann (full lock)', value: fmt(lock?.ackermann, 0), unit: '%' },
      { label: 'Steering arm (effective)', value: fmt(Math.abs(l.steeringArm), 1), unit: 'mm', hint: 'tie-rod lever about the steering axis' },
      { label: 'Torque about steering axis', value: fmt(l.axisTorque / 1000, 2), unit: 'N·m', hint: '+ = turns the front of the wheel outboard' },
      { label: 'Tie-rod force', value: fmt(l.tieRodForce, 0), unit: 'N', hint: '+ = tension' },
      l.armTorque !== undefined
        ? { label: 'Steering-arm torque', value: fmt(l.armTorque, 1), unit: 'N·m', hint: 'this corner\'s tie rod on the arm, about its pivot axis' }
        : { label: 'Rack force', value: fmt(l.rackForce, 0), unit: 'N', hint: 'this corner, along the rack' },
      { label: 'Steering-wheel torque', value: fmt(l.steeringWheelTorque, 2), unit: 'N·m', hint: 'this corner\'s share' },
      { label: 'Parking scrub torque', value: fmt(st.parkingTorque / 1000, 1), unit: 'N·m', hint: 'turning at standstill: patch twisting about the axis ground point' },
      { label: 'Parking rack force', value: fmt(st.parkingRackForce, 0), unit: 'N' },
      { label: 'Parking steering-wheel torque', value: fmt(st.parkingWheelTorque, 2), unit: 'N·m', hint: 'this corner\'s share' },
    ]} />
  );
}

export function SteeringPanel({ model }: { model: Model }) {
  return (
    <section className="panel">
      <h2>Steering</h2>
      <SteeringSystemFields />
      <h3 className="subhead">Tire forces at the patch</h3>
      <TireForceFields />
      <h3 className="subhead">Results</h3>
      <SteeringReadout model={model} />
    </section>
  );
}
