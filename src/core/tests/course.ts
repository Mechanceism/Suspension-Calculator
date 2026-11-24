/**
 * The test course in 3D (round 3, V2; docs/MATH.md § Tests, dynamic view): the centerline the segments
 * make (straights and arcs, the same exact arcs as the playback frames and the track map), its height from
 * the grades, its bank, and the road under it (rough surface, bumps / potholes) across its width.
 */
import type { SegmentSpec } from './segments';
import { roadHeight } from './road';
import type { PlaybackFrame } from './run';

export interface CoursePoint {
  /** Segment and distance along it (m); distance from the start (m). */
  segment: number;
  s: number;
  total: number;
  /** Top view (m; heading 0 = +x, + = left) and height (m). */
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Road bank (rad, + = left side lower) and grade (rad, + = uphill). */
  bank: number;
  grade: number;
}

/**
 * Centerline samples: about every `step` m (finer on arcs, and on rough or bumpy segments so their shape
 * shows), plus each segment's ends.
 */
export function course(segs: Pick<SegmentSpec, 'distance' | 'path' | 'radius' | 'grade' | 'bank' | 'road'>[], step = 1): CoursePoint[] {
  const out: CoursePoint[] = [];
  let x = 0, y = 0, z = 0, heading = 0, total = 0;
  segs.forEach((sg, i) => {
    const d = Math.max(0, sg.distance);
    const curv = sg.path === 'straight' ? 0 : (sg.path === 'left' ? 1 : -1) / Math.max(sg.radius, 0.1);
    const bumpy = !!(sg.road?.rough || sg.road?.features?.length);
    let h = Math.min(step, bumpy ? 0.25 : step);
    if (curv) h = Math.min(h, (5 * Math.PI) / 180 / Math.abs(curv));
    const n = Math.max(1, Math.ceil(d / Math.max(h, 1e-6)));
    const x0 = x, y0 = y, z0 = z, h0 = heading;
    for (let k = 0; k <= n; k++) {
      if (k === 0 && i > 0) continue; // the previous segment's end
      const sAlong = (d * k) / n;
      heading = h0 + curv * sAlong;
      if (curv) {
        x = x0 + (Math.sin(heading) - Math.sin(h0)) / curv;
        y = y0 - (Math.cos(heading) - Math.cos(h0)) / curv;
      } else {
        x = x0 + sAlong * Math.cos(h0);
        y = y0 + sAlong * Math.sin(h0);
      }
      z = z0 + sAlong * Math.sin(sg.grade);
      out.push({ segment: i, s: sAlong, total: total + sAlong, x, y, z, heading, bank: sg.bank, grade: sg.grade });
    }
    total += d;
  });
  return out;
}

/** Road height (mm) at a course point, `lateral` m left of the centerline (rough surface, bumps / potholes). */
export function courseRoadHeight(segs: Pick<SegmentSpec, 'road'>[], p: CoursePoint, lateral: number): number {
  const r = segs[p.segment]?.road;
  return r ? roadHeight(r, p.s, lateral) : 0;
}

export interface CoursePlace { x: number; y: number; z: number; heading: number; grade: number; bank: number }

/**
 * A frame placed on the course: by its distance along (segment + distance in it), so the car sits on the
 * road as drawn (the frames' own top-view positions are a coarse step-by-step sum), moved sideways by the
 * driver's distance off the line and turned by the sideslip (handling).
 */
export function placeOnCourse(points: CoursePoint[], segStart: number[], f: Pick<PlaybackFrame, 'segment' | 's' | 'grade' | 'bank' | 'handling'>): CoursePlace {
  const d = (segStart[f.segment] ?? 0) + f.s;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (points[m]!.total <= d) lo = m; else hi = m - 1; }
  const a = points[lo]!, b = points[Math.min(points.length - 1, lo + 1)]!;
  const u = b.total > a.total ? Math.min(1, Math.max(0, (d - a.total) / (b.total - a.total))) : 0;
  const L = (p: number, q: number) => p + (q - p) * u;
  const heading = L(a.heading, b.heading);
  const off = f.handling?.pathError ?? 0;
  return {
    x: L(a.x, b.x) - off * Math.sin(heading), y: L(a.y, b.y) + off * Math.cos(heading), z: L(a.z, b.z),
    heading: heading - ((f.handling?.sideslip ?? 0) * Math.PI) / 180, grade: f.grade, bank: f.bank,
  };
}
