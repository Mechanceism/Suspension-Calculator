import { useApp, STEER_META, type SteerKey } from '../store';
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

export const SteeringSystemFields = () => <SteerFields keys={SYSTEM} />;
export const TireForceFields = () => <SteerFields keys={FORCES} />;

/** Steering results: angles, ratio, and the forces back to the rack and steering wheel. */
export function SteeringReadout({ model }: { model: Model }) {
  const st = model.current?.steering;
  if (!st) return null;
  const l = st.loads;
  return (
    <FieldRows rows={[
      { label: 'Steering-wheel angle', value: fmt(st.steeringWheelAngle, 1), unit: '°' },
      { label: 'Road-wheel angle', value: fmt(deg(st.roadWheelAngle), 2), unit: '°', hint: '+ = front of wheel toward outboard (left turn for FL)' },
      { label: 'Steering ratio', value: fmt(st.ratio, 2), unit: ':1', hint: 'steering-wheel deg per road-wheel deg, at this position' },
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
