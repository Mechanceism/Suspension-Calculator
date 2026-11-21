/**
 * Tests workspace data: test definitions (chains of segments) as the user edits them, presets, and
 * conversion to the core segment spec. Saved with the project.
 */
import { CORNER_IDS, type CornerId } from '../core/vehicle/vehicle';
import { formatValue, type Quantity } from '../core/units/units';
import type { PathKind } from '../core/tests/segments';
import type { TestSegmentSpec } from '../core/tests/run';
import { PROFILES, cloneProfile, type CheckProfile } from '../core/tests/checks';
import type { Field } from './store';

export interface TestSegment {
  id: string;
  name: string;
  /** m */
  distance: Field;
  /** m/s */
  speedStart: Field;
  speedEnd: Field;
  path: PathKind;
  /** m */
  radius: Field;
  /** Overrides, g; text '' = off (computed from speed and radius / distance). */
  latG: Field;
  longG: Field;
  /** % (+ uphill) */
  grade: Field;
  /** deg (+ left side lower) */
  bank: Field;
  /** mm (+ bump, − pothole) */
  bumps: Record<CornerId, Field>;
  /** Lumpy road: time-based (Phase B); kept so the test is ready for it. */
  lumpy: boolean;
  /** Weight of this segment within its test (optimizer), default 1. */
  weight: Field;
  /** Check override for this segment (null = the test's checks). */
  checks: CheckProfile | null;
  /** Profile name of the override ('custom' when edited). */
  profile: string | null;
}

export interface TestDesign {
  id: string;
  name: string;
  segments: TestSegment[];
  /** What counts as a pass (severity + thresholds per check) and the profile it came from ('custom' when edited). */
  checks: CheckProfile;
  profile: string;
  /** Priority among tests for the optimizer, % (e.g. 80 paved, 20 rough). */
  priority: Field;
  /** On a failing segment: report it, or let the driver lift to the speed that passes. */
  onFail: 'report' | 'lift';
}

export const defaultChecks = () => cloneProfile(PROFILES.default.checks);

const f = (value: number, q: Quantity): Field => ({ text: formatValue(value, q), value });
export const OFF: Field = { text: '', value: NaN };
export const isOff = (x: Field) => x.text.trim() === '' || !Number.isFinite(x.value);

let counter = 0;
export const newTestId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const MPH = 0.44704;

export interface SegmentPreset { label: string; make: () => Partial<Omit<TestSegment, 'id'>> }

