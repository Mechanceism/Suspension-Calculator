import { describe, expect, it } from 'vitest';
import { rideRun } from '../src/core/tests/ride';
import { course } from '../src/core/tests/course';
import type { AppState } from '../src/app/store';
import { defaultDesign } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import type { SegmentSpec } from '../src/core/tests/segments';

// Over a change of grade the car pitches as its wheelbase passes it, so both axles stay on the road as drawn
// (user review 6: past a crest the rear sank into the road while the grade eased over a fixed 0.3 s).
describe('grade over a hill: the slope between the axles', () => {
  it('keeps the rear axle on the road through a 6 % up / 6 % down hill', () => {
    const p = buildVehicleProblem(defaultDesign() as unknown as AppState).problem;
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const seg = (o: Partial<SegmentSpec>): SegmentSpec => ({ distance: 30, v0: 10, v1: 10, path: 'straight', radius: 0, grade: 0, bank: 0, ...o });
    const g = Math.atan(0.06);
    const segs = [seg({}), seg({ grade: g }), seg({ grade: -g }), seg({})];
    const run = rideRun(p, geoms, segs, { hz: 50 });
    const pts = course(segs, 0.25);
    const starts = [0, 30, 60, 90];
    const zAt = (S: number) => {
      if (S <= 0) return 0;
      let k = 0;
      while (k + 1 < pts.length && pts[k + 1]!.total <= S) k++;
      const a = pts[k]!, b = pts[Math.min(pts.length - 1, k + 1)]!;
      return b.total > a.total ? a.z + ((b.z - a.z) * (S - a.total)) / (b.total - a.total) : a.z;
    };
    const wb = p.wheelbase / 1000;
    let worst = 0;
    for (const f of run.frames) {
      const S = starts[f.segment]! + f.s;
      // The car pivoted about its front axle (on the road at S) by the frame's grade: where its rear axle is.
      const rear = zAt(S) - wb * Math.sin(f.grade);
      worst = Math.max(worst, Math.abs(rear - zAt(S - wb)));
    }
    expect(worst).toBeLessThan(0.002); // within 2 mm
    // Half a wheelbase past the crest it is level (halfway between +6 % and −6 %).
    const near = run.frames.reduce((b, f) => (Math.abs(starts[f.segment]! + f.s - (60 + wb / 2)) < Math.abs(starts[b.segment]! + b.s - (60 + wb / 2)) ? f : b));
    expect(Math.abs(near.grade)).toBeLessThan(0.012);
  }, 120000);
});
