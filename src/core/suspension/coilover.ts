/**
 * Coilover / strut placement as numbers people set (docs/MATH.md § L5): installed length, front-view and
 * side-view angle from vertical, and where its lower mount sits along its arm. Each setter returns new
 * mount positions; the lower mount stays put except when moving it along the arm (then the whole coilover
 * moves with it, keeping its length and angles).
 */
import { type Vec3, vec3, add, sub, scale, dot, length, normalize, rejectFrom } from '../math/vec3';
import { armMetrics } from './armGeometry';
import type { ArmPoints, DoubleWishboneGeometry } from './doubleWishbone';

export interface CoiloverGeometry {
  /** Mount to mount, mm. */
  length: number;
  /** Front view, from vertical, rad: + = top inboard (−X). */
  frontViewAngle: number;
  /** Side view, from vertical, rad: + = top rearward (−Z). */
  sideViewAngle: number;
  /** Lower mount along its arm: 0 = on the pivot axis, 1 = at the ball joint (NaN when not on an arm). */
  alongArm: number;
}

export function coiloverGeometry(chassis: Vec3, lower: Vec3, arm?: ArmPoints): CoiloverGeometry {
  const d = sub(chassis, lower);
  let alongArm = NaN;
  if (arm) {
    const m = armMetrics(arm);
    alongArm = dot(sub(lower, m.foot), normalize(sub(arm.out, m.foot))) / m.length;
  }
  return { length: length(d), frontViewAngle: Math.atan2(-d.x, d.y), sideViewAngle: Math.atan2(-d.z, d.y), alongArm };
}

/** Top mount for a length and angles, from the lower mount. */
export function coiloverTop(lower: Vec3, len: number, frontViewAngle: number, sideViewAngle: number): Vec3 {
  const u = normalize(vec3(-Math.tan(frontViewAngle), 1, -Math.tan(sideViewAngle)));
  return add(lower, scale(u, len));
}

/** Change one of length / front-view angle / side-view angle; the lower mount stays. */
export function setCoilover(chassis: Vec3, lower: Vec3, which: 'length' | 'frontViewAngle' | 'sideViewAngle', value: number): Vec3 {
  const g = coiloverGeometry(chassis, lower);
  const next = { ...g, [which]: value };
  return coiloverTop(lower, next.length, next.frontViewAngle, next.sideViewAngle);
}

/** Move the lower mount along its arm to a fraction (0 pivot axis … 1 ball joint); the coilover moves as a unit. */
export function moveAlongArm(chassis: Vec3, lower: Vec3, arm: ArmPoints, fraction: number): { chassis: Vec3; lower: Vec3 } {
  const m = armMetrics(arm);
  const e1 = normalize(sub(arm.out, m.foot));
  const now = dot(sub(lower, m.foot), e1) / m.length;
  const shift = scale(e1, (fraction - now) * m.length);
  return { chassis: add(chassis, shift), lower: add(lower, shift) };
}

export interface RockerLayout {
  rocker: { pivot1: Vec3; pivot2: Vec3; pushrodBody: 'uca' | 'lca' | 'upright'; pushrodLower: Vec3; pushrodUpper: Vec3 };
  /** The spring / damper: frame end and its end on the rocker. */
  damper: { chassis: Vec3; armPoint: Vec3 };
}

/**
 * A pushrod + rocker in place of a coilover: the pushrod starts where the coilover's lower mount was and runs
 * to a rocker near the coilover's top; the rocker pivots on a fore-aft axis. Each lever is square to its
 * link (pushrod lever ⊥ pushrod, spring lever ⊥ spring), so the layout starts far from a toggle; the spring
 * keeps the coilover's length and runs up and inboard at 45°. Motion ratio ≈ the pushrod's × spring lever ÷
 * pushrod lever.
 */
export function rockerFromCoilover(chassis: Vec3, lower: Vec3, body: 'uca' | 'lca' | 'upright', levers = { pushrod: 60, spring: 50 }): RockerLayout {
  const len = length(sub(chassis, lower));
  // Pivot a little below the old top mount, inboard of the pushrod's line.
  const P = add(chassis, vec3(0, -0.25 * len, 0));
  const u0 = sub(P, lower);
  const u = normalize(vec3(u0.x, u0.y, 0)); // pushrod direction in the rocker's plane (⊥ Z)
  const perp = vec3(u.y, -u.x, 0); // ⊥ u in that plane: the pushrod lever's direction
  // The spring runs up and inboard at 45° (keeping its length); its lever is square to it. In bump the
  // pushrod pushes its rocker end along +u and the rocker turns (ω about Z): pick the levers' sides so the
  // spring's end moves toward its frame end (compressed in bump), preferring the spring lever upward.
  const sDir = normalize(vec3(-1, 1, 0));
  const sPerp = vec3(sDir.y, -sDir.x, 0);
  const zx = (r: Vec3) => vec3(-r.y, r.x, 0); // ẑ × r
  let best: RockerLayout | null = null;
  for (const springSide of [1, -1]) {
    for (const pushSide of [-1, 1]) {
      const r1 = scale(perp, pushSide * levers.pushrod);
      const w = Math.sign(dot(zx(r1), u)) || 1; // rotation sense in bump
      const r2 = scale(sPerp, springSide * levers.spring);
      if (dot(scale(zx(r2), w), sDir) <= 0) continue; // the spring would extend in bump
      const springEnd = add(P, r2);
      best = {
        rocker: { pivot1: add(P, vec3(0, 0, 30)), pivot2: add(P, vec3(0, 0, -30)), pushrodBody: body, pushrodLower: lower, pushrodUpper: add(P, r1) },
        damper: { chassis: add(springEnd, scale(sDir, len)), armPoint: springEnd },
      };
      break;
    }
    if (best) break;
  }
  return best!;
}

/**
 * Rocker ratio: the spring end's lever about the rocker's pivot axis ÷ the pushrod end's (their distances
 * from the axis), with both levers (mm). NaN without a rocker.
 */
export function rockerRatio(g: DoubleWishboneGeometry): { ratio: number; pushrodLever: number; springLever: number } {
  const r = g.rocker;
  if (!r || !g.damper) return { ratio: NaN, pushrodLever: NaN, springLever: NaN };
  const u = normalize(sub(r.pivot2, r.pivot1));
  const lever = (q: Vec3) => length(rejectFrom(sub(q, r.pivot1), u));
  const lp = lever(r.pushrodUpper), ls = lever(g.damper.armPoint);
  return { ratio: lp > 1e-9 ? ls / lp : NaN, pushrodLever: lp, springLever: ls };
}

/** How far the spring's rocker end must move (along its arm, away from / toward the axis) for a rocker ratio. */
export function rockerRatioMove(g: DoubleWishboneGeometry, ratio: number): Vec3 | null {
  const r = g.rocker, now = rockerRatio(g);
  if (!r || !g.damper || !(ratio > 0) || !(now.pushrodLever > 1e-9) || !(now.springLever > 1e-9)) return null;
  const u = normalize(sub(r.pivot2, r.pivot1));
  const rel = sub(g.damper.armPoint, r.pivot1);
  const along = scale(u, dot(rel, u));
  const moved = add(r.pivot1, add(along, scale(sub(rel, along), (ratio * now.pushrodLever) / now.springLever)));
  return sub(moved, g.damper.armPoint);
}
