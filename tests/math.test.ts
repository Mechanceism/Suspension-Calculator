import { describe, it, expect } from 'vitest';
import {
  vec3, X_AXIS, Y_AXIS, Z_AXIS, cross, dot, length, perpendicular, approxEqual,
  fromRotationVector, fromAxisAngle, mulVec, mul, transpose, IDENTITY,
  planeFromPoints, intersectPlanes, intersectLinePlane, lineThrough, rotatePointAboutAxis, plane,
  solveLinear, rank, scale,
} from '../src/core';

describe('vec3', () => {
  it('cross product is right-handed (X × Y = Z)', () => {
    expect(approxEqual(cross(X_AXIS, Y_AXIS), Z_AXIS)).toBe(true);
  });
  it('perpendicular returns a unit vector orthogonal to the input', () => {
    for (const v of [X_AXIS, Y_AXIS, Z_AXIS, vec3(0.6, 0.8, 0), vec3(1, 1, 1)]) {
      const u = scale(v, 1 / length(v));
      const p = perpendicular(u);
      expect(Math.abs(dot(p, u))).toBeLessThan(1e-12);
      expect(length(p)).toBeCloseTo(1, 12);
    }
  });
});

describe('mat3 rotations', () => {
  it('rotating X by +90° about Z gives Y', () => {
    expect(approxEqual(mulVec(fromRotationVector(vec3(0, 0, Math.PI / 2)), X_AXIS), Y_AXIS, 1e-12)).toBe(true);
  });
  it('rotation matrices are orthonormal', () => {
    const R = fromAxisAngle(scale(vec3(1, 2, 3), 1 / Math.sqrt(14)), 0.7);
    const I = mul(R, transpose(R));
    I.forEach((v, i) => expect(v).toBeCloseTo(IDENTITY[i]!, 12));
  });
  it('tiny rotation vectors use the first-order form', () => {
    const R = fromRotationVector(vec3(1e-14, 0, 0));
    expect(R[0]).toBe(1);
  });
});

describe('geom', () => {
  it('intersects two planes', () => {
    const l = intersectPlanes(plane(vec3(0, 0, 5), Z_AXIS), plane(vec3(3, 0, 0), X_AXIS));
    expect(l).not.toBeNull();
    expect(Math.abs(dot(l!.dir, Y_AXIS))).toBeCloseTo(1, 12);
    expect(l!.point.x).toBeCloseTo(3, 12);
    expect(l!.point.z).toBeCloseTo(5, 12);
  });
  it('returns null for parallel planes and collinear points', () => {
    expect(intersectPlanes(plane(vec3(0, 0, 0), Y_AXIS), plane(vec3(0, 5, 0), Y_AXIS))).toBeNull();
    expect(planeFromPoints(vec3(0, 0, 0), vec3(1, 1, 1), vec3(2, 2, 2))).toBeNull();
  });
  it('intersects a line with a plane', () => {
    const p = intersectLinePlane(lineThrough(vec3(0, 10, 0), vec3(1, 9, 0)), plane(vec3(0, 0, 0), Y_AXIS));
    expect(approxEqual(p!, vec3(10, 0, 0), 1e-12)).toBe(true);
  });
  it('Rodrigues point rotation about an offset axis', () => {
    const p = rotatePointAboutAxis(vec3(2, 0, 0), vec3(1, 0, 0), Z_AXIS, Math.PI / 2);
    expect(approxEqual(p, vec3(1, 1, 0), 1e-12)).toBe(true);
  });
});

describe('linalg', () => {
  it('solves a linear system', () => {
    const x = solveLinear([[2, 1], [1, 3]], [3, 5]);
    expect(x![0]).toBeCloseTo(0.8, 12);
    expect(x![1]).toBeCloseTo(1.4, 12);
  });
  it('detects rank deficiency', () => {
    expect(rank([[1, 2], [2, 4]]).rank).toBe(1);
    expect(rank([[1, 0], [0, 1]]).rank).toBe(2);
  });
});
