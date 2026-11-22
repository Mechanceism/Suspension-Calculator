/**
 * Measurement helpers for the setup wizard (docs/MATH.md § Setup wizard): values a user can measure in a
 * garage, turned into model inputs.
 */

export const G = 9.80665;

export interface CornerKg { FL: number; FR: number; RL: number; RR: number }

export interface CgResult {
  /** Total mass, kg. */
  mass: number;
  /** CG lateral position, mm (+ = left of the centerline). */
  x: number;
  /** CG longitudinal position from the front axle, mm (negative = behind it). */
  z: number;
  /** CG height above the ground, mm (null without the lifted weighing). */
  height: number | null;
  /** Front and left weight shares, 0–1. */
  front: number;
  left: number;
}

/**
 * CG from corner scales. Level: the four corner weights give the mass, the front / rear split (so the
 * CG's distance behind the front axle) and the left / right split (with the track widths).
 * Lifted: raise one axle by `height` (mm, measured at its wheel centers) and weigh the other axle again;
 * the CG height follows from the load moved onto it:
 *   h = r + L·ΔW / (W·tan θ),   sin θ = lift ÷ L,   r = wheel-center height (loaded radius)
 * (ΔW = how much heavier the axle on the ground got; the suspension must be locked, e.g. dampers / springs
 * replaced by rigid links, or the body rolls back and the height comes out low).
 */
export function cgFromScales(
  level: CornerKg, wheelbase: number, trackFront: number, trackRear: number,
  lifted?: { axle: 'front' | 'rear'; height: number; groundAxleKg: number; wheelCenterHeight: number },
): CgResult | null {
  const mass = level.FL + level.FR + level.RL + level.RR;
  if (!(mass > 0) || !(wheelbase > 0)) return null;
  const front = (level.FL + level.FR) / mass;
  const left = (level.FL + level.RL) / mass;
  const z = -(1 - front) * wheelbase;
  const x = ((level.FL - level.FR) * trackFront / 2 + (level.RL - level.RR) * trackRear / 2) / mass;
  let height: number | null = null;
  if (lifted && lifted.height > 0 && lifted.height < wheelbase) {
    // The axle staying on the ground carries more when the other is raised.
    const before = lifted.axle === 'front' ? level.RL + level.RR : level.FL + level.FR;
    const dW = lifted.groundAxleKg - before;
    const theta = Math.asin(lifted.height / wheelbase);
    height = lifted.wheelCenterHeight + (wheelbase * dW) / (mass * Math.tan(theta));
  }
  return { mass, x, z, height, front, left };
}

export interface SpringFromWeight {
  /** Ride rate at the corner (body drop per added load), N/mm. */
  rideRate: number;
  /** Wheel rate (the tire's own give taken out), N/mm. */
  wheelRate: number;
  /** Spring rate at the spring (wheel rate ÷ motion ratio²), N/mm. */
  springRate: number;
}

/**
 * Spring rate from adding a known weight over one wheel of the parked car and measuring how much that
 * corner of the body drops. The body drop includes the tire squashing (springs in series):
 *   k_ride = m·g ÷ Δh,   1/k_wheel = 1/k_ride − 1/k_tire,   k_spring = k_wheel ÷ MR²
 * (MR = spring travel per wheel travel). Approximate: the rest of the car shares a little of the load
 * (anti-roll bar, the body tilting), so measure the drop right at that wheel and use a load of about a
 * quarter of the corner weight or more.
 */
export function springFromWeight(addedKg: number, dropMm: number, motionRatio: number, tireRate?: number): SpringFromWeight | null {
  if (!(addedKg > 0) || !(dropMm > 0) || !(motionRatio > 0)) return null;
  const rideRate = (addedKg * G) / dropMm;
  const wheelRate = tireRate && tireRate > rideRate ? 1 / (1 / rideRate - 1 / tireRate) : rideRate;
  return { rideRate, wheelRate, springRate: wheelRate / (motionRatio * motionRatio) };
}

export interface UnsprungParts {
  wheelTire: number;
  hubUpright: number;
  brake: number;
  /** Parts joining the body and the wheel: about half of each moves with the wheel. */
  arms: number;
  springDamper: number;
  halfshaft: number;
  other: number;
}

/** Unsprung mass of one corner, kg: the wheel-end parts plus half of the parts that join the body. */
export const unsprungFromParts = (p: UnsprungParts) =>
  p.wheelTire + p.hubUpright + p.brake + p.other + 0.5 * (p.arms + p.springDamper + p.halfshaft);

/**
 * Body inertias about the sprung CG, kg·m², from the size of the car: radius of gyration ≈ 0.35 × the
 * average track (roll) and ≈ 0.4 × the wheelbase (pitch). Rough: enough to start the ride model.
 */
export function estimateInertia(sprungMass: number, trackAvg: number, wheelbase: number, totalMass = sprungMass) {
  const kr = 0.35 * (trackAvg / 1000), kp = 0.4 * (wheelbase / 1000), ky = 0.45 * (wheelbase / 1000);
  return { roll: sprungMass * kr * kr, pitch: sprungMass * kp * kp, yaw: totalMass * ky * ky };
}
