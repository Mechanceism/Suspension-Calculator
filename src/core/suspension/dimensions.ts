/**
 * Held dimensions: distances, ΔX/ΔY/ΔZ or view angles between two hardpoints that the user has fixed,
 * like dimensions in a CAD sketch. Each is held either at a travel position (0 = static ride
 * height) or permanently (a part dimension: only meaningful when it can't change through travel,
 * e.g. a distance between two points of the same rigid part).
 *
 * resolveDimensions moves the free coordinates as little as possible so every held dimension is met
 * after an edit (the edited coordinates and locked coordinates stay put).
 */
import { vec3, type Vec3 } from '../math/vec3';
import { viewAngle, type ViewAngle } from '../math/dimension';
import { DoubleWishbone, type DoubleWishboneGeometry } from './doubleWishbone';
import { boundedLeastSquares } from '../optimize/leastSquares';
import { getPoint, withVariables, type HardpointId, type Variable } from '../optimize/corner';

export type DimMeasure = 'distance' | 'dx' | 'dy' | 'dz' | ViewAngle;
export const DIM_MEASURES: DimMeasure[] = ['distance', 'dx', 'dy', 'dz', 'front', 'side', 'top', 'slope'];
export const isAngleMeasure = (m: DimMeasure) => m === 'front' || m === 'side' || m === 'top' || m === 'slope';

export interface DimensionSpec {
  a: HardpointId;
  b: HardpointId;
  measure: DimMeasure;
  /** mm or degrees. */
  value: number;
  /** Travel (mm, wheel center) where it is held; null = permanent (held in the design itself). */
  travel: number | null;
}

export function measureValue(a: Vec3, b: Vec3, m: DimMeasure): number {
  switch (m) {
    case 'distance': return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    case 'dx': return b.x - a.x;
    case 'dy': return b.y - a.y;
    case 'dz': return b.z - a.z;
    default: return viewAngle(a, b, m);
  }
}

/** Positions of every hardpoint at a travel (design positions at 0 / permanent). */
function pointsAt(g: DoubleWishboneGeometry, travel: number | null): ((id: HardpointId) => Vec3 | undefined) | null {
  if (!travel) return (id) => getPoint(g, id);
  let s;
  try { s = new DoubleWishbone(g).solve({ travel }); } catch { return null; }
  if (s.solve.status !== 'converged') return null;
  const p = s.points;
  return (id) => (id === 'damperChassis' ? p.damperChassis : id === 'damperArm' ? p.damperArm : (p as unknown as Record<string, Vec3>)[id]);
}

/** Current value of a held dimension for this geometry (null = can't be evaluated). */
export function dimensionValue(g: DoubleWishboneGeometry, d: DimensionSpec): number | null {
  const at = pointsAt(g, d.travel);
  const a = at?.(d.a), b = at?.(d.b);
  return a && b ? measureValue(a, b, d.measure) : null;
}

/** Tolerance of a held dimension (what counts as "met"). */
export const dimensionTolerance = (d: DimensionSpec) => (isAngleMeasure(d.measure) ? 0.01 : 0.01);

export interface ResolveResult {
  geometry: DoubleWishboneGeometry;
  /** Coordinates that moved, with new values. */
  moved: { point: HardpointId; axis: 0 | 1 | 2; value: number }[];
  /** Indices of dimensions still not met. */
  violated: number[];
}

/**
 * Meet every held dimension by moving the free coordinates of the points involved as little as
 * possible. `fixed` (just edited) and `locked` coordinates don't move.
 */
export function resolveDimensions(
  g: DoubleWishboneGeometry, dims: DimensionSpec[], isFixed: (p: HardpointId, axis: 0 | 1 | 2) => boolean,
): ResolveResult {
  const check = (geom: DoubleWishboneGeometry) => dims
    .map((d, i) => { const v = dimensionValue(geom, d); return v === null || Math.abs(v - d.value) > dimensionTolerance(d) ? i : -1; })
    .filter((i) => i >= 0);
  const violatedBefore = check(g);
  if (!violatedBefore.length) return { geometry: g, moved: [], violated: [] };

  const vars: Variable[] = [];
  const seen = new Set<string>();
  for (const d of dims) {
    for (const p of [d.a, d.b]) {
      for (const axis of [0, 1, 2] as const) {
        const k = `${p}.${axis}`;
        if (seen.has(k) || isFixed(p, axis)) continue;
        seen.add(k);
        const v = getPoint(g, p);
        if (!v) continue;
        const x = [v.x, v.y, v.z][axis]!;
        vars.push({ point: p, axis, lo: x - 1000, hi: x + 1000 });
      }
    }
  }
  if (!vars.length) return { geometry: g, moved: [], violated: violatedBefore };
  const x0 = vars.map((v) => { const p = getPoint(g, v.point)!; return [p.x, p.y, p.z][v.axis]!; });
  const residuals = (x: number[]) => {
    const geom = withVariables(g, vars, x);
    const r: number[] = [];
    for (const d of dims) {
      const v = dimensionValue(geom, d);
      if (v === null) return null;
      r.push((v - d.value) / (dimensionTolerance(d) * 0.01));
    }
    // Move as little as possible (also picks one answer when the dimensions leave freedom).
    x.forEach((v, i) => r.push((v - x0[i]!) * 1e-3));
    return r;
  };
  const lsq = boundedLeastSquares(residuals, x0, vars.map((v) => v.lo), vars.map((v) => v.hi), { maxIterations: 80, step: 1e-4, relTol: 1e-12, xTol: 1e-9 });
  const geometry = withVariables(g, vars, lsq.x);
  const moved = vars.map((v, i) => ({ point: v.point, axis: v.axis, value: lsq.x[i]! })).filter((m, i) => Math.abs(m.value - x0[i]!) > 1e-7);
  return { geometry, moved, violated: check(geometry) };
}

export const pointOf = (g: DoubleWishboneGeometry, id: HardpointId): Vec3 => getPoint(g, id) ?? vec3(NaN, NaN, NaN);
