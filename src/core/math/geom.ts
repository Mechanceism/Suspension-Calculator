/**
 * Lines, planes and intersections (L0).
 */
import {
  type Vec3, add, sub, scale, dot, cross, length, lengthSq, normalize, addScaled,
} from './vec3';
import { fromAxisAngle, mulVec } from './mat3';

export interface Line {
  readonly point: Vec3;
  /** Unit direction. */
  readonly dir: Vec3;
}

export interface Plane {
  readonly point: Vec3;
  /** Unit normal. */
  readonly normal: Vec3;
}

const EPS = 1e-12;

export const lineThrough = (a: Vec3, b: Vec3): Line => ({ point: a, dir: normalize(sub(b, a)) });

export const plane = (point: Vec3, normal: Vec3): Plane => ({ point, normal: normalize(normal) });

/** Plane through three points, or null if they are (nearly) collinear. */
export function planeFromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const n = cross(sub(b, a), sub(c, a));
  const scaleRef = Math.max(lengthSq(sub(b, a)), lengthSq(sub(c, a)));
  if (length(n) < 1e-9 * scaleRef) return null;
  return { point: a, normal: normalize(n) };
}

/** Intersection line of two planes, or null if they are (nearly) parallel. */
export function intersectPlanes(p1: Plane, p2: Plane): Line | null {
  const dir = cross(p1.normal, p2.normal);
  const s = lengthSq(dir); // = 1 − c² for unit normals
  if (s < 1e-14) return null;
  const c = dot(p1.normal, p2.normal);
  const d1 = dot(p1.normal, p1.point);
  const d2 = dot(p2.normal, p2.point);
  const point = add(scale(p1.normal, (d1 - d2 * c) / s), scale(p2.normal, (d2 - d1 * c) / s));
  return { point, dir: normalize(dir) };
}

/** Intersection of a line and a plane, or null if the line is parallel to the plane. */
export function intersectLinePlane(line: Line, pl: Plane): Vec3 | null {
  const denom = dot(pl.normal, line.dir);
  if (Math.abs(denom) < EPS) return null;
  const t = dot(pl.normal, sub(pl.point, line.point)) / denom;
  return addScaled(line.point, line.dir, t);
}

/** Point on `line` whose coordinate along unit `axis` equals `value` (e.g. where it meets y = const). */
export function pointOnLineAt(line: Line, axis: Vec3, value: number): Vec3 | null {
  return intersectLinePlane(line, { point: scale(axis, value), normal: axis });
}

export function closestPointOnLine(line: Line, p: Vec3): Vec3 {
  return addScaled(line.point, line.dir, dot(sub(p, line.point), line.dir));
}

export const distancePointToLine = (line: Line, p: Vec3): number => length(sub(p, closestPointOnLine(line, p)));

/**
 * Rotate point `p` by `angle` (radians) about the axis through `axisPoint` along unit `axisDir`
 * (Rodrigues' rotation, the same method used in the hand math for steering).
 */
export function rotatePointAboutAxis(p: Vec3, axisPoint: Vec3, axisDir: Vec3, angle: number): Vec3 {
  return add(axisPoint, mulVec(fromAxisAngle(axisDir, angle), sub(p, axisPoint)));
}
