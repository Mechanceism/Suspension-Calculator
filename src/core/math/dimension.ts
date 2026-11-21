/**
 * Driving dimensions between two points (Measure → set): distance, ΔX/ΔY/ΔZ and view angles.
 * Each returns the new position of the point that moves; the other stays fixed.
 *
 * View angles of the line A → B (degrees), measured from the horizontal in that view:
 *   front (XY plane, looking along Z):  atan2(ΔY, |ΔX|)
 *   side  (ZY plane, looking along X):  atan2(ΔY, |ΔZ|)
 *   top   (XZ plane, looking down Y):   atan2(ΔZ, |ΔX|)
 *   slope (3D, from the horizontal plane): atan2(ΔY, √(ΔX² + ΔZ²))
 * Setting a view angle keeps the line's length in that view and the coordinate out of that view.
 */
import { add, length, normalize, scale, sub, vec3, type Vec3 } from './vec3';

export type ViewAngle = 'front' | 'side' | 'top' | 'slope';
export type Mover = 'a' | 'b';

const DEG = Math.PI / 180;

export function viewAngle(a: Vec3, b: Vec3, view: ViewAngle): number {
  const d = sub(b, a);
  switch (view) {
    case 'front': return Math.atan2(d.y, Math.abs(d.x)) / DEG;
    case 'side': return Math.atan2(d.y, Math.abs(d.z)) / DEG;
    case 'top': return Math.atan2(d.z, Math.abs(d.x)) / DEG;
    case 'slope': return Math.atan2(d.y, Math.hypot(d.x, d.z)) / DEG;
  }
}

/** Place the moving point so that B − A = d. */
const place = (a: Vec3, b: Vec3, d: Vec3, move: Mover): Vec3 => (move === 'b' ? add(a, d) : sub(b, d));

/** Set |B − A| = L along the current line. null when the points coincide (no direction). */
export function withDistance(a: Vec3, b: Vec3, L: number, move: Mover): Vec3 | null {
  const d = sub(b, a);
  if (length(d) < 1e-9) return null;
  return place(a, b, scale(normalize(d), L), move);
}

/** Set one component of B − A. */
export function withDelta(a: Vec3, b: Vec3, axis: 0 | 1 | 2, value: number, move: Mover): Vec3 {
  const d = sub(b, a);
  const n = vec3(axis === 0 ? value : d.x, axis === 1 ? value : d.y, axis === 2 ? value : d.z);
  return place(a, b, n, move);
}

/** Set a view angle (degrees), keeping the in-view length and the out-of-view coordinate. */
export function withViewAngle(a: Vec3, b: Vec3, view: ViewAngle, angleDeg: number, move: Mover): Vec3 {
  const d = sub(b, a);
  const t = angleDeg * DEG;
  const sgn = (v: number) => (v < 0 ? -1 : 1);
  let n: Vec3;
  switch (view) {
    case 'front': { const r = Math.hypot(d.x, d.y); n = vec3(sgn(d.x) * r * Math.cos(t), r * Math.sin(t), d.z); break; }
    case 'side': { const r = Math.hypot(d.z, d.y); n = vec3(d.x, r * Math.sin(t), sgn(d.z) * r * Math.cos(t)); break; }
    case 'top': { const r = Math.hypot(d.x, d.z); n = vec3(sgn(d.x) * r * Math.cos(t), d.y, r * Math.sin(t)); break; }
    case 'slope': {
      const L = length(d);
      const h = Math.hypot(d.x, d.z);
      const ux = h > 1e-9 ? d.x / h : 1, uz = h > 1e-9 ? d.z / h : 0;
      n = vec3(ux * L * Math.cos(t), L * Math.sin(t), uz * L * Math.cos(t));
      break;
    }
  }
  return place(a, b, n, move);
}

/** Move point p by `distance` along the line from p toward `toward` (negative = away). */
export function alongLine(p: Vec3, toward: Vec3, distance: number): Vec3 | null {
  const d = sub(toward, p);
  if (length(d) < 1e-9) return null;
  return add(p, scale(normalize(d), distance));
}
