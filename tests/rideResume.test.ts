import { describe, expect, it } from 'vitest';
import { rideRun, joinRide } from '../src/core/tests/ride';
import type { AppState } from '../src/app/store';
import { carProfileDesign } from '../src/app/carProfiles';
import { buildVehicleProblem } from '../src/app/optimizer';
import { TEST_PRESETS, segmentSpec } from '../src/app/tests';

// Resuming the ride over time from the state saved at a segment's start gives exactly what driving the
// whole test again gives (the ladder of speeds as maximums reruns only from where its plan changed).
describe('ride over time resumed from a segment', () => {
  const p = buildVehicleProblem(carProfileDesign('kart') as unknown as AppState).problem;
  const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Balanced'))!.make(), id: 'x' };
  const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
  const specs = t.segments.map((s) => segmentSpec(s, t as never));
  const o = { handling: true, driverSpeed: true };

  it('matches the full run from the resumed segment on (frames, findings, measures), and can stop early', () => {
    const full = rideRun(p, geoms, specs, o);
    expect(full.checkpoints?.length).toBe(specs.length + 1);
    const k = 3;
    const cp = full.checkpoints![k]!;
    expect(cp.segment).toBe(k);
    const rest = rideRun(p, geoms, specs, { ...o, resume: cp });
    expect(rest.frames[0]!.t).toBeGreaterThan(full.frames[cp.frameCount - 1]!.t);
    const joined = joinRide(full, rest, k);
    expect(joined.frames).toEqual(full.frames);
    expect(joined.findings).toEqual(full.findings);
    expect(joined.metrics).toEqual(full.metrics);
    // Stopping after a segment: the same up to it, nothing after.
    const part = rideRun(p, geoms, specs, { ...o, resume: cp, stopAfter: k + 1 });
    expect(part.findings.slice(k, k + 2)).toEqual(full.findings.slice(k, k + 2));
    expect(part.findings.slice(k + 2).every((f) => f.length === 0)).toBe(true);
    expect(part.checkpoints![k + 2]!.state).toEqual(full.checkpoints![k + 2]!.state);
    // A run resumed from that one's end carries on exactly as the full run.
    const tail = rideRun(p, geoms, specs, { ...o, resume: part.checkpoints![k + 2]! });
    expect(joinRide(joinRide(full, part, k), tail, k + 2).frames).toEqual(full.frames);
  }, 120000);
});
