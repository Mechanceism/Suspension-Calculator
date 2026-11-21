/**
 * Tire contact-patch geometry by the slice method (L3, docs/MATH.md § L3).
 *
 * The tire is a solid of revolution about its spin axis. Slice it into disks across the tread
 * (position s along the axle, + outboard). Each disk is a circle of radius R(s) whose plane is cut
 * by the ground in a straight chord. With γ the angle between the axle and the ground plane
 * (n·a = sin γ) and h(s) the height of the slice center above the ground:
 *
 *   h(s) = h₀ + s·sin γ          d(s) = h(s) / cos γ   (center → chord, within the slice plane)
 *   chord   L(s) = 2√(R² − d²)    segment A(s) = R²·acos(d/R) − d√(R² − d²)
 *   area    A = (1/cos γ) ∫ L ds  volume V = ∫ A(s) ds  centroid = L-weighted chord midpoints
 *
 * No case split between "rectangle" (γ = 0) and "ellipse" (γ ≠ 0) patches is needed.
 */
import { type Vec3, add, scale, dot, cross, normalize, addScaled } from '../math/vec3';
import { integrateCosineMap, bisect } from '../math/quadrature';

export interface TireProfile {
  /** Outer (unloaded) radius, mm. */
  readonly radius: number;
  /** Section width, mm. */
  readonly width: number;
  /** Shoulder (edge) radius, mm. 0 = sharp-edged cylinder. */
  readonly shoulderRadius: number;
  /** Rim (bead seat) radius, mm. */
  readonly rimRadius: number;
}

/** Slice radius R(s): flat across the tread, quarter-circle shoulders (radius drops to R − r_e at the edge). */
export function sliceRadius(p: TireProfile, s: number): number {
  const half = p.width / 2;
  const a = Math.abs(s);
  if (a > half) return 0;
  const re = effectiveShoulder(p);
  const flat = half - re;
  if (a <= flat) return p.radius;
  const u = a - flat;
  return p.radius - re + Math.sqrt(Math.max(0, re * re - u * u));
}

const effectiveShoulder = (p: TireProfile) =>
  Math.max(0, Math.min(p.shoulderRadius, p.width / 2, p.radius - p.rimRadius));

const chord = (R: number, d: number) => (Math.abs(d) >= R ? 0 : 2 * Math.sqrt(R * R - d * d));
const segment = (R: number, d: number) =>
  d >= R ? 0 : d <= -R ? Math.PI * R * R : R * R * Math.acos(d / R) - d * Math.sqrt(R * R - d * d);

export interface LocalPatch {
  inContact: boolean;
  /** Contact patch area on the ground, mm². */
  area: number;
  /** Tire volume below the ground plane, mm³. */
  volume: number;
  /** Centroid position along the axle (+ outboard), mm. */
  centroidS: number;
  /** Centroid distance from the axle toward the ground, within the wheel plane, mm. */
  centroidD: number;
  /** Contact extent along the axle, mm. */
  sMin: number;
  sMax: number;
  /** Longest chord (patch length in the rolling direction), mm. */
  length: number;
  /** Deepest point of the tire below the ground, along the ground normal, mm. */
  penetration: number;
  /** The ground reaches the rim radius somewhere (tire bottomed out). */
  bottomedOut: boolean;
}

const NO_CONTACT: LocalPatch = {
  inContact: false, area: 0, volume: 0, centroidS: 0, centroidD: 0, sMin: 0, sMax: 0, length: 0,
  penetration: 0, bottomedOut: false,
};

/**
 * Patch in tire-local terms.
 * @param h0   height of the wheel center above the ground plane (along the ground normal), mm
 * @param tilt n·a = sin γ: the axle's component along the ground normal (0 = axle parallel to ground)
 */
export function localPatch(p: TireProfile, h0: number, tilt: number): LocalPatch {
  const sinG = Math.max(-0.999999, Math.min(0.999999, tilt));
  const cosG = Math.sqrt(1 - sinG * sinG);
  const half = p.width / 2;
  const d = (s: number) => (h0 + s * sinG) / cosG;
  const f = (s: number) => sliceRadius(p, s) - d(s); // > 0 where the slice touches the ground

  // Contact intervals: split at profile breakpoints, then find sign changes of f.
  const re = effectiveShoulder(p);
  const breaks = [...new Set([-half, -(half - re), half - re, half])].sort((a, b) => a - b);
  const intervals: [number, number][] = [];
  const N = 48;
  for (let k = 0; k + 1 < breaks.length; k++) {
    const a = breaks[k]!;
    const b = breaks[k + 1]!;
    if (!(b > a)) continue;
    let prevS = a;
    let prevF = f(a);
    let start = prevF > 0 ? a : null;
    for (let i = 1; i <= N; i++) {
      const s = a + ((b - a) * i) / N;
      const fs = f(s);
      if ((prevF > 0) !== (fs > 0)) {
        const root = bisect(f, prevS, s, 1e-12);
        if (fs > 0) start = root;
        else if (start !== null) { intervals.push([start, root]); start = null; }
      }
      prevS = s; prevF = fs;
    }
    if (start !== null) intervals.push([start, b]);
  }
  if (intervals.length === 0) return NO_CONTACT;

  let sumL = 0, sumA = 0, sumLs = 0, sumLd = 0;
  for (const [a, b] of intervals) {
    const [iL, iA, iLs, iLd] = integrateCosineMap(a, b, 4, (s, out) => {
      const R = sliceRadius(p, s);
      const ds = d(s);
      const L = chord(R, ds);
      out[0] = L; out[1] = segment(R, ds); out[2] = L * s; out[3] = L * ds;
    });
    sumL += iL!; sumA += iA!; sumLs += iLs!; sumLd += iLd!;
  }

  // Patch length, penetration and bottoming from samples across the contact range.
  const sMin = intervals[0]![0];
  const sMax = intervals[intervals.length - 1]![1];
  let length = 0;
  let penetration = 0;
  let bottomedOut = false;
  for (let i = 0; i <= 64; i++) {
    const s = sMin + ((sMax - sMin) * i) / 64;
    const R = sliceRadius(p, s);
    length = Math.max(length, chord(R, d(s)));
    penetration = Math.max(penetration, R * cosG - (h0 + s * sinG));
    if (d(s) < p.rimRadius) bottomedOut = true;
  }

  return {
    inContact: sumL > 0,
    area: sumL / cosG,
    volume: sumA,
    centroidS: sumL > 0 ? sumLs / sumL : 0,
    centroidD: sumL > 0 ? sumLd / sumL : 0,
    sMin, sMax, length, penetration, bottomedOut,
  };
}

