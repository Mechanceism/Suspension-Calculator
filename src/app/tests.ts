/**
 * Tests workspace data: test definitions (chains of segments) as the user edits them, presets, and
 * conversion to the core segment spec. Saved with the project.
 */
import { CORNER_IDS, type CornerId } from '../core/vehicle/vehicle';
import { formatValue, type Quantity } from '../core/units/units';
import { segmentStates, type PathKind, type RoadState, type CarDims } from '../core/tests/segments';
import type { RoadSpec } from '../core/tests/road';
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
  /** Old "lumpy" flag (format 8); now the rough surface. */
  lumpy: boolean;
  /** Seeded random rough surface (height map). */
  rough: { on: boolean; seed: number; maxHeight: Field; scale: Field; coverage: Field };
  /** Placed bumps / potholes along the segment. */
  features: RoadFeatureDesign[];
  /** Priority rank within its test (1 = most important; equal ranks = equal priority). Not the run order. */
  rank: number;
  /** Check override for this segment (null = the test's checks). */
  checks: CheckProfile | null;
  /** Profile name of the override ('custom' when edited). */
  profile: string | null;
}

export interface RoadFeatureDesign {
  id: string;
  kind: 'bump' | 'pothole';
  /** m from the segment start */
  at: Field;
  /** m */
  length: Field;
  /** mm */
  height: Field;
  side: 'left' | 'right' | 'both';
}

export const newFeature = (kind: 'bump' | 'pothole', at = 10): RoadFeatureDesign => ({
  id: newTestId('feat'), kind, at: f(at, 'distance'), length: f(kind === 'bump' ? 1.5 : 0.8, 'distance'),
  height: f(kind === 'bump' ? 40 : 50, 'length'), side: kind === 'bump' ? 'both' : 'right',
});
export const newSeed = () => Math.floor(Math.random() * 1e6);

export interface TestDesign {
  id: string;
  name: string;
  segments: TestSegment[];
  /** What counts as a pass (severity + thresholds per check) and the profile it came from ('custom' when edited). */
  checks: CheckProfile;
  profile: string;
  /** Priority rank among tests (1 = most important; equal ranks = equal priority). Not the list order. */
  rank: number;
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
    rank: 1, checks: null, profile: null,
    rough: { on: false, seed: 1, maxHeight: f(30, 'length'), scale: f(1.5, 'distance'), coverage: f(60, 'percent') },
    features: [],
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
  { label: 'Speed bump (40 mm, both sides)', make: () => ({ name: 'Speed bump', speedStart: f(15 * MPH, 'speed'), speedEnd: f(15 * MPH, 'speed'), distance: f(30, 'distance'), features: [newFeature('bump', 12)] }) },
  { label: 'Pothole (right side, 50 mm)', make: () => ({ name: 'Pothole', features: [newFeature('pothole', 20)] }) },
  { label: 'Rough road', make: () => ({ name: 'Rough road', rough: { on: true, seed: newSeed(), maxHeight: f(30, 'length'), scale: f(1.5, 'distance'), coverage: f(60, 'percent') } }) },
];

/** Whole tests to start from. */
export const TEST_PRESETS: { label: string; make: () => Omit<TestDesign, 'id'> }[] = [
  {
    label: 'Autocross sequence',
    make: () => ({
      name: 'Autocross sequence', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report',
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
      name: 'Pothole while braking in a turn', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report',
      segments: [
        newSegment({ name: 'Braking left turn + pothole', path: 'left', radius: f(45, 'distance'), distance: f(35, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed'), features: [{ ...newFeature('pothole', 15), height: f(40, 'length') }] }),
      ],
    }),
  },
  {
    label: 'Hills: incline left, lumpy decline right',
    make: () => ({
      name: 'Hills', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report',
      segments: [
        newSegment({ name: 'Flat straight', distance: f(100, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(40 * MPH, 'speed') }),
        newSegment({ name: 'Bumps + potholes straight', distance: f(60, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(40 * MPH, 'speed'), features: [{ ...newFeature('bump', 15), side: 'left' }, newFeature('pothole', 35)] }),
        newSegment({ name: 'Incline left turn', path: 'left', radius: f(40, 'distance'), grade: f(10, 'percent'), distance: f(60, 'distance'), speedStart: f(35 * MPH, 'speed'), speedEnd: f(35 * MPH, 'speed') }),
        newSegment({ name: 'Lumpy decline right turn', path: 'right', radius: f(40, 'distance'), grade: f(-10, 'percent'), rough: { on: true, seed: 42, maxHeight: f(25, 'length'), scale: f(1.2, 'distance'), coverage: f(70, 'percent') }, distance: f(60, 'distance'), speedStart: f(35 * MPH, 'speed'), speedEnd: f(35 * MPH, 'speed') }),
      ],
    }),
  },
  { label: 'Empty test', make: () => ({ name: 'New test', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', segments: [newSegment()] }) },
];

/**
 * Optimizer weight of a priority rank among n items: n + 1 − rank (rank 1 of 2 → 2, rank 2 → 1, so 2 : 1).
 * Equal ranks weigh the same.
 */
export const rankWeight = (rank: number, n: number) => Math.max(1, n + 1 - Math.min(Math.max(1, Math.round(rank)), n));

/** Core spec of a segment, with the checks that apply to it. */
export function segmentSpec(s: TestSegment, test?: TestDesign): TestSegmentSpec {
  return {
    checks: s.checks ?? test?.checks,
    weight: rankWeight(s.rank, test?.segments.length ?? 1),
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
    road: roadSpecOf(s),
  };
}

/** The segment's road (rough surface + features) for the core. */
export function roadSpecOf(s: TestSegment): RoadSpec | undefined {
  const rough = s.rough.on ? { seed: s.rough.seed, maxHeight: Math.max(0, s.rough.maxHeight.value), scale: Math.max(0.05, s.rough.scale.value), coverage: Math.min(1, Math.max(0, s.rough.coverage.value / 100)) } : null;
  const features = s.features.map((x) => ({ kind: x.kind, at: x.at.value, length: Math.max(0, x.length.value), height: Math.max(0, x.height.value), side: x.side }));
  return rough || features.length ? { rough, features } : undefined;
}

/**
 * Load cases for the optimizer from tests: every segment's speed samples, each with weight
 * (test priority × segment priority, from their ranks) and the segment's pass rules.
 * `source`: a test id, or 'all' for every test (weighted by its priority rank).
 */
export function statesForTests(tests: TestDesign[], source: string, dims?: CarDims): RoadState[] {
  const chosen = source === 'all' ? tests : tests.filter((t) => t.id === source);
  const tw = (t: TestDesign) => (source === 'all' ? rankWeight(t.rank, tests.length) : 1);
  const totalPriority = chosen.reduce((a, t) => a + tw(t), 0) || 1;
  const out: RoadState[] = [];
  for (const t of chosen) {
    const tp = tw(t) / totalPriority;
    const specs = t.segments.map((sg) => segmentSpec(sg, t));
    const segTotal = specs.reduce((a, sp) => a + (sp.weight ?? 1), 0) || 1;
    specs.forEach((sp, i) => {
      const st = segmentStates(sp, i, 1, dims);
      for (const x of st) out.push({ ...x, name: `${t.name} ${x.name}`, weight: (tp * (sp.weight ?? 1) / segTotal) * specs.length / st.length, checks: sp.checks });
    });
  }
  return out;
}
