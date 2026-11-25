/**
 * Powertrain (round 4, F5): what the motor or engine can push the car with at each speed, through one gear.
 *
 * - **Electric**: full torque from standstill up to the speed where it reaches its peak power, then constant
 *   power, up to its most rpm (no clutch: one gear is how most electric cars are built).
 * - **Gas** (simple curve): torque rises from idle to its peak at `torqueRpm`, falls to the torque that gives the
 *   peak power at `powerRpm`, and the power eases to 95 % of its peak at the redline (`maxRpm`), where the
 *   limiter cuts it. Below `clutchRpm` the clutch slips (a centrifugal clutch, as on a kart): the engine is held
 *   there and its torque at that speed reaches the wheels.
 *
 * Force at the driven wheels = torque · ratio · efficiency ÷ loaded radius. Gears and shift points come later.
 */

export type PowertrainKind = 'electric' | 'gas';

export interface Powertrain {
  kind: PowertrainKind;
  /** Peak torque at the motor / crank, N·m, and peak power, kW. */
  peakTorque: number;
  peakPower: number;
  /** Electric: the motor's most rpm; gas: the redline (limiter). */
  maxRpm: number;
  /** Gas: rpm of the peak torque and of the peak power, idle, and where the clutch stops slipping. */
  torqueRpm?: number;
  powerRpm?: number;
  idleRpm?: number;
  clutchRpm?: number;
  /** Overall reduction, motor / crank to wheel (one gear). */
  ratio: number;
  /** Drivetrain efficiency, 0–1. */
  efficiency: number;
}

const W = (rpm: number) => (rpm * 2 * Math.PI) / 60;

/** Torque at the motor / crank at this rpm, N·m (0 past the most rpm). */
export function motorTorque(pt: Powertrain, rpm: number): number {
  const T = Math.max(0, pt.peakTorque), P = Math.max(0, pt.peakPower) * 1000;
  const max = Math.max(1, pt.maxRpm);
  if (rpm > max) return 0;
  if (pt.kind === 'electric') return rpm <= 1e-9 ? T : Math.min(T, P / W(rpm));
  const idle = Math.max(0, Math.min(pt.idleRpm ?? 0.15 * max, max));
  const tq = Math.max(idle + 1, Math.min(pt.torqueRpm ?? 0.6 * max, max));
  const pw = Math.max(tq, Math.min(pt.powerRpm ?? 0.9 * max, max));
  // The torque that gives the peak power at its rpm (never above the peak torque), and at the redline 95 % of it.
  const Tp = Math.min(T, P / W(pw));
  const Tr = Math.min(Tp, (0.95 * P) / W(max));
  const r = Math.max(rpm, idle);
  if (r <= tq) {
    const u = (r - idle) / (tq - idle);
    return T * (0.7 + 0.3 * Math.sin((u * Math.PI) / 2)); // 70 % at idle, easing up to the peak
  }
  if (r <= pw) return T + ((Tp - T) * (r - tq)) / Math.max(pw - tq, 1e-9);
  return Tp + ((Tr - Tp) * (r - pw)) / Math.max(max - pw, 1e-9);
}

export interface WheelDrive {
  /** Most force the powertrain pushes the car with, N (at the driven wheels' contact patches). */
  force: number;
  /** Motor / engine rpm and its torque, N·m. */
  rpm: number;
  torque: number;
  /** Power it makes, kW. */
  power: number;
  /** Gas: the clutch is slipping (the engine held at the clutch rpm). */
  clutchSlip: boolean;
  /** Past the most rpm: the limiter (no push). */
  limited: boolean;
}

/** What the powertrain gives at a road speed `v` (m/s) on wheels of loaded radius `radius` (m). */
export function wheelDrive(pt: Powertrain, v: number, radius: number): WheelDrive {
  const r = Math.max(radius, 0.05);
  const wheelRpm = (Math.max(0, v) / r) * (60 / (2 * Math.PI));
  let rpm = wheelRpm * Math.max(pt.ratio, 1e-6);
  let clutchSlip = false;
  if (pt.kind === 'gas') {
    const clutch = Math.max(pt.clutchRpm ?? 0, pt.idleRpm ?? 0);
    if (rpm < clutch) { rpm = clutch; clutchSlip = true; }
  }
  const limited = rpm > pt.maxRpm;
  const torque = motorTorque(pt, rpm);
  const eff = Math.min(1, Math.max(0, pt.efficiency));
  return { force: (torque * pt.ratio * eff) / r, rpm, torque, power: (torque * W(rpm)) / 1000, clutchSlip, limited };
}

/** The road speed at the most rpm (m/s): the top speed the gearing allows. */
export const rpmTopSpeed = (pt: Powertrain, radius: number) => (Math.max(1, pt.maxRpm) / Math.max(pt.ratio, 1e-6)) * ((2 * Math.PI) / 60) * Math.max(radius, 0.05);

/**
 * Top speed on the level: where the push equals the drag (½ ρ CdA v², `dragArea` = ½ ρ CdA) and rolling
 * resistance (`rolling`, N), or the most rpm — whichever comes first (m/s).
 */
export function topSpeed(pt: Powertrain, radius: number, dragArea: number, rolling: number): { v: number; by: 'rpm' | 'drag' } {
  const vr = rpmTopSpeed(pt, radius);
  const net = (v: number) => wheelDrive(pt, v, radius).force - dragArea * v * v - rolling;
  if (net(vr * 0.999) > 0) return { v: vr, by: 'rpm' };
  let lo = 0, hi = vr * 0.999;
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (net(m) > 0) lo = m; else hi = m; }
  return { v: lo, by: 'drag' };
}
