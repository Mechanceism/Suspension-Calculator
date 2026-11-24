/**
 * Test results saved with a model-and-tests file (R9, snapshots): the scores only — pass / fail, the time
 * and average speed, each segment's severity, grip use, time and findings. No paths, planned speeds or
 * playback frames: running the same inputs again gives the same run (and a run that comes out different
 * means the calculator changed, so the results should be refreshed anyway).
 */
import type { TestRun } from '../core/tests/run';
import type { Severity } from '../core/tests/checks';

export interface SavedFinding { check: string; severity: Severity; text: string }
export interface SavedSegment {
  severity: Severity;
  passed: boolean;
  maxUtilization: number;
  findings: SavedFinding[];
  /** Speeds as maximums: its time (s), the driver's push (0–1) and the way it was taken. */
  time?: number;
  gripTarget?: number;
  approach?: string;
}
export interface SavedResult {
  /** The test's name when it ran (the results are keyed by test id). */
  name: string;
  severity: Severity;
  passed: boolean;
  /** Speeds as maximums: the time over the test (s) and its distance (m). */
  time?: number;
  distance?: number;
  segments: SavedSegment[];
  /** When it ran (ISO), if known. */
  ranAt?: string;
}

const SEVERITIES: Severity[] = ['pass', 'warn', 'fail'];
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const sev = (x: unknown): Severity => (SEVERITIES.includes(x as Severity) ? (x as Severity) : 'pass');

/** A run's scores, as saved. */
export function saveResult(name: string, r: TestRun, ranAt?: string): SavedResult {
  return {
    name, severity: r.severity, passed: r.passed,
    ...(finite(r.time) ? { time: r.time } : {}), ...(finite(r.distance) ? { distance: r.distance } : {}),
    segments: r.segments.map((s) => ({
      severity: s.severity, passed: s.passed, maxUtilization: finite(s.maxUtilization) ? s.maxUtilization : 0,
      findings: s.findings.map((f) => ({ check: f.check, severity: f.severity, text: f.text })),
      ...(finite(s.time) ? { time: s.time } : {}), ...(finite(s.gripTarget) ? { gripTarget: s.gripTarget } : {}),
      ...(s.approach ? { approach: s.approach } : {}),
    })),
    ...(ranAt ? { ranAt } : {}),
  };
}

/** Saved results read back (anything malformed left out). */
export function readResults(raw: unknown): Record<string, SavedResult> {
  const out: Record<string, SavedResult> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    if (!Array.isArray(r.segments)) continue;
    out[id] = {
      name: typeof r.name === 'string' ? r.name : id, severity: sev(r.severity), passed: r.passed === true,
      ...(finite(r.time) ? { time: r.time } : {}), ...(finite(r.distance) ? { distance: r.distance } : {}),
      segments: (r.segments as unknown[]).map((x) => {
        const s = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
        return {
          severity: sev(s.severity), passed: s.passed === true, maxUtilization: finite(s.maxUtilization) ? s.maxUtilization : 0,
          findings: Array.isArray(s.findings) ? (s.findings as unknown[]).filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
            .map((f) => ({ check: String(f.check ?? ''), severity: sev(f.severity), text: String(f.text ?? '') })) : [],
          ...(finite(s.time) ? { time: s.time } : {}), ...(finite(s.gripTarget) ? { gripTarget: s.gripTarget } : {}),
          ...(typeof s.approach === 'string' ? { approach: s.approach } : {}),
        };
      }),
      ...(typeof r.ranAt === 'string' ? { ranAt: r.ranAt } : {}),
    };
  }
  return out;
}
