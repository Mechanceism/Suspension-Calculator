/**
 * Tests workspace data: test definitions (chains of segments) as the user edits them, presets, and
 * conversion to the core segment spec. Saved with the project.
 */
import { CORNER_IDS, type CornerId } from '../core/vehicle/vehicle';
import type { DrivingStyle } from '../core/tests/segments';
import { formatValue, type Quantity } from '../core/units/units';
import { segmentStates, type PathKind, type RoadState, type CarDims , racingLineRadius } from '../core/tests/segments';
import type { RoadSpec } from '../core/tests/road';
import type { TestSegmentSpec } from '../core/tests/run';
import type { SegmentPlan } from '../core/tests/plan';
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
  /** Usable track width, m (racing line; '' or 0 = drive the drawn path). */
  width?: Field;
  /** Overrides, g; text '' = off (computed from speed and radius / distance). */
  latG: Field;
  longG: Field;
  /** % (+ uphill) */
  grade: Field;
  /**
   * A transition (round 5): the grade changes evenly along it from the segment before's to the segment after's
   * (a rounded crest or dip; its length sets how gradual). Its own grade isn't used. Without one between two
   * grades the change is abrupt — a sharp crest can launch the car.
   */
  transition?: boolean;
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
  /** Coast: no throttle, no brakes (with the driver working the pedals the speed follows the forces). */
  coast?: boolean;
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
  /** Hold the set speeds exactly: on a failing segment, report it, or let the driver lift to the speed that passes. */
  onFail: 'report' | 'lift';
  /**
   * Speeds: **max** — the set speeds are maximums; the driver plans the speed to the grip target (brakes earlier,
   * accelerates out) and tries other ways (then lower targets) before a segment fails; scored on time.
   * **hold** — the set speeds are held exactly (as before; `onFail` applies). Missing = hold (files from before).
   * **grip** — grip only (round 4): planned like *max* but the set speeds aren't caps; the turns, braking and
   * accelerating are limited by the grip alone, the straights by `topSpeed` (until a powertrain limits them).
   */
  speedMode?: 'max' | 'hold' | 'grip';
  /** Grip only: the top speed on the straights (m/s); none = the test's highest set speed. */
  topSpeed?: Field;
  /** Speeds as maximums: the share of the tires' grip the driver plans to (0–1, default 0.95). */
  gripTarget?: number;
  /** Included in Run all / Optimize all (unchecked = skipped). */
  enabled: boolean;
  /**
   * Round 5: the driving style — driving and braking at once. Missing = Auto (by the pass rules: Drift → the
   * handbrake into turns, Off-road → rally left-foot braking, Drag → the line-lock before the launch; others none).
   */
  style?: 'none' | DrivingStyle;
  /** Also drive the test over time (Phase B ride: bumps at speed, transients) and check every moment. */
  ride: boolean;
  /** Over time, a driver steers the car along the path (Phase C handling: slip angles, yaw, sideslip). */
  handling: boolean;
  /** With handling: the driver also works the throttle and brakes (speeds are targets; slows for turns, lifts when wide). */
  driverSpeed?: boolean;
  /** Take the racing line through turns with a track width (a larger radius: outside – apex – outside). */
  racingLine?: boolean;
}

export const defaultChecks = () => cloneProfile(PROFILES.default.checks);

/** New and preset tests: speeds as maximums at a 95 % grip target. */
const MAXIMUMS = { speedMode: 'max' as const, gripTarget: 0.95 };
/** Lap-style presets (round 4): grip only, at a 95 % grip target. */
const GRIP_ONLY = { speedMode: 'grip' as const, gripTarget: 0.95 };

/** The speeds are planned by the driver (speeds as maximums or grip only). */
export const plannedSpeeds = (t: Pick<TestDesign, 'speedMode'>) => t.speedMode === 'max' || t.speedMode === 'grip';
/**
 * The driver works the pedals: always with planned speeds (round 4: the test's time is how long the car took as
 * driven, within its tires and powertrain each moment, not the plan's), else when ticked. Needs the driver
 * steering over time.
 */
export const driverSpeedOf = (t: Pick<TestDesign, 'speedMode' | 'driverSpeed' | 'ride' | 'handling'>) =>
  t.ride !== false && t.handling !== false && (plannedSpeeds(t) || !!t.driverSpeed);
