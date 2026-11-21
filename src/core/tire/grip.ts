/**
 * Contact-patch grip (L7): pressure distribution over the patch and load-sensitive rubber friction.
 *
 * Pressure. The air carries load uniformly (gauge pressure over the patch); the carcass and belt
 * carry load where the tire is pushed in most. A share β of the load follows the local deflection
 * δ (how far the undeformed tire would sink below the ground at that point, a Winkler foundation),
 * the rest is spread evenly:
 *
 *   p(x) = (1 − β)·Fz / A  +  β·Fz·δ(x) / ∫δ dA
 *
 * A level wheel gives a fairly even pressure; an inclined wheel gives a wedge of δ, so one shoulder
 * carries much more pressure than the other.
 *
 * Friction. Rubber friction falls as contact pressure rises (load sensitivity):
 *
 *   μ(p) = μ_ref · (p / p_ref)^(−n)        friction capacity  F = ∫ μ(p)·p dA
 *
 * Because p^(1−n) is concave, for a given load F is highest when the pressure is even and the area
 * large. So "largest contact area, then highest friction" falls out of one number. This is a
 * placeholder model until real tire data is available: μ_ref, p_ref, n and β are user inputs.
 * It does not include camber thrust (most tires peak at slightly negative inclination); use the
 * inclination goal for that.
 */
import { add, dot, normalize, scale, type Vec3 } from '../math/vec3';
import { localPatch, sliceRadius, type Ground, type TireProfile } from './geometry';

export interface GripModel {
  /** Friction coefficient at the reference pressure. */
  muRef: number;
  /** Reference contact pressure, kPa. */
  pRef: number;
  /** Load-sensitivity exponent n (0 = none; rubber is typically 0.1–0.3). */
  sensitivity: number;
  /** Share of the load carried in proportion to local deflection (0 = even pressure, 1 = all). */
  carcassShare: number;
}

export const DEFAULT_GRIP: GripModel = { muRef: 1.0, pRef: 100, sensitivity: 0.2, carcassShare: 0.5 };

export interface PatchGrip {
  /** Contact area, mm². */
  area: number;
  /** Friction capacity (largest horizontal force the patch can carry), N. */
  capacity: number;
  /** Effective friction coefficient = capacity / load. */
  mu: number;
  /** Mean and peak contact pressure, kPa. */
  pMean: number;
  pMax: number;
  /** Pressure-weighted center across the tread (+ outboard), mm from the tire center plane. */
  pressureCenterS: number;
}

const NONE: PatchGrip = { area: 0, capacity: 0, mu: 0, pMean: 0, pMax: 0, pressureCenterS: 0 };

/**
 * Grip of a tire carrying `load` (N) with its center at `center` and outboard spin axis `spinAxis`,
 * against `ground`. The geometry sets the patch shape; the load scales the pressures.
 */
export function patchGrip(center: Vec3, spinAxis: Vec3, ground: Ground, p: TireProfile, load: number, m: GripModel, nS = 32, nT = 12): PatchGrip {
  if (!(load > 0)) return NONE;
  const a = normalize(spinAxis);
  const n = normalize(ground.normal);
  const sinG = dot(n, a);
  const cosG = Math.sqrt(Math.max(1e-12, 1 - sinG * sinG));
  const h0 = dot(n, add(center, scale(ground.point, -1)));
  const local = localPatch(p, h0, sinG);
  if (!local.inContact) return NONE;

  // Samples over the patch: slice s across the tread, position v along the chord.
  const ds = (local.sMax - local.sMin) / nS;
  const w: number[] = [], delta: number[] = [], sPos: number[] = [];
  for (let i = 0; i < nS; i++) {
    const s = local.sMin + (i + 0.5) * ds;
    const R = sliceRadius(p, s);
    const d = (h0 + s * sinG) / cosG;
    if (!(R > d)) continue;
    const half = Math.sqrt(R * R - d * d);
    for (let j = 0; j < nT; j++) {
      const v = -half + ((j + 0.5) * 2 * half) / nT;
      w.push(((2 * half) / nT) * ds / cosG);
      // Depth of the undeformed surface below the ground at this point (along the ground normal).
      delta.push(Math.max(0, (Math.sqrt(Math.max(0, R * R - v * v)) - d) * cosG));
      sPos.push(s);
    }
  }
  const area = w.reduce((x, y) => x + y, 0);
  if (!(area > 0)) return NONE;
  const dA = delta.reduce((acc, dd, i) => acc + dd * w[i]!, 0);
  const beta = dA > 0 ? Math.min(1, Math.max(0, m.carcassShare)) : 0;
  let capacity = 0, pMax = 0, ps = 0;
  const pRef = m.pRef / 1000; // kPa → N/mm²
  for (let i = 0; i < w.length; i++) {
    const pr = (1 - beta) * (load / area) + (beta > 0 ? (beta * load * delta[i]!) / dA : 0); // N/mm²
    if (pr <= 0) continue;
    capacity += m.muRef * Math.pow(pr / pRef, -m.sensitivity) * pr * w[i]!;
    pMax = Math.max(pMax, pr);
    ps += pr * w[i]! * sPos[i]!;
  }
  return { area, capacity, mu: capacity / load, pMean: (load / area) * 1000, pMax: pMax * 1000, pressureCenterS: ps / load };
}
