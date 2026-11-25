/**
 * What the car is for (round 4, F20): one choice sets the tests, their pass rules and what the optimizer counts,
 * so it chases what matters for that use (a lap time on a track; ride and steering on the road; travel off-road…).
 * Applying adds the use case's preset tests that are missing and turns them on; the other tests are turned off,
 * not deleted. Chosen in the setup wizard (its first step) or in Tests → Optimize; saved with the design.
 */
import { useApp, type DesignState } from './store';
import { TEST_PRESETS, newTestId, type TestDesign } from './tests';
import { PROFILES, cloneProfile, type BuiltinProfile } from '../core/tests/checks';
import type { VehicleGoalKind } from '../core/optimize/vehicle';

export type UseCase = 'track' | 'road' | 'offroad' | 'drift' | 'towing' | 'drag';

export interface UseCaseSpec {
  id: UseCase;
  label: string;
  hint: string;
  /** Test presets (labels start with these), their speeds, and their pass rules. */
  tests: string[];
  speedMode: 'grip' | 'max';
  profile: BuiltinProfile;
  /** How much the lap time counts (Tests → Optimize: Time weight). */
  timeWeight: number;
  /** Optimizer goals switched on (the rest of the extra goals off). */
  goals: VehicleGoalKind[];
  /** Towing: the trailer switched on. */
  trailer?: boolean;
}

/** The goals a use case may switch on or off (the test goals are the optimize loop's own). */
const EXTRA_GOALS: VehicleGoalKind[] = ['steeringEffort', 'parkingEffort', 'scrubLimit', 'bumpSteer'];

export const USE_CASES: UseCaseSpec[] = [
  { id: 'track', label: 'Autocross / track', hint: 'Fastest around a course: lap tests at the grip limit (Grip only), scored on how long they take; the ride counts only as a tie-breaker.',
    tests: ['Autocross (simple)', 'Autocross (complex)', 'Balanced'], speedMode: 'grip', profile: 'track', timeWeight: 1, goals: [] },
  { id: 'road', label: 'Road car', hint: 'Comfort and safety at everyday speeds: the tests at their set speeds (Maximums) with the street pass rules; the ride, steering effort, scrub radius and bump steer count; time a little.',
    tests: ['Balanced', 'Pothole while braking', 'Hills'], speedMode: 'max', profile: 'street', timeWeight: 0.25, goals: ['steeringEffort', 'scrubLimit', 'bumpSteer'] },
  { id: 'offroad', label: 'Off-road', hint: 'Rough ground and hills: travel and bump stops matter, a wheel lifting is fine; time counts half.',
    tests: ['Hills', 'Rally stage'], speedMode: 'grip', profile: 'offroad', timeWeight: 0.5, goals: [] },
  { id: 'drift', label: 'Drift', hint: 'Sliding on purpose: the Drift pass rules (a wider lane, slides and wheelspin noted); lap tests scored on time.',
    tests: ['Autocross (simple)', 'Autocross (complex)'], speedMode: 'grip', profile: 'drift', timeWeight: 1, goals: [] },
  { id: 'towing', label: 'Towing / utility', hint: 'Pulling a trailer: the trailer switched on (Vehicle → Towing), hills and turns at their set speeds with the street pass rules; hitch load and sway are checked; time a little.',
    tests: ['Hills', 'Balanced'], speedMode: 'max', profile: 'street', timeWeight: 0.25, goals: [], trailer: true },
  { id: 'drag', label: 'Drag', hint: 'Straight-line acceleration: a quarter mile from standing, scored on how long it takes; the front lifting is fine, the rear stepping out is not.',
    tests: ['Drag strip'], speedMode: 'grip', profile: 'drag', timeWeight: 1, goals: [] },
];

export const useCaseSpec = (id: UseCase | undefined) => USE_CASES.find((u) => u.id === id);

/** What applying a use case does to a design (pure, for tests): the tests, their rules, the goals, the trailer. */
export function withUseCase(d: Pick<DesignState, 'tests' | 'vehicleOptimizer' | 'tow'>, id: UseCase): Pick<DesignState, 'tests' | 'vehicleOptimizer' | 'tow'> & { useCase: UseCase } {
  const u = useCaseSpec(id)!;
  const tests: TestDesign[] = d.tests.map((t) => ({ ...t, enabled: false }));
  for (const prefix of u.tests) {
    const make = (t: TestDesign) => ({
      ...t, enabled: true, speedMode: u.speedMode, gripTarget: t.gripTarget ?? 0.95,
      profile: u.profile, checks: cloneProfile(PROFILES[u.profile].checks),
    });
    const i = tests.findIndex((t) => t.name.startsWith(prefix.split(' (')[0]!) && (!prefix.includes('(') || t.name === prefix));
    if (i >= 0) tests[i] = make(tests[i]!);
    else {
      const preset = TEST_PRESETS.find((p) => p.label.startsWith(prefix));
      if (preset) tests.push(make({ ...preset.make(), id: newTestId('test') }));
    }
  }
  const goals = { ...d.vehicleOptimizer.goals };
  for (const k of EXTRA_GOALS) goals[k] = { ...goals[k], on: u.goals.includes(k) };
  goals.testTime = { ...goals.testTime, on: true, weight: { text: String(u.timeWeight), value: u.timeWeight } };
  return { useCase: id, tests, vehicleOptimizer: { ...d.vehicleOptimizer, goals }, tow: { ...d.tow, on: u.trailer ? true : d.tow.on } };
}

/** Apply a use case to the current design. */
export function applyUseCase(id: UseCase) {
  useApp.setState(withUseCase(useApp.getState(), id));
}
