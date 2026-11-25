import { describe, expect, it } from 'vitest';
import { defaultDesign } from '../src/app/store';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';
import { saveResult, readResults } from '../src/app/savedResults';
import type { TestRun } from '../src/core/tests/run';

// R9 snapshots: a model-and-tests file carries its tests' last results — scores only, no paths or frames.
describe('results saved with a model-and-tests file', () => {
  const run: TestRun = {
    severity: 'warn', passed: true, time: 43.6, distance: 613, states: [{ state: { name: 'x' } } as never],
    ride: { frames: [{ t: 0 } as never], metrics: {} as never },
    segments: [{
      index: 0, severity: 'warn', passed: true, maxUtilization: 0.91, impossible: false, steer: null, time: 7.4, gripTarget: 0.95, approach: 'plan',
      plan: { s: [0, 80], v: [0, 22] }, findings: [{ check: 'nearLimit', severity: 'warn', text: 'RL above 90 % grip use', corners: ['RL'] }],
    }],
  };

  it('keeps the scores and leaves out the states, frames and planned speeds', () => {
    const sv = saveResult('Balanced', run, '2026-11-24T12:00:00.000Z');
    expect(sv).toEqual({
      name: 'Balanced', severity: 'warn', passed: true, time: 43.6, distance: 613, ranAt: '2026-11-24T12:00:00.000Z',
      segments: [{ severity: 'warn', passed: true, maxUtilization: 0.91, time: 7.4, gripTarget: 0.95, approach: 'plan', findings: [{ check: 'nearLimit', severity: 'warn', text: 'RL above 90 % grip use' }] }],
    });
    expect(JSON.stringify(sv)).not.toMatch(/"frames"|"plan":|"states"|"ride"/);
  });

  it('round-trips through the project file; a model-only file and an older file have none', () => {
    const d = defaultDesign();
    const results = { t1: saveResult('Balanced', run) };
    const file = serializeProject(d, 'Car', { tests: true, results });
    expect(file.formatVersion).toBe(FORMAT_VERSION);
    expect(importProject(JSON.parse(JSON.stringify(file))).results).toEqual(results);
    expect(serializeProject(d, 'Car', { tests: false, results }).results).toBeUndefined();
    const old = { ...JSON.parse(JSON.stringify(serializeProject(d, 'Car'))), formatVersion: 42 };
    const r = importProject(old);
    expect(r.results).toEqual({});
    expect(r.warnings).toEqual(["Upgraded from file format 42 to 43.", "Upgraded from file format 43 to 44.", "Upgraded from file format 44 to 45.", "Upgraded from file format 45 to 46.", "Upgraded from file format 46 to 47."]);
  });

  it('reads back defensively', () => {
    expect(readResults(null)).toEqual({});
    expect(readResults({ a: { segments: 'no' } })).toEqual({});
    const r = readResults({ a: { severity: 'bogus', segments: [{ findings: [{ check: 'x' }] }] } });
    expect(r.a!.severity).toBe('pass');
    expect(r.a!.segments[0]!.findings[0]).toEqual({ check: 'x', severity: 'pass', text: '' });
  });
});
