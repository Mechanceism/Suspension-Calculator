import { describe, expect, it } from 'vitest';
import { testScore } from '../src/core/tests/score';
import type { TestRun } from '../src/core/tests/run';
import { TEST_PRESETS, statesForTests } from '../src/app/tests';

// Optimizers scoring on time (user review 6, U4j): speeds as maximums are scored on the test's time too.
describe('scoring on time', () => {
  const run = (time: number, fails = 0): TestRun => ({
    severity: fails ? 'fail' : 'pass', passed: !fails, states: [], time, distance: 500,
    segments: [{ index: 0, severity: fails ? 'fail' : 'pass', passed: !fails, maxUtilization: 0.9, impossible: false, steer: null,
      findings: Array.from({ length: fails }, () => ({ check: 'understeer', severity: 'fail' as const, text: 'x' })) }],
  });

  it('1 % faster is `weight` points better; a Fail still costs 100; no goal, no time', () => {
    const ref = 50;
    const at = (t: number, w = 1, fails = 0) => testScore(run(t, fails), 'improve', { weight: w, ref });
    expect(at(50) - at(49.5)).toBeCloseTo(1, 9);
    expect(at(50, 3) - at(49.5, 3)).toBeCloseTo(3, 9);
    // Even 20 % faster doesn't buy a Fail back.
    expect(at(40, 1, 1)).toBeGreaterThan(at(50, 1, 0));
    expect(testScore(run(40), 'improve')).toBe(testScore(run(50), 'improve'));
    expect(testScore(run(40), 'improve', { weight: 0, ref })).toBe(testScore(run(50), 'improve'));
  });

  it('the geometry optimizer’s states are taken at the last run’s planned speeds (speeds as maximums)', () => {
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Balanced'))!.make(), id: 'b' };
    const set = statesForTests([t], 'b');
    // A plan driving every segment at 10 m/s.
    const plans = { b: t.segments.map(() => ({ s: [0, 50, 100], v: [10, 10, 10] })) };
    const planned = statesForTests([t], 'b', undefined, plans);
    expect(Math.max(...set.map((s) => s.speed))).toBeGreaterThan(15);
    expect(planned.every((s) => Math.abs(s.speed - 10) < 1e-9)).toBe(true);
    // Holding the set speeds: the plans aren't used.
    const held = statesForTests([{ ...t, speedMode: 'hold' }], 'b', undefined, plans);
    expect(held.map((s) => s.speed)).toEqual(set.map((s) => s.speed));
  });
});