export function newSegment(over: Partial<Omit<TestSegment, 'id'>> = {}): TestSegment {
  return {
    id: newTestId('seg'), name: 'Constant speed',
    distance: f(100, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(40 * MPH, 'speed'),
    path: 'straight', radius: f(30, 'distance'), latG: OFF, longG: OFF,
    grade: f(0, 'percent'), bank: f(0, 'angle'),
    bumps: Object.fromEntries(CORNER_IDS.map((id) => [id, f(0, 'length')])) as Record<CornerId, Field>,
    lumpy: false,
    weight: f(1, 'ratio'), checks: null, profile: null,
    ...over,
  };
}

const bumpsOf = (b: Partial<Record<CornerId, number>>) =>
  Object.fromEntries(CORNER_IDS.map((id) => [id, f(b[id] ?? 0, 'length')])) as Record<CornerId, Field>;

/** Building blocks: speed changes, turns, road features. Combine by editing one segment. */
export const SEGMENT_PRESETS: SegmentPreset[] = [
  { label: 'Accelerate 0–60 mph', make: () => ({ name: 'Accelerate 0–60', distance: f(120, 'distance'), speedStart: f(0, 'speed'), speedEnd: f(60 * MPH, 'speed') }) },
  { label: 'Constant 45 mph', make: () => ({ name: 'Constant 45', distance: f(100, 'distance'), speedStart: f(45 * MPH, 'speed'), speedEnd: f(45 * MPH, 'speed') }) },
  { label: 'Brake 60–0 mph', make: () => ({ name: 'Brake 60–0', distance: f(45, 'distance'), speedStart: f(60 * MPH, 'speed'), speedEnd: f(0, 'speed') }) },
  { label: 'Left turn 30 mph, R 20 m', make: () => ({ name: 'Left turn', path: 'left', radius: f(20, 'distance'), distance: f(31, 'distance'), speedStart: f(30 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed') }) },
  { label: 'Right turn 30 mph, R 20 m', make: () => ({ name: 'Right turn', path: 'right', radius: f(20, 'distance'), distance: f(31, 'distance'), speedStart: f(30 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed') }) },
  { label: 'Incline 10%', make: () => ({ name: 'Incline', grade: f(10, 'percent') }) },
  { label: 'Decline 10%', make: () => ({ name: 'Decline', grade: f(-10, 'percent') }) },
  { label: 'Bump (front left, 40 mm)', make: () => ({ name: 'Bump', bumps: bumpsOf({ FL: 40 }) }) },
  { label: 'Pothole (front right, 50 mm)', make: () => ({ name: 'Pothole', bumps: bumpsOf({ FR: -50 }) }) },
];

/** Whole tests to start from. */
export const TEST_PRESETS: { label: string; make: () => Omit<TestDesign, 'id'> }[] = [
  {
    label: 'Autocross sequence',
    make: () => ({
      name: 'Autocross sequence', checks: defaultChecks(), profile: 'default', priority: f(100, 'percent'), onFail: 'report',
      segments: [
        newSegment({ name: 'Launch 0–40', distance: f(50, 'distance'), speedStart: f(0, 'speed'), speedEnd: f(40 * MPH, 'speed') }),
        newSegment({ name: 'Brake 40–30', distance: f(15, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed') }),
        newSegment({ name: 'Left sweeper', path: 'left', radius: f(25, 'distance'), distance: f(40, 'distance'), speedStart: f(30 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed') }),
        newSegment({ name: 'Right hairpin', path: 'right', radius: f(12, 'distance'), distance: f(20, 'distance'), speedStart: f(22 * MPH, 'speed'), speedEnd: f(22 * MPH, 'speed') }),
        newSegment({ name: 'Exit 22–45', distance: f(60, 'distance'), speedStart: f(22 * MPH, 'speed'), speedEnd: f(45 * MPH, 'speed') }),
      ],
    }),
  },
  {
    label: 'Pothole while braking in a turn',
    make: () => ({
      name: 'Pothole while braking in a turn', checks: defaultChecks(), profile: 'default', priority: f(100, 'percent'), onFail: 'report',
      segments: [
        newSegment({ name: 'Braking left turn + pothole', path: 'left', radius: f(45, 'distance'), distance: f(35, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed'), bumps: bumpsOf({ FR: -40 }) }),
      ],
    }),
  },
  {
    label: 'Hills: incline left, lumpy decline right',
    make: () => ({
      name: 'Hills', checks: defaultChecks(), profile: 'default', priority: f(100, 'percent'), onFail: 'report',
      segments: [
        newSegment({ name: 'Flat straight', distance: f(100, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(40 * MPH, 'speed') }),
        newSegment({ name: 'Bumps + potholes straight', distance: f(60, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(40 * MPH, 'speed'), bumps: bumpsOf({ FL: 30, RR: -30 }) }),
        newSegment({ name: 'Incline left turn', path: 'left', radius: f(40, 'distance'), grade: f(10, 'percent'), distance: f(60, 'distance'), speedStart: f(35 * MPH, 'speed'), speedEnd: f(35 * MPH, 'speed') }),
        newSegment({ name: 'Lumpy decline right turn', path: 'right', radius: f(40, 'distance'), grade: f(-10, 'percent'), lumpy: true, distance: f(60, 'distance'), speedStart: f(35 * MPH, 'speed'), speedEnd: f(35 * MPH, 'speed') }),
      ],
    }),
  },
  { label: 'Empty test', make: () => ({ name: 'New test', checks: defaultChecks(), profile: 'default', priority: f(100, 'percent'), onFail: 'report', segments: [newSegment()] }) },
];

/** Core spec of a segment, with the checks that apply to it. */
export function segmentSpec(s: TestSegment, test?: TestDesign): TestSegmentSpec {
  return {
    checks: s.checks ?? test?.checks,
    weight: Number.isFinite(s.weight.value) ? Math.max(0, s.weight.value) : 1,
    name: s.name,
    distance: Math.max(s.distance.value, 0.01),
    v0: Math.max(0, s.speedStart.value),
    v1: Math.max(0, s.speedEnd.value),
    path: s.path,
    radius: Math.max(s.radius.value, 0.01),
    latG: isOff(s.latG) ? null : s.latG.value,
    longG: isOff(s.longG) ? null : s.longG.value,
    grade: Math.atan(s.grade.value / 100),
    bank: (s.bank.value * Math.PI) / 180,
    bumps: Object.fromEntries(CORNER_IDS.filter((id) => s.bumps[id].value !== 0).map((id) => [id, s.bumps[id].value])),
    samples: 3,
  };
}
