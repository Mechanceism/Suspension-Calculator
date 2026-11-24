import { describe, it, expect } from 'vitest';
import { course, courseRoadHeight, placeOnCourse, trackPath } from '../src/core';

const straight = (d: number, extra = {}) => ({ distance: d, path: 'straight' as const, radius: 0, grade: 0, bank: 0, ...extra });
const arc = (d: number, r: number, path: 'left' | 'right', extra = {}) => ({ distance: d, path, radius: r, grade: 0, bank: 0, ...extra });

describe('the course in 3D', () => {
  it('straights and exact arcs; heights from the grades; ends join; the same as the track map', () => {
    const R = 20;
    const segs = [straight(50), arc((Math.PI / 2) * R, R, 'left'), straight(30, { grade: Math.atan(0.1) }), arc(Math.PI * 10, 10, 'right', { bank: 0.2 })];
    const pts = course(segs);
    const end = pts.at(-1)!;
    expect(end.total).toBeCloseTo(50 + (Math.PI / 2) * R + 30 + Math.PI * 10, 9);
    // After the 90° left arc: heading π/2, the corner at (50 + R, R).
    const afterArc = pts.filter((p) => p.segment === 1).at(-1)!;
    expect(afterArc.heading).toBeCloseTo(Math.PI / 2, 9);
    expect(afterArc.x).toBeCloseTo(50 + R, 9);
    expect(afterArc.y).toBeCloseTo(R, 9);
    // The 10 % climb: 30 m × sin(atan 0.1).
    expect(pts.filter((p) => p.segment === 2).at(-1)!.z).toBeCloseTo(30 * Math.sin(Math.atan(0.1)), 9);
    expect(pts.filter((p) => p.segment === 3).every((p) => p.bank === 0.2)).toBe(true);
    // The same end as the 2D track map.
    const tp = trackPath(segs).flat().at(-1)!;
    expect(end.x).toBeCloseTo(tp.x, 6);
    expect(end.y).toBeCloseTo(tp.y, 6);
    // Each sample's distance rises.
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.total).toBeGreaterThanOrEqual(pts[i - 1]!.total);
  });

  it('a frame is placed by its distance along, moved by its distance off the line, turned by the sideslip', () => {
    const R = 20;
    const segs = [straight(50), arc((Math.PI / 2) * R, R, 'left')];
    const pts = course(segs);
    const segStart = [0, 50];
    const f = { segment: 1, s: (Math.PI / 4) * R, grade: 0, bank: 0 };
    const q = placeOnCourse(pts, segStart, f);
    // Halfway round the arc (45°).
    expect(q.x).toBeCloseTo(50 + R * Math.sin(Math.PI / 4), 2);
    expect(q.y).toBeCloseTo(R - R * Math.cos(Math.PI / 4), 2);
    expect(q.heading).toBeCloseTo(Math.PI / 4, 3);
    // 0.5 m left of the line (toward the arc's center), 2° sideslip.
    const off = placeOnCourse(pts, segStart, { ...f, handling: { pathError: 0.5, sideslip: 2, yawRate: 0, steer: 0, atLock: false, path: { x: 0, y: 0 } } });
    expect(Math.hypot(off.x - (50), off.y - R)).toBeCloseTo(R - 0.5, 2);
    expect(off.heading).toBeCloseTo(Math.PI / 4 - (2 * Math.PI) / 180, 3);
  });

  it('the road under the course: a placed bump across its width, only on its side', () => {
    const road = { features: [{ at: 10, length: 2, height: 40, side: 'left' as const, kind: 'bump' as const }] };
    const pts = course([straight(30, { road })]);
    const on = pts.find((p) => Math.abs(p.s - 11) < 0.13)!;
    expect(courseRoadHeight([{ road }], on, 0.6)).toBeGreaterThan(20);
    expect(courseRoadHeight([{ road }], on, -0.6)).toBe(0);
    // Bumpy segments are sampled finely so the bump's shape shows.
    expect(pts.length).toBeGreaterThan(100);
  });
});
