import { describe, expect, it } from 'vitest';
import { runTest } from '../src/core';
import type { AppState } from '../src/app/store';
import { carProfileDesign } from '../src/app/carProfiles';
import { buildVehicleProblem } from '../src/app/optimizer';
import { TEST_PRESETS, segmentSpec } from '../src/app/tests';

// The kart on Balanced: its rear-only brakes lock in "Brake 50–30", it enters the first turn sliding and
// spends the next straight at full lock getting back to the line (user review 4).
describe('driver messages say what the driver is doing', () => {
  const p = buildVehicleProblem(carProfileDesign('kart') as unknown as AppState).problem;
  const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Balanced'))!.make(), id: 'x' };
  const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
  const specs = t.segments.map((s) => segmentSpec(s, t as never));
  const idx = (name: string) => t.segments.findIndex((s) => s.name === name);

  it('full lock on a straight while recovering is reported as getting back to the line, not a too-tight turn', () => {
    const run = runTest(p, geoms, specs, { onFail: 'report', ride: true, handling: true });
    const straight = run.segments[idx('Accelerate 30–45')]!.findings.filter((f) => f.check === 'steerLimit');
    expect(straight.length).toBeGreaterThan(0);
    expect(straight[0]!.text).toMatch(/^Steering at full lock to get back to the line \(\d+\.\d\d m (left|right) of it\)/);
    expect(straight[0]!.text).toContain('on a straight');
    expect(straight[0]!.text).not.toContain('Too tight');
  }, 120000);

  it('the pedal driver "slows down to stay on the line" and the lowest speed is given', () => {
    const run = runTest(p, geoms, specs, { onFail: 'report', ride: true, handling: true, driverSpeed: true });
    const f = run.segments[idx('Left turn 1')]!.findings.find((x) => x.check === 'speedNotReached');
    expect(f?.text).toMatch(/^The driver slowed down to stay on the line \(for \d+\.\d s\): down to \d+ km\/h, \d+ km\/h at the end instead of \d+ km\/h/);
    expect(f?.text).not.toContain('lifted');
  }, 120000);
});
