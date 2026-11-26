/**
 * What a planned test asks of the powertrain (round 4, F7), segment by segment and over the whole test:
 * walking each segment's planned speeds (constant acceleration per step), the drive force it needs
 * F = m a + ½ ρ C_d A v² + m g (sin grade + C_rr) where that is a push, and from it
 *  - the wheel torque (F · r, all driven wheels together) and wheel power (F · v),
 *  - with a powertrain: the motor / engine rpm and the torque it uses (F · r ÷ (ratio · η)),
 *  - where the car accelerates flat out, what limits it: the powertrain or the tires (time in each),
 *  - the power the motor would need for the tires to be the limit everywhere it accelerated flat out, at the
 *    speeds it drove: max (the tires' push at the driver's push · v) ÷ η.
 */
import { G, type SegmentSpec, gradeAlong } from './segments';
import { combinedLimit, type PlanCar, type SegmentPlan } from './plan';
import { wheelDrive, type Powertrain } from '../vehicle/powertrain';

export interface PowerUse {
  /** Time and distance covered, s and m. */
  time: number;
  distance: number;
  /** Most wheel torque (N·m, all driven wheels together) and wheel power (kW) it asked for. */
  wheelTorque: number;
  wheelPower: number;
  /** With a powertrain: the most motor / engine rpm and the most torque it used (N·m), and its most power (kW). */
  rpm?: number;
  motorTorque?: number;
  motorPower?: number;
  /** Accelerating flat out: the time the powertrain was the limit, and the time the tires were (s). */
  powerLimited: number;
  gripLimited: number;
  /** Power at the motor (kW) for the tires to be the limit everywhere it accelerated flat out, at the speeds driven. */
  powerNeeded: number;
}

const empty = (): PowerUse => ({ time: 0, distance: 0, wheelTorque: 0, wheelPower: 0, powerLimited: 0, gripLimited: 0, powerNeeded: 0 });

const kappaOf = (sg: SegmentSpec) => (sg.path === 'straight' || (sg.latG !== null && sg.latG !== undefined && Number.isFinite(sg.latG)) ? 0 : (sg.path === 'left' ? 1 : -1) / Math.max(sg.radius, 0.1));

/**
 * `targets`: each segment's grip target (the driver's push) as planned; `radius`: the driven wheels' loaded
 * radius (m); `pt`: the powertrain (none: only the tires limit the drive).
 */
export function powerUse(plans: SegmentPlan[], segments: SegmentSpec[], car: PlanCar, targets: number[], radius: number, pt?: Powertrain): { segments: PowerUse[]; total: PowerUse } {
  const m = Math.max(car.mass, 1e-6), crr = car.rollingResistance ?? 0, dragA = Math.max(0, car.dragArea ?? 0);
  const eff = pt ? Math.min(1, Math.max(1e-3, pt.efficiency)) : 1;
  const out = segments.map((sg, i) => {
    const u = empty();
    const pl = plans[i];
    if (!pl || pl.s.length < 2) return u;
    const kappa = kappaOf(sg), t = targets[i] ?? 0.95;
    for (let k = 1; k < pl.s.length; k++) {
      const ds = pl.s[k]! - pl.s[k - 1]!, v0 = pl.v[k - 1]!, v1 = pl.v[k]!;
      if (!(ds > 0)) continue;
      const dt = (2 * ds) / Math.max(v0 + v1, 0.1);
      u.time += dt; u.distance += ds;
      // The planner sets each step's acceleration from the speed it starts at: judged there too.
      const a = (v1 * v1 - v0 * v0) / (2 * ds), v = v0;
      const F = m * a + dragA * v * v + m * G * (Math.sin(gradeAlong(sg, pl.s[k - 1]!)) + crr);
      if (F <= 1e-6) continue; // coasting or braking
      u.wheelTorque = Math.max(u.wheelTorque, F * radius);
      u.wheelPower = Math.max(u.wheelPower, (F * v) / 1000);
      const ay = (v * v * Math.abs(kappa)) / G;
      const tires = m * G * combinedLimit(car, t, ay, 'drive', kappa);
      const d = pt ? wheelDrive(pt, v, radius) : null;
      if (d && pt) {
        u.rpm = Math.max(u.rpm ?? 0, d.rpm);
        const used = (F * radius) / (pt.ratio * eff);
        u.motorTorque = Math.max(u.motorTorque ?? 0, used);
        u.motorPower = Math.max(u.motorPower ?? 0, (used * d.rpm * 2 * Math.PI) / 60 / 1000);
      }
      // Flat out: the push is at what the tires or the powertrain allow (the planner takes the lower).
      const limit = d ? Math.min(tires, d.force) : tires;
      if (F >= 0.98 * limit) {
        if (d && d.force < tires) u.powerLimited += dt; else u.gripLimited += dt;
        u.powerNeeded = Math.max(u.powerNeeded, (tires * v) / eff / 1000);
      }
    }
    return u;
  });
  const total = out.reduce((T, u) => ({
    time: T.time + u.time, distance: T.distance + u.distance,
    wheelTorque: Math.max(T.wheelTorque, u.wheelTorque), wheelPower: Math.max(T.wheelPower, u.wheelPower),
    ...(pt ? { rpm: Math.max(T.rpm ?? 0, u.rpm ?? 0), motorTorque: Math.max(T.motorTorque ?? 0, u.motorTorque ?? 0), motorPower: Math.max(T.motorPower ?? 0, u.motorPower ?? 0) } : {}),
    powerLimited: T.powerLimited + u.powerLimited, gripLimited: T.gripLimited + u.gripLimited,
    powerNeeded: Math.max(T.powerNeeded, u.powerNeeded),
  }), empty());
  return { segments: out, total };
}
