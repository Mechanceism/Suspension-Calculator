/**
 * Towing, static (docs/MATH.md § Towing): the forces a trailer puts on the car at the hitch while the car
 * corners, brakes or accelerates, from the trailer's own balance (it follows the car with the same
 * accelerations; no sway).
 *
 * Trailer: mass m_t, hitch to its axle L_t, static tongue share τ (its CG sits τ·L_t ahead of the axle),
 * CG height h_cg, hitch height h_h, trailer brakes taking a share β of its own braking.
 *   lateral  (on the car)   F_x = −m_t · a_y · τ                       (trailer pulls the hitch outward)
 *   longitudinal            F_trailer = m_t · a_x − (braking ? β · m_t · a_x : 0),   F_z = −F_trailer
 *   vertical (tongue load)  V = m_t · g · gs · τ + (h_h · F_trailer − h_cg · m_t · a_x) / L_t,   F_y = −V
 * (vehicle frame: x left, y up, z forward; a_x + = accelerating; gs = gravity share normal to the road).
 */
import { type Vec3, vec3 } from '../math/vec3';

const G = 9.80665;

export interface TrailerSpec {
  /** Trailer mass, kg. */
  mass: number;
  /** Static tongue weight as a share of the trailer's weight (0–1; ≈ 0.1–0.15 for a stable trailer). */
  tongueShare: number;
  /** Hitch ball height above the ground, mm. */
  hitchHeight: number;
  /** Hitch ball behind the rear axle, mm. */
  hitchBehindRear: number;
  /** Hitch ball to the trailer's axle, mm. */
  hitchToAxle: number;
  /** Trailer CG height above the ground, mm. */
  cgHeight: number;
  /** Share of the trailer's own braking its brakes make (0 = none: the trailer pushes the car). */
  brakeShare: number;
  /** Trailer's yaw radius of gyration about its CG, mm (sway; default 0.45 × hitch to axle). */
  yawRadius?: number;
}

/** Hitch position in the vehicle frame (mm) for a ground height and wheelbase. */
export const hitchPoint = (t: TrailerSpec, groundY: number, wheelbase: number): Vec3 =>
  vec3(0, groundY + t.hitchHeight, -wheelbase - t.hitchBehindRear);

/** Force of the trailer on the car at the hitch, N (lateralG + = left turn; longG + = accelerating). */
export function hitchForce(t: TrailerSpec, lateralG: number, longG: number, gravityScale = 1): Vec3 {
  const m = Math.max(0, t.mass), tau = Math.min(1, Math.max(0, t.tongueShare));
  const ax = longG * G, ay = lateralG * G;
  const Ft = m * ax - (ax < 0 ? Math.min(1, Math.max(0, t.brakeShare)) * m * ax : 0);
  const L = Math.max(t.hitchToAxle, 1);
  const V = m * G * gravityScale * tau + (t.hitchHeight * Ft - t.cgHeight * m * ax) / L;
  return vec3(-m * ay * tau, -V, -Ft);
}
