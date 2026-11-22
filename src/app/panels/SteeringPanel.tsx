import { useApp, STEER_META, rackAhead, rootOf, type SteerKey } from '../store';
import { parseValue } from '../../core/units/units';
import { lockKeys } from '../locks';
import { deg } from '../../core/suspension/characteristics';
import type { Model } from '../useModel';
import { FieldRows, fmt } from './FieldRows';

const SYSTEM: SteerKey[] = ['cFactor', 'rackLimit'];
const FORCES: SteerKey[] = ['lateral', 'longitudinal', 'pneumaticTrail', 'mu'];

export function SteerFields({ keys }: { keys: SteerKey[] }) {
  const steer = useApp((s) => s.steer);
  const setSteerField = useApp((s) => s.setSteerField);
  return (
    <FieldRows rows={keys.map((k) => ({
      label: STEER_META[k].label, field: steer[k], unit: STEER_META[k].unit, onCommit: (t: string) => setSteerField(k, t),
      lockKey: `steer.${k}`,
    }))} />
  );
}

export const SteeringSystemFields = () => <><SteerFields keys={SYSTEM} /><RackLayoutFields /></>;

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
      { label: 'Rack force', value: fmt(l.rackForce, 0), unit: 'N', hint: 'this corner, along the rack' },
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
