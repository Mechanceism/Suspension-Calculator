/**
 * Test segments (Phase A, quasi-static): each segment combines three layers that act at the same time:
 *   speed: start → end speed over a distance (acceleration = (v₁² − v₀²) / 2d), or a g override
 *   path:  straight, or a left / right turn of radius R (lateral g = v² / (g·R)), or a lateral-g override
 *   road:  grade (incline / decline), bank, and bumps / potholes under chosen wheels
 * A test is a chain of segments. Each segment is sampled at a few speeds across its range; every sample
 * is one steady state for the whole-car solve. (Order along the chain doesn't change steady states;
 * transients come with the time-based Phase B.)
 *
 * Grade and bank tilt gravity in the road frame: the tires must also supply m·g·sin(grade) along the road
 * (uphill needs drive) and m·(a_y − g·sin(bank)) across it (a bank toward the inside of the turn helps),
 * and only m·g·cos(grade)·cos(bank) presses the car onto the road.
 */
import type { CornerId } from '../vehicle/vehicle';
import type { CheckProfile } from './checks';

export const G = 9.80665;

export type PathKind = 'straight' | 'left' | 'right';

export interface SegmentSpec {
  name?: string;
  /** Segment length, m. */
  distance: number;
  /** Speeds at the start and end, m/s. */
  v0: number;
  v1: number;
  path: PathKind;
  /** Turn radius, m (turns only). */
  radius: number;
  /** Lateral acceleration override, g (magnitude; the turn direction sets the sign). */
  latG?: number | null;
  /** Longitudinal acceleration override, g (+ accelerating, − braking). */
  longG?: number | null;
  /** Road grade, rad (+ = uphill). */
  grade: number;
  /** Road bank, rad (+ = left side lower). */
  bank: number;
  /** Ground height change under each wheel, mm (+ bump, − pothole). */
  bumps?: Partial<Record<CornerId, number>>;
  /** Speed samples across the range (1 when the speed is constant). */
  samples?: number;
}

/** One steady state to solve. Accelerations are the road-frame values the tires must supply. */
export interface RoadState {
  /** Label, e.g. "2: 45 mph". */
  name: string;
  segment: number;
  /** Speed of this sample, m/s. */
  speed: number;
  /** Kinematic accelerations of the car (g): lateral (+ left), longitudinal (+ forward). */
  ay: number;
  ax: number;
  /** What the solver needs: effective lateral g, braking / accel g, gravity scale, ground offsets. */
  lateralG: number;
  brakingG: number;
  accelG: number;
  gravityScale: number;
  groundOffset: Partial<Record<CornerId, number>>;
  /** Road grade and bank, rad (to show the state again). */
  grade: number;
  bank: number;
  /** Optimizer weight (test priority × segment weight) and the pass rules that apply. */
  weight?: number;
  checks?: CheckProfile;
}

/** Longitudinal acceleration of a segment, g (+ accelerating). */
export function segmentLongG(s: SegmentSpec): number {
  if (s.longG !== null && s.longG !== undefined && Number.isFinite(s.longG)) return s.longG;
  if (!(s.distance > 0)) return 0;
  return (s.v1 * s.v1 - s.v0 * s.v0) / (2 * s.distance) / G;
}

/** Lateral acceleration at speed v, g (+ = left turn). */
export function segmentLatG(s: SegmentSpec, v: number): number {
  if (s.path === 'straight') return 0;
  const sign = s.path === 'left' ? 1 : -1;
  if (s.latG !== null && s.latG !== undefined && Number.isFinite(s.latG)) return sign * Math.abs(s.latG);
  return s.radius > 0 ? (sign * v * v) / (G * s.radius) : 0;
}

/** Fold grade and bank into what the solver needs. */
export function roadEffective(ay: number, ax: number, grade: number, bank: number) {
  const lateralG = ay - Math.sin(bank);
  const along = ax + Math.sin(grade);
  return { lateralG, accelG: Math.max(0, along), brakingG: Math.max(0, -along), gravityScale: Math.cos(grade) * Math.cos(bank) };
}

/** Steady states of one segment (speeds scaled by `speedScale`, e.g. for a speed-limit search). */
export function segmentStates(s: SegmentSpec, index: number, speedScale = 1): RoadState[] {
  const v0 = s.v0 * speedScale, v1 = s.v1 * speedScale;
  const n = Math.abs(v1 - v0) < 1e-9 ? 1 : Math.max(2, Math.round(s.samples ?? 3));
  const scaled: SegmentSpec = { ...s, v0, v1 };
  // A g override scales with speed² so a speed-limit search still means something.
  if (scaled.longG !== null && scaled.longG !== undefined && Number.isFinite(scaled.longG)) scaled.longG *= speedScale * speedScale;
  const ax = segmentLongG(scaled);
  const out: RoadState[] = [];
  for (let i = 0; i < n; i++) {
    const v = n === 1 ? v0 : v0 + ((v1 - v0) * i) / (n - 1);
    let ay = segmentLatG(scaled, v);
    if (s.latG !== null && s.latG !== undefined && Number.isFinite(s.latG)) ay *= speedScale * speedScale;
    const eff = roadEffective(ay, ax, s.grade, s.bank);
    out.push({
      name: `${index + 1}${n > 1 ? `.${i + 1}` : ''}`, segment: index, speed: v, ay, ax,
      ...eff, groundOffset: { ...(s.bumps ?? {}) }, grade: s.grade, bank: s.bank,
    });
  }
  return out;
}

export const testStates = (segments: SegmentSpec[]): RoadState[] => segments.flatMap((s, i) => segmentStates(s, i));

/** Segment duration, s (constant acceleration over the distance). */
export function segmentDuration(s: SegmentSpec): number {
  const v = (s.v0 + s.v1) / 2;
  return v > 0 ? s.distance / v : Infinity;
}
