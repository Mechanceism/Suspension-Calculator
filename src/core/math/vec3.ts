/**
 * 3D vector primitives (L0).
 * Coordinate system (see GOALS.md): right-handed, X outboard, Y up, Z forward. Units: mm.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const ZERO: Vec3 = vec3(0, 0, 0);
export const X_AXIS: Vec3 = vec3(1, 0, 0);
export const Y_AXIS: Vec3 = vec3(0, 1, 0);
export const Z_AXIS: Vec3 = vec3(0, 0, 1);

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);
export const negate = (a: Vec3): Vec3 => vec3(-a.x, -a.y, -a.z);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lengthSq = (a: Vec3): number => dot(a, a);
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/** a + s·b */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 =>
  vec3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => addScaled(a, sub(b, a), t);

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-15) throw new Error('Cannot normalize a zero-length vector');
  return scale(a, 1 / len);
}

/** Component of `a` perpendicular to unit vector `u`. */
export const rejectFrom = (a: Vec3, u: Vec3): Vec3 => addScaled(a, u, -dot(a, u));

/**
 * A unit vector perpendicular to unit vector `u`.
 * Deterministic: uses the world axis least aligned with `u`.
 */
export function perpendicular(u: Vec3): Vec3 {
  const ax = Math.abs(u.x);
  const ay = Math.abs(u.y);
  const az = Math.abs(u.z);
  const helper = ax <= ay && ax <= az ? X_AXIS : ay <= az ? Y_AXIS : Z_AXIS;
  return normalize(cross(u, helper));
}

export const approxEqual = (a: Vec3, b: Vec3, tol = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol;

export const toArray = (a: Vec3): [number, number, number] => [a.x, a.y, a.z];