export interface Ground {
  readonly point: Vec3;
  /** Up normal (unit). */
  readonly normal: Vec3;
}

export interface ContactPatch extends LocalPatch {
  /** Wheel inclination to the ground normal, same sense as camber (+ = top outboard), rad. */
  inclination: number;
  /** Height of the wheel center above the ground, mm. */
  centerHeight: number;
  /** Patch centroid in world coordinates (null when not in contact). */
  centroid: Vec3 | null;
  /** Closed outline of the patch on the ground, world coordinates. */
  outline: Vec3[];
}

/** World-space contact patch for a wheel at `center` with outboard unit spin axis `spinAxis`. */
export function contactPatch(center: Vec3, spinAxis: Vec3, ground: Ground, p: TireProfile, outlineSamples = 40): ContactPatch {
  const a = normalize(spinAxis);
  const n = normalize(ground.normal);
  const sinG = dot(n, a);
  const cosG = Math.sqrt(Math.max(1e-12, 1 - sinG * sinG));
  const h0 = dot(n, add(center, scale(ground.point, -1)));
  const local = localPatch(p, h0, sinG);
  const inclination = -Math.asin(Math.max(-1, Math.min(1, sinG)));
  // In-plane "down" direction and rolling direction.
  const u = normalize(addScaled(scale(n, -1), a, sinG));
  const t = cross(a, u);
  const at = (s: number, dist: number) => addScaled(addScaled(center, a, s), u, dist);
  if (!local.inContact) return { ...local, inclination, centerHeight: h0, centroid: null, outline: [] };
  const left: Vec3[] = [];
  const right: Vec3[] = [];
  for (let i = 0; i <= outlineSamples; i++) {
    const s = local.sMin + ((local.sMax - local.sMin) * i) / outlineSamples;
    const ds = (h0 + s * sinG) / cosG;
    const halfL = chord(sliceRadius(p, s), ds) / 2;
    const m = at(s, ds);
    left.push(addScaled(m, t, halfL));
    right.push(addScaled(m, t, -halfL));
  }
  const outline = [...left, ...right.reverse(), left[0]!];
  return { ...local, inclination, centerHeight: h0, centroid: at(local.centroidS, local.centroidD), outline };
}

/**
 * Area-weighted sample points over the contact patch (world coordinates), for integrals such as
 * the parking scrub torque. Weights sum to the patch area.
 */
export function patchSamples(
  center: Vec3, spinAxis: Vec3, ground: Ground, p: TireProfile, nS = 40, nT = 16,
): { points: Vec3[]; weights: number[] } {
  const a = normalize(spinAxis);
  const n = normalize(ground.normal);
  const sinG = dot(n, a);
  const cosG = Math.sqrt(Math.max(1e-12, 1 - sinG * sinG));
  const h0 = dot(n, add(center, scale(ground.point, -1)));
  const local = localPatch(p, h0, sinG);
  const points: Vec3[] = [];
  const weights: number[] = [];
  if (!local.inContact) return { points, weights };
  const u = normalize(addScaled(scale(n, -1), a, sinG));
  const t = cross(a, u);
  const ds = (local.sMax - local.sMin) / nS;
  for (let i = 0; i < nS; i++) {
    const s = local.sMin + (i + 0.5) * ds;
    const d = (h0 + s * sinG) / cosG;
    const L = chord(sliceRadius(p, s), d);
    if (L <= 0) continue;
    const m = addScaled(addScaled(center, a, s), u, d);
    for (let j = 0; j < nT; j++) {
      const v = -L / 2 + ((j + 0.5) * L) / nT;
      points.push(addScaled(m, t, v));
      weights.push(((L / nT) * ds) / cosG);
    }
  }
  return { points, weights };
}

/** Air volume of the tire (annulus between rim and tread, following the shoulder profile), mm³. */
export function airVolume(p: TireProfile): number {
  const half = p.width / 2;
  const re = effectiveShoulder(p);
  const pieces: [number, number][] = [[-half, -(half - re)], [-(half - re), half - re], [half - re, half]];
  let v = 0;
  for (const [a, b] of pieces) {
    if (!(b > a)) continue;
    v += integrateCosineMap(a, b, 1, (s, out) => {
      const R = sliceRadius(p, s);
      out[0] = Math.PI * Math.max(0, R * R - p.rimRadius * p.rimRadius);
    })[0]!;
  }
  return v;
}
