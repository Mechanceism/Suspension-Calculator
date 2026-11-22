/**
 * Derived suspension variables (docs/MATH.md § L2, more variables): Ackermann, roll camber, roll stiffness.
 */

/**
 * Roll camber: the outside wheel's camber change relative to the ground per degree of body roll (deg/deg).
 * Rolling by φ moves the outside wheel into bump by ≈ φ · half track and tilts it with the body by φ:
 *   Δγ_ground / Δφ = 1 + (dγ/dz) · half track        (dγ/dz in rad per mm, camber + = top outboard)
 * 1 = the wheel leans fully with the body (no camber gain), 0 = it stays upright to the ground (as a solid
 * axle), negative = it leans into the turn.
 */
export function rollCamber(camberGainDegPerMm: number, halfTrack: number): number {
  return 1 + camberGainDegPerMm * (Math.PI / 180) * halfTrack;
}

export interface Ackermann {
  /** Inside and outside road-wheel angles of the turn, rad (magnitudes). */
  inside: number;
  outside: number;
  /** Inside angle the ideal (Ackermann) geometry would give for this outside angle, rad. */
  ideal: number;
  /**
   * Ackermann %: (inside − outside) / (ideal inside − outside) × 100. 100 = ideal Ackermann, 0 = parallel
   * steer, negative = anti-Ackermann (the outside wheel turns more).
   */
  percent: number;
}

/**
 * Ackermann from the two front wheels' angles (rad, + = front of the wheel toward the left), the wheelbase
 * and the steering track (distance between the steering axes at the ground), mm. The turn's direction
 * comes from the mean angle. Ideal: cot δ_o − cot δ_i = track / wheelbase.
 */
export function ackermann(left: number, right: number, wheelbase: number, track: number): Ackermann {
  const turnLeft = left + right > 0;
  const inside = Math.abs(turnLeft ? left : right), outside = Math.abs(turnLeft ? right : left);
  const den = wheelbase / Math.tan(outside) - track;
  const ideal = outside > 1e-6 && den > 0 ? Math.atan(wheelbase / den) : NaN;
  const percent = Number.isFinite(ideal) && Math.abs(ideal - outside) > 1e-9 ? (100 * (inside - outside)) / (ideal - outside) : NaN;
  return { inside, outside, ideal, percent };
}

/**
 * An axle's roll stiffness from a solved cornering state: the load moved through its springs (body roll
 * part, N) times its track (mm) per degree of body roll → N·m/deg. Springs, anti-roll bar and heave springs
 * all count; the roll-center (link) part doesn't roll the body.
 */
export function rollStiffness(elasticTransfer: number, track: number, rollDeg: number): number {
  return Math.abs(rollDeg) > 1e-6 ? Math.abs((elasticTransfer * track) / 1000 / rollDeg) : NaN;
}

/**
 * Classic Ackermann check (top view): the line from each front steering axis through its steering arm's
 * outer (tie-rod) joint. With 100 % Ackermann near straight ahead the two lines meet on the rear axle's
 * centerline. Points are (x, z) in the vehicle frame (x left, z forward). Returns where they cross, or null
 * when they are parallel (parallel steer).
 */
export function ackermannLinesCross(
  kL: { x: number; z: number }, tL: { x: number; z: number }, kR: { x: number; z: number }, tR: { x: number; z: number },
): { x: number; z: number } | null {
  const d1 = { x: tL.x - kL.x, z: tL.z - kL.z }, d2 = { x: tR.x - kR.x, z: tR.z - kR.z };
  const den = d1.x * d2.z - d1.z * d2.x;
  if (Math.abs(den) < 1e-9 * Math.hypot(d1.x, d1.z) * Math.hypot(d2.x, d2.z)) return null;
  const t = ((kR.x - kL.x) * d2.z - (kR.z - kL.z) * d2.x) / den;
  return { x: kL.x + t * d1.x, z: kL.z + t * d1.z };
}
