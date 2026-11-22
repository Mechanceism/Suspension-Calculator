/**
 * Brake hydraulics (docs/MATH.md § Brakes): the most braking force the brakes can make, from the pedal to
 * the tire, independent of grip.
 *
 *   pedal → master cylinder   F_mc = F_pedal · pedal ratio · booster gain · (balance-bar share, dual MC)
 *   line pressure             p = F_mc / A_mc                             (A_mc = π/4 · bore²)
 *   clamp → friction          F_friction = 2 · μ_pad · p · A_pistons      (A_pistons: one side's piston area;
 *                                                                          opposed or floating caliper: two pads)
 *   torque → tire force       T = F_friction · r_eff,   F_tire = T / r_tire   (per wheel)
 *
 * With one (tandem) master cylinder both circuits see the same pressure (balanceFront ignored); with two
 * master cylinders and a balance bar the pedal force splits balanceFront : (1 − balanceFront).
 */

export interface BrakeAxle {
  /** Master cylinder bore, mm. */
  mcBore: number;
  /** Caliper piston diameter (mm) and pistons per side. */
  pistonDiameter: number;
  pistonsPerSide: number;
  /** Pad friction coefficient. */
  padMu: number;
  /** Effective rotor radius (pad center), mm. */
  rotorRadius: number;
}

export interface BrakeSystem {
  /** Most pedal force the driver applies, N. */
  maxPedalForce: number;
  pedalRatio: number;
  /** Booster gain (1 = none). */
  boost: number;
  /** Two master cylinders on a balance bar (else one tandem master cylinder for both circuits). */
  dualMc: boolean;
  /** Balance bar: share of the pedal force to the front master cylinder (0–1). */
  balanceFront: number;
  front: BrakeAxle;
  rear: BrakeAxle;
}

export interface BrakeCapacity {
  /** Line pressure at the most pedal force, kPa. */
  pressure: { front: number; rear: number };
  /** Brake torque per wheel, N·m. */
  torque: { front: number; rear: number };
  /** Most braking force at the tires per axle (two wheels), N. */
  axleForce: { front: number; rear: number };
  /** Front share of the braking force the hydraulics give (the brake bias they set). */
  bias: number;
}

const area = (d: number) => (Math.PI / 4) * d * d;

/** What the brakes can make at the most pedal force (tire radii in mm, per axle). */
export function brakeCapacity(b: BrakeSystem, tireRadius: { front: number; rear: number }): BrakeCapacity {
  const pedal = Math.max(0, b.maxPedalForce) * Math.max(0, b.pedalRatio) * Math.max(0, b.boost);
  const share = b.dualMc ? { front: Math.min(1, Math.max(0, b.balanceFront)), rear: 1 - Math.min(1, Math.max(0, b.balanceFront)) } : { front: 1, rear: 1 };
  const axle = (a: BrakeAxle, s: number, rTire: number) => {
    const p = a.mcBore > 0 ? (pedal * s) / area(a.mcBore) : 0; // N/mm² = MPa
    const friction = 2 * a.padMu * p * area(a.pistonDiameter) * Math.max(0, a.pistonsPerSide); // N per caliper
    const torque = friction * a.rotorRadius; // N·mm
    return { pressure: p * 1000, torque: torque / 1000, force: rTire > 0 ? (2 * torque) / rTire : 0 };
  };
  const f = axle(b.front, share.front, tireRadius.front), r = axle(b.rear, share.rear, tireRadius.rear);
  return {
    pressure: { front: f.pressure, rear: r.pressure }, torque: { front: f.torque, rear: r.torque },
    axleForce: { front: f.force, rear: r.force }, bias: f.force + r.force > 0 ? f.force / (f.force + r.force) : NaN,
  };
}

/**
 * Pedal force a braking demand needs (N), from the axles' demands (N) and their capacity at the most pedal
 * force (everything is linear in the pedal force). > maxPedalForce = the brakes can't make it.
 */
export function pedalForceNeeded(demand: { front: number; rear: number }, cap: { front: number; rear: number }, maxPedal: number): number {
  const need = (d: number, c: number) => (d > 1e-9 ? (c > 0 ? (d / c) * maxPedal : Infinity) : 0);
  return Math.max(need(demand.front, cap.front), need(demand.rear, cap.rear));
}
