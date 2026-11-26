import { describe, expect, it, vi } from 'vitest';
import type { TestRun } from '../src/core/tests/run';

// Round 5 (user): the Compare tab is now Results — the current design's vehicles, tests and setup character on
// their own; a snapshot is optional. Run without one, only the current design is driven, on its own tests.
const ran: string[] = [];
vi.mock('../src/app/optimizer', async (orig) => {
  const m = await orig<typeof import('../src/app/optimizer')>();
  return {
    ...m,
    runTestJob: (_p: unknown, segments: { name?: string }[]) => ({
      cancel() {},
      done: Promise.resolve().then((): TestRun => {
        ran.push(segments[0]?.name ?? '?');
        return { severity: 'pass', passed: true, states: [], time: 10, distance: 100, segments: [] };
      }),
    }),
  };
});

describe('Results without a snapshot', () => {
  it('runs the current design alone on its enabled tests; nothing for a snapshot', async () => {
    const { useApp, defaultDesign } = await import('../src/app/store');
    const { TEST_PRESETS } = await import('../src/app/tests');
    const { runCompare, useCompare, runKey } = await import('../src/app/compare');
    const { currentResult } = await import('../src/app/panels/TestsPanels');
    const d = defaultDesign();
    const tests = TEST_PRESETS.slice(0, 2).map((t, i) => ({ ...t.make(), id: `t${i}` }));
    useApp.getState().applyDesign({ ...d, tests } as never, null, null);
    expect(currentResult('t0')).toBeNull(); // never run in the Tests tab
    await runCompare(null);
    const c = useCompare.getState();
    expect(c.snapshotId).toBeNull();
    expect(c.rows.map((r) => r.from)).toEqual(['A', 'A']);
    expect(c.total).toBe(2);
    expect(ran.length).toBe(2);
    for (const row of c.rows) {
      expect(c.runs[runKey(row, 'A')]?.time).toBe(10);
      expect(c.runs[runKey(row, 'B')]).toBeUndefined();
    }
  });
});
