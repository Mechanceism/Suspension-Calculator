/**
 * How good a test run is, as one number (lower is better), for the optimizers:
 *   100 · (Fail findings geometry or setup can fix) + 10 · Σ grip use over 100 % (+ average grip use
 *   when improving) + the ride measures (smooth, so a tuner can tell better from worse before anything
 *   passes or fails): 5 · bump-stop time (s) + 20 · tire-load variation
 *   + 0.2 · body vertical acceleration RMS (m/s²) + (handling) 2 · largest distance off the line (m)
 *   + 0.1 · largest sideslip (deg); with the Test time goal, + its weight · 100 · time ÷ the starting time.
 */
import type { TestRun } from './run';
import type { RideMeasures } from './ride';
import type { Finding } from './checks';

const UNFIXABLE = new Set(['beyondGrip', 'rollover', 'noSolution', 'steerLimit', 'brakeLimit']);

/** A failure no change of suspension points, springs or dampers can fix. */
export const isUnfixable = (f: Pick<Finding, 'check' | 'text'>) =>
  UNFIXABLE.has(f.check) || (f.check === 'speedNotReached' && /No (powered|braked) wheels/.test(f.text));

/** Ride part of the score (0 without a ride). */
export function rideScore(m: RideMeasures | undefined): number {
  if (!m) return 0;
  // Wheel lift is noted, not scored (round 4): a lap that lifts a wheel but is faster isn't punished for it
  // (a Fail rule still fails it).
  return 5 * m.bumpStopTime + 20 * m.loadVariation + 0.2 * m.heaveAccRms
    + 2 * (m.maxPathError ?? 0) + 0.1 * (m.maxSideslip ?? 0);
}

/**
 * A lap test's ride part (round 4, F9): a lap test (planned speeds) is judged on how long it took as driven — a
 * setup that bounces or slides is slower by itself, and the pass rules judge running off the line — so of the
 * ride only the time on the bump stops stays, at a tenth of its weight, as a tie-breaker.
 */
export function lapRideScore(m: RideMeasures | undefined): number {
  return m ? 0.5 * m.bumpStopTime : 0;
}

/** A lap test: its speeds were planned (it has a time). */
export const isLapRun = (r: TestRun) => r.time !== undefined;

/**
 * `time` (planned speeds): + weight · 100 · time ÷ the reference time (the test's time when the optimizing
 * began), so 1 % faster is `weight` points better; a Fail still costs 100. Lap tests (planned speeds) take the
 * lap ride part (lapRideScore); tests at set speeds keep the full ride part.
 */
export function testScore(r: TestRun, mode: 'pass' | 'improve' | 'explore', time?: { weight: number; ref?: number }): number {
  const fails = r.segments.flatMap((s) => s.findings).filter((f) => f.severity === 'fail' && !isUnfixable(f)).length;
  const over = r.states.reduce((a, s) => a + Math.max(0, (s.grip?.maxUtilization ?? 1) - 1), 0);
  const avg = r.states.reduce((a, s) => a + (s.grip?.maxUtilization ?? 1), 0) / Math.max(r.states.length, 1);
  const timed = time && time.weight > 0 && r.time && r.time > 0 ? (time.weight * 100 * r.time) / (time.ref && time.ref > 0 ? time.ref : r.time) : 0;
  const ride = isLapRun(r) ? lapRideScore(r.ride?.metrics) : rideScore(r.ride?.metrics);
  return (mode === 'improve' ? 100 * fails + 10 * over + avg : 100 * fails + 10 * over + 0.01 * avg) + ride + timed;
}
