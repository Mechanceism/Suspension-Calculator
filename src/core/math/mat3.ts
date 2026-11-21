/**
 * 3×3 rotation matrices (L0). Row-major: [m00, m01, m02, m10, m11, m12, m20, m21, m22].
 */
import { type Vec3, vec3, length, scale } from './vec3';

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const mulVec = (m: Mat3, v: Vec3): Vec3 =>
  vec3(
    m[0] * v.x + m[1] * v.y + m[2] * v.z,
    m[3] * v.x + m[4] * v.y + m[5] * v.z,
    m[6] * v.x + m[7] * v.y + m[8] * v.z,
  );

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r as unknown as Mat3;
}

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/**
 * Rotation matrix from a rotation vector ω (axis · angle, radians) using Rodrigues' formula:
 *   R = I + sinθ·K + (1 − cosθ)·K²,  K = skew(ω/θ)
 */
export function fromRotationVector(w: Vec3): Mat3 {
  const theta = length(w);
  if (theta < 1e-12) {
    // First-order expansion: R ≈ I + skew(ω)
    return [1, -w.z, w.y, w.z, 1, -w.x, -w.y, w.x, 1];
  }
  const k = scale(w, 1 / theta);
  const s = Math.sin(theta);
  const c = 1 - Math.cos(theta);
  const { x, y, z } = k;
  return [
    1 + c * (x * x - 1), -s * z + c * x * y, s * y + c * x * z,
    s * z + c * x * y, 1 + c * (y * y - 1), -s * x + c * y * z,
    -s * y + c * x * z, s * x + c * y * z, 1 + c * (z * z - 1),
  ];
}

/** Rotation by `angle` (radians) about unit `axis`. */
export const fromAxisAngle = (axis: Vec3, angle: number): Mat3 => fromRotationVector(scale(axis, angle));

/** Re-orthonormalize a near-rotation matrix (Gram–Schmidt on rows) to stop numerical drift. */
export function orthonormalize(m: Mat3): Mat3 {
  let r0 = vec3(m[0], m[1], m[2]);
  let r1 = vec3(m[3], m[4], m[5]);
  const l0 = length(r0);
  r0 = scale(r0, 1 / l0);
  const d = r0.x * r1.x + r0.y * r1.y + r0.z * r1.z;
  r1 = vec3(r1.x - d * r0.x, r1.y - d * r0.y, r1.z - d * r0.z);
  r1 = scale(r1, 1 / length(r1));
  const r2 = vec3(r0.y * r1.z - r0.z * r1.y, r0.z * r1.x - r0.x * r1.z, r0.x * r1.y - r0.y * r1.x);
  return [r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, r2.x, r2.y, r2.z];
}