/** Grip only: the straights' top speed (m/s) — the test's own, else its highest set speed. */
export function topSpeedOf(t: Pick<TestDesign, 'topSpeed' | 'segments'>): number {
  if (t.topSpeed && Number.isFinite(t.topSpeed.value) && t.topSpeed.value > 0) return t.topSpeed.value;
  return Math.max(1, ...t.segments.map((s) => Math.max(s.speedStart.value, s.speedEnd.value)));
}
/** The run options a test's speed mode adds (`ladder: false` for optimizers: plan once, no retries). */
export const planOption = (t: Pick<TestDesign, 'speedMode' | 'gripTarget'> & Partial<Pick<TestDesign, 'topSpeed' | 'segments'>>, ladder = true) =>
  (plannedSpeeds(t) ? { plan: {
    gripTarget: t.gripTarget ?? 0.95, ...(ladder ? {} : { ladder: false }),
    ...(t.speedMode === 'grip' && t.segments ? { gripOnly: { topSpeed: topSpeedOf({ topSpeed: t.topSpeed, segments: t.segments }) } } : {}),
  } } : {});

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
  { label: 'Empty', make: () => ({ name: 'New segment' }) },
  { label: 'Accelerate 0–60 mph', make: () => ({ name: 'Accelerate 0–60', distance: f(120, 'distance'), speedStart: f(0, 'speed'), speedEnd: f(60 * MPH, 'speed') }) },
  { label: 'Constant 45 mph', make: () => ({ name: 'Constant 45', distance: f(100, 'distance'), speedStart: f(45 * MPH, 'speed'), speedEnd: f(45 * MPH, 'speed') }) },
  { label: 'Brake 60–0 mph', make: () => ({ name: 'Brake 60–0', distance: f(45, 'distance'), speedStart: f(60 * MPH, 'speed'), speedEnd: f(0, 'speed') }) },
  { label: 'Left turn 30 mph, R 20 m', make: () => ({ name: 'Left turn', path: 'left', radius: f(20, 'distance'), distance: f(31, 'distance'), speedStart: f(30 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed') }) },
  { label: 'Right turn 30 mph, R 20 m', make: () => ({ name: 'Right turn', path: 'right', radius: f(20, 'distance'), distance: f(31, 'distance'), speedStart: f(30 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed') }) },
  { label: 'Incline 10%', make: () => ({ name: 'Incline', grade: f(10, 'percent') }) },
  { label: 'Transition (rounds a change of grade)', make: () => ({ name: 'Transition', transition: true, distance: f(20, 'distance') }) },
  { label: 'Decline 10%', make: () => ({ name: 'Decline', grade: f(-10, 'percent') }) },
  { label: 'Speed bump (40 mm, both sides)', make: () => ({ name: 'Speed bump', speedStart: f(15 * MPH, 'speed'), speedEnd: f(15 * MPH, 'speed'), distance: f(30, 'distance'), features: [newFeature('bump', 12)] }) },
  { label: 'Pothole (right side, 50 mm)', make: () => ({ name: 'Pothole', features: [newFeature('pothole', 20)] }) },
  { label: 'Rough road', make: () => ({ name: 'Rough road', rough: { on: true, seed: newSeed(), maxHeight: f(30, 'length'), scale: f(1.5, 'distance'), coverage: f(60, 'percent') } }) },
];

/** Whole tests to start from. */
export const TEST_PRESETS: { label: string; make: () => Omit<TestDesign, 'id'> }[] = [
  {
    label: 'Autocross (simple)',
    make: () => ({
      name: 'Autocross (simple)', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', ...GRIP_ONLY, enabled: true, ride: true, handling: true,
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
    label: 'Autocross (complex): slalom, offset gates, sweepers',
    make: () => {
      // Flat (no bank, no grade) and balanced: the same number and kind of left and right turns, so both
      // sides of the car work equally. A slalom (R 25 m at 30 mph, ≈ 0.7 g, cones ≈ 15 m apart), two
      // mirrored sets of offset gates (R 18 m at 25 mph), and a broad 90° sweeper each way (R 40 m at 35 mph).
      // Every turn sequence ends on the heading it started on, so the course runs straight overall.
      const arc = (name: string, path: 'left' | 'right', radius: number, d: number, mph: number) =>
        newSegment({ name, path, radius: f(radius, 'distance'), distance: f(d, 'distance'), speedStart: f(mph * MPH, 'speed'), speedEnd: f(mph * MPH, 'speed') });
      const seg = (name: string, d: number, v0: number, v1: number) => newSegment({ name, distance: f(d, 'distance'), speedStart: f(v0 * MPH, 'speed'), speedEnd: f(v1 * MPH, 'speed') });
      const sweep = (Math.PI / 2) * 40;
      return {
        name: 'Autocross (complex)', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', ...GRIP_ONLY, enabled: true, ride: true, handling: true,
        segments: [
          seg('Launch 0–30', 40, 0, 30),
          // Slalom: half, full, full… half arcs, alternating; three left and three right, net heading 0.
          arc('Slalom 1 (left, entry)', 'left', 25, 7.5, 30), arc('Slalom 2 (right)', 'right', 25, 15, 30), arc('Slalom 3 (left)', 'left', 25, 15, 30),
          arc('Slalom 4 (right)', 'right', 25, 15, 30), arc('Slalom 5 (left)', 'left', 25, 15, 30), arc('Slalom 6 (right, exit)', 'right', 25, 7.5, 30),
          seg('Accelerate 30–40', 50, 30, 40), seg('Brake 40–25', 25, 40, 25),
          // Offset gates: a quick jog out and back, first to the left, then the mirror image to the right.
          arc('Offset gate A1 (left)', 'left', 18, 12, 25), arc('Offset gate A2 (right)', 'right', 18, 24, 25), arc('Offset gate A3 (left)', 'left', 18, 12, 25),
          seg('Between the gates', 20, 25, 25),
          arc('Offset gate B1 (right)', 'right', 18, 12, 25), arc('Offset gate B2 (left)', 'left', 18, 24, 25), arc('Offset gate B3 (right)', 'right', 18, 12, 25),
          seg('Accelerate 25–35', 40, 25, 35),
          arc('Left sweeper (90°)', 'left', 40, sweep, 35), seg('Short straight', 30, 35, 35), arc('Right sweeper (90°)', 'right', 40, sweep, 35),
          seg('Stop box 35–0', 30, 35, 0),
        ],
      };
    },
  },
  {
    label: 'Pothole while braking in a turn',
    make: () => ({
      name: 'Pothole while braking in a turn', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', ...MAXIMUMS, enabled: true, ride: true, handling: true,
      segments: [
        newSegment({ name: 'Braking left turn + pothole', path: 'left', radius: f(45, 'distance'), distance: f(35, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed'), features: [{ ...newFeature('pothole', 15), height: f(40, 'length') }] }),
      ],
    }),
  },
  {
    label: 'Hills: incline left, lumpy decline right',
    make: () => ({
      name: 'Hills', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', ...MAXIMUMS, enabled: true, ride: true, handling: true,
      segments: [
        newSegment({ name: 'Flat straight', distance: f(100, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(40 * MPH, 'speed') }),
        newSegment({ name: 'Bumps + potholes straight', distance: f(60, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(40 * MPH, 'speed'), features: [{ ...newFeature('bump', 15), side: 'left' }, newFeature('pothole', 35)] }),
        newSegment({ name: 'Into the climb', transition: true, distance: f(15, 'distance'), speedStart: f(40 * MPH, 'speed'), speedEnd: f(35 * MPH, 'speed') }),
        newSegment({ name: 'Incline left turn', path: 'left', radius: f(40, 'distance'), grade: f(10, 'percent'), distance: f(60, 'distance'), speedStart: f(35 * MPH, 'speed'), speedEnd: f(35 * MPH, 'speed') }),
        newSegment({ name: 'Crest', transition: true, distance: f(30, 'distance'), speedStart: f(35 * MPH, 'speed'), speedEnd: f(35 * MPH, 'speed') }),
        newSegment({ name: 'Lumpy decline right turn', path: 'right', radius: f(40, 'distance'), grade: f(-10, 'percent'), rough: { on: true, seed: 42, maxHeight: f(25, 'length'), scale: f(1.2, 'distance'), coverage: f(70, 'percent') }, distance: f(60, 'distance'), speedStart: f(35 * MPH, 'speed'), speedEnd: f(35 * MPH, 'speed') }),
      ],
    }),
  },
  {
    label: 'Drag strip: a quarter mile from standing',
    make: () => ({
      name: 'Drag strip', checks: cloneProfile(PROFILES.drag.checks), profile: 'drag', rank: 1, onFail: 'report', ...GRIP_ONLY, enabled: true, ride: true, handling: true,
      // Grip only: the set speeds don't cap it (the powertrain, drag and rolling resistance do; without a
      // powertrain the 250 km/h top speed).
      segments: [newSegment({ name: 'Quarter mile', distance: f(402.3, 'distance'), speedStart: f(0, 'speed'), speedEnd: f(250 / 3.6, 'speed') })],
    }),
  },
  {
    label: 'Rally stage: turns on a rough surface, a crest',
    make: () => {
      const rough = (seed: number, h = 30) => ({ on: true, seed, maxHeight: f(h, 'length'), scale: f(2, 'distance'), coverage: f(70, 'percent') });
      return {
        name: 'Rally stage', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', ...GRIP_ONLY, enabled: true, ride: true, handling: true,
        segments: [
          newSegment({ name: 'Launch', distance: f(80, 'distance'), speedStart: f(0, 'speed'), speedEnd: f(70 / 3.6, 'speed'), rough: rough(11, 20) }),
          newSegment({ name: 'Fast left', path: 'left', radius: f(60, 'distance'), distance: f(70, 'distance'), speedStart: f(70 / 3.6, 'speed'), speedEnd: f(70 / 3.6, 'speed'), rough: rough(12) }),
          newSegment({ name: 'Up to the crest', transition: true, distance: f(8, 'distance'), speedStart: f(80 / 3.6, 'speed'), speedEnd: f(80 / 3.6, 'speed') }),
          newSegment({ name: 'Crest', grade: f(8, 'percent'), distance: f(40, 'distance'), speedStart: f(80 / 3.6, 'speed'), speedEnd: f(80 / 3.6, 'speed'), rough: rough(13, 20) }),
          newSegment({ name: 'Over the crest', transition: true, distance: f(8, 'distance'), speedStart: f(80 / 3.6, 'speed'), speedEnd: f(80 / 3.6, 'speed') }),
          newSegment({ name: 'Downhill', grade: f(-8, 'percent'), distance: f(40, 'distance'), speedStart: f(80 / 3.6, 'speed'), speedEnd: f(40 / 3.6, 'speed'), rough: rough(14) }),
          newSegment({ name: 'Off the hill', transition: true, distance: f(8, 'distance'), speedStart: f(40 / 3.6, 'speed'), speedEnd: f(40 / 3.6, 'speed') }),
          newSegment({ name: 'Tight right', path: 'right', radius: f(25, 'distance'), distance: f(40, 'distance'), speedStart: f(40 / 3.6, 'speed'), speedEnd: f(40 / 3.6, 'speed'), rough: rough(15, 40) }),
          newSegment({ name: 'Straight', distance: f(100, 'distance'), speedStart: f(40 / 3.6, 'speed'), speedEnd: f(80 / 3.6, 'speed'), rough: rough(16) }),
          newSegment({ name: 'Medium left', path: 'left', radius: f(40, 'distance'), distance: f(60, 'distance'), speedStart: f(55 / 3.6, 'speed'), speedEnd: f(55 / 3.6, 'speed'), rough: rough(17, 35) }),
        ],
      };
    },
  },
  {
    label: 'Oval: banked turns (short NASCAR-style track)',
    make: () => {
      // A half-mile-style oval: two 180° left turns banked 24° (R 75 m), straights banked 5°, counter-clockwise.
      const turn = (name: string) => newSegment({ name, path: 'left', radius: f(75, 'distance'), bank: f(24, 'angle'), distance: f(Math.PI * 75, 'distance'), speedStart: f(75 * MPH, 'speed'), speedEnd: f(75 * MPH, 'speed') });
      const straight = (name: string) => newSegment({ name, bank: f(5, 'angle'), distance: f(150, 'distance'), speedStart: f(75 * MPH, 'speed'), speedEnd: f(85 * MPH, 'speed') });
      const brake = (name: string) => newSegment({ name, bank: f(5, 'angle'), distance: f(60, 'distance'), speedStart: f(85 * MPH, 'speed'), speedEnd: f(75 * MPH, 'speed') });
      return {
        name: 'Oval: banked turns', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', ...MAXIMUMS, enabled: true, ride: true, handling: true,
        segments: [straight('Front straight'), brake('Brake into turn 1'), turn('Turns 1–2 (24° banking)'), straight('Back straight'), brake('Brake into turn 3'), turn('Turns 3–4 (24° banking)')],
      };
    },
  },
  {
    label: 'Balanced: equal left / right turns, braking, a small hill',
    make: () => {
      // Loads every corner about evenly: two left and two right 90° turns of the same radius and speed,
      // each braked into and accelerated out of, plus a 6 % incline (accelerating) and decline (braking).
      const turn = (name: string, path: 'left' | 'right') => newSegment({ name, path, radius: f(30, 'distance'), distance: f((Math.PI / 2) * 30, 'distance'), speedStart: f(30 * MPH, 'speed'), speedEnd: f(30 * MPH, 'speed') });
      const seg = (name: string, d: number, v0: number, v1: number, grade = 0) => newSegment({ name, distance: f(d, 'distance'), speedStart: f(v0 * MPH, 'speed'), speedEnd: f(v1 * MPH, 'speed'), grade: f(grade, 'percent') });
      return {
        name: 'Balanced', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', ...GRIP_ONLY, enabled: true, ride: true, handling: true,
        segments: [
          seg('Launch 0–50', 80, 0, 50), seg('Brake 50–30', 25, 50, 30), turn('Left turn 1', 'left'),
          seg('Accelerate 30–45', 50, 30, 45), seg('Brake 45–30', 20, 45, 30), turn('Right turn 1', 'right'),
          { ...seg('Into the hill', 10, 30, 30), transition: true }, seg('Uphill 6 %, accelerate 30–40', 60, 30, 40, 6),
          { ...seg('Over the top', 20, 40, 40), transition: true }, seg('Downhill 6 %, brake 40–30', 60, 40, 30, -6),
          { ...seg('Off the hill', 10, 30, 30), transition: true }, turn('Left turn 2', 'left'), seg('Accelerate 30–45', 50, 30, 45), seg('Brake 45–30', 20, 45, 30), turn('Right turn 2', 'right'),
          seg('Exit 30–50', 60, 30, 50),
        ],
      };
    },
  },
  { label: 'Empty test', make: () => ({ name: 'New test', checks: defaultChecks(), profile: 'default', rank: 1, onFail: 'report', ...MAXIMUMS, enabled: true, ride: true, handling: true, segments: [newSegment()] }) },
];

/**
 * Optimizer weight of a priority rank among n items: n + 1 − rank (rank 1 of 2 → 2, rank 2 → 1, so 2 : 1).
 * Equal ranks weigh the same.
 */
export const rankWeight = (rank: number, n: number) => Math.max(1, n + 1 - Math.min(Math.max(1, Math.round(rank)), n));

/** Core spec of a segment, with the checks that apply to it. */
/** A transition's grades (%, from → to): the nearest segments before and after it that aren't transitions (level when none). */
export function transitionGrades(test: Pick<TestDesign, 'segments'> | undefined, s: TestSegment): { from: number; to: number } {
  const segs = test?.segments ?? [];
  const i = segs.findIndex((x) => x.id === s.id);
  const near = (step: number) => { for (let j = i + step; j >= 0 && j < segs.length; j += step) if (!segs[j]!.transition) return segs[j]!.grade.value; return 0; };
  return i < 0 ? { from: s.grade.value, to: s.grade.value } : { from: near(-1), to: near(1) };
}

export function segmentSpec(s: TestSegment, test?: TestDesign): TestSegmentSpec {
  const tr = s.transition ? transitionGrades(test, s) : null;
  return {
    checks: s.checks ?? test?.checks,
    weight: rankWeight(s.rank, test?.segments.length ?? 1),
    name: s.name,
    distance: Math.max(s.distance.value, 0.01),
    v0: Math.max(0, s.speedStart.value),
    v1: Math.max(0, s.speedEnd.value),
    path: s.path,
    // The racing line (with a track width): the turn taken on the widest arc the width allows.
    radius: Math.min(1e5, test?.racingLine && s.path !== 'straight' && s.width && s.width.value > 0
      ? racingLineRadius(Math.max(s.radius.value, 0.01), Math.max(s.distance.value, 0.01), s.width.value)
      : Math.max(s.radius.value, 0.01)),
    latG: isOff(s.latG) ? null : s.latG.value,
    longG: isOff(s.longG) ? null : s.longG.value,
    grade: Math.atan((tr ? tr.from : s.grade.value) / 100),
    ...(tr ? { gradeEnd: Math.atan(tr.to / 100) } : {}),
    bank: (s.bank.value * Math.PI) / 180,
    bumps: Object.fromEntries(CORNER_IDS.filter((id) => s.bumps[id].value !== 0).map((id) => [id, s.bumps[id].value])),
    samples: 3,
    road: roadSpecOf(s),
    ...(s.coast ? { coast: true } : {}),
    ...(styleOf(test, s) ? { style: styleOf(test, s)! } : {}),
  };
}

/** The driving style a segment is driven with: the test's, or by its pass rules (Auto). */
export function styleOf(test: TestDesign | undefined, s?: TestSegment): DrivingStyle | undefined {
  if (!test) return undefined;
  if (test.style === 'none') return undefined;
  if (test.style) return test.style;
  return STYLE_BY_PROFILE[(s?.profile ?? test.profile) as string];
}
export const STYLE_BY_PROFILE: Record<string, DrivingStyle | undefined> = { drift: 'drift', offroad: 'rally', drag: 'drag' };
export const STYLE_LABEL: Record<'none' | DrivingStyle, string> = { none: 'One pedal at a time', drift: 'Drift (handbrake into turns)', rally: 'Rally (left-foot braking)', drag: 'Drag (line-lock launch)' };

/** The segment's road (rough surface + features) for the core. */
export function roadSpecOf(s: TestSegment): RoadSpec | undefined {
  const rough = s.rough.on ? { seed: s.rough.seed, maxHeight: Math.max(0, s.rough.maxHeight.value), scale: Math.max(0.05, s.rough.scale.value), coverage: Math.min(1, Math.max(0, s.rough.coverage.value / 100)) } : null;
  const features = s.features.map((x) => ({ kind: x.kind, at: x.at.value, length: Math.max(0, x.length.value), height: Math.max(0, x.height.value), side: x.side }));
  return rough || features.length ? { rough, features } : undefined;
}

/**
 * Load cases for the optimizer from tests: every segment's speed samples, each with weight
 * (test priority × segment priority, from their ranks) and the segment's pass rules.
 * `source`: a test id, or 'all' for every enabled test (weighted by its priority rank).
 */
/**
 * `plans`: per test id, the speeds its last run planned per segment (speeds as maximums): its states are then
 * taken at those speeds, not at the set maximums (which the car may never be driven at).
 */
export function statesForTests(tests: TestDesign[], source: string, dims?: CarDims, plans?: Record<string, (SegmentPlan | undefined)[] | undefined>): RoadState[] {
  const chosen = source === 'all' ? tests.filter((t) => t.enabled !== false) : tests.filter((t) => t.id === source);
  const tw = (t: TestDesign) => (source === 'all' ? rankWeight(t.rank, chosen.length) : 1);
  const totalPriority = chosen.reduce((a, t) => a + tw(t), 0) || 1;
  const out: RoadState[] = [];
  for (const t of chosen) {
    const tp = tw(t) / totalPriority;
    const planned = plannedSpeeds(t) ? plans?.[t.id] : undefined;
    const specs = t.segments.map((sg, i) => { const sp = segmentSpec(sg, t); const pl = planned?.[i]; return pl && pl.s.length > 1 ? { ...sp, plan: pl } : sp; });
    const segTotal = specs.reduce((a, sp) => a + (sp.weight ?? 1), 0) || 1;
    specs.forEach((sp, i) => {
      const st = segmentStates(sp, i, 1, dims);
      for (const x of st) out.push({ ...x, name: `${t.name} ${x.name}`, weight: (tp * (sp.weight ?? 1) / segTotal) * specs.length / st.length, checks: sp.checks });
    });
  }
  return out;
}
