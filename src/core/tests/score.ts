/**
 * How good a test run is, as one number (lower is better), for the optimizers:
 *   100 · (Fail findings geometry or setup can fix) + 10 · Σ grip use over 100 % (+ average grip use
 *   when improving) + the ride measures (smooth, so a tuner can tell better from worse before anything
 *   passes or fails): 10 · wheel-lift time (s) + 5 · bump-stop time (s) + 20 · tire-load variation
 *   + 0.2 · body vertical acceleration RMS (m/s²).
 */
import type { TestRun } from './run';
import type { RideMeasures } from './ride';
import type { Finding } from './checks';

const UNFIXABLE = new Set(['beyondGrip', 'rollover', 'noSolution', 'steerLimit']);

/** A failure no change of suspension points, springs or dampers can fix. */
export const isUnfixable = (f: Pick<Finding, 'check' | 'text'>) =>
  UNFIXABLE.has(f.check) || (f.check === 'speedNotReached' && /No (powered|braked) wheels/.test(f.text));

/** Ride part of the score (0 without a ride). */
export function rideScore(m: RideMeasures | undefined): number {
  if (!m) return 0;
  return 10 * m.liftTime + 5 * m.bumpStopTime + 20 * m.loadVariation + 0.2 * m.heaveAccRms;
}

export function testScore(r: TestRun, mode: 'pass' | 'improve' | 'explore'): number {
  const fails = r.segments.flatMap((s) => s.findings).filter((f) => f.severity === 'fail' && !isUnfixable(f)).length;
  const over = r.states.reduce((a, s) => a + Math.max(0, (s.grip?.maxUtilization ?? 1) - 1), 0);
  const avg = r.states.reduce((a, s) => a + (s.grip?.maxUtilization ?? 1), 0) / Math.max(r.states.length, 1);
  return (mode === 'improve' ? 100 * fails + 10 * over + avg : 100 * fails + 10 * over + 0.01 * avg) + rideScore(r.ride?.metrics);
}
