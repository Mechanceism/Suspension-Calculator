/**
 * Corner optimizer (L7, first version): move free hardpoint coordinates, each within its own range,
 * so the corner's motion meets the chosen goals. Everything not listed as a variable stays put, so
 * locked parts and values are respected simply by never making them variables. Locked derived
 * dimensions (arm length, pivot-axis angles) are held by stiff penalty terms.
 *
 * Each goal turns into residuals (miss ÷ tolerance, × √weight); the bounded least-squares solver
 * minimizes their sum of squares. A small "prefer small changes" term keeps the answer close to the
 * starting design when the goals alone don't pin it down (e.g. six free tie-rod coordinates for one
 * toe curve).
 */
import { ackermann } from '../suspension/derived';
import { headingAngle } from '../suspension/steering';
import { vec3, addScaled, dot, Y_AXIS, type Vec3 } from '../math/vec3';
import { patchGrip, DEFAULT_GRIP, type GripModel, type PatchGrip } from '../tire/grip';
import { mfPeaks, DEFAULT_MF, type TireGrip } from '../tire/magicFormula';
import { solveLoadedHeight, type TireForceModel } from '../tire/model';
import type { TireProfile } from '../tire/geometry';
import { DoubleWishbone, type CornerState, type DoubleWishboneGeometry } from '../suspension/doubleWishbone';
import { characteristics, deg, rad, type Characteristics } from '../suspension/characteristics';
import { armMetrics } from '../suspension/armGeometry';
import { type LsqResult } from './leastSquares';
import { multiStartLeastSquares } from './search';
import { dimensionValue, type DimensionSpec } from '../suspension/dimensions';

export type HardpointId =
  | 'ucaFwd' | 'ucaAft' | 'ucaOut' | 'lcaFwd' | 'lcaAft' | 'lcaOut'
  | 'trInner' | 'trOuter' | 'wheelCenter' | 'damperChassis' | 'damperArm'
  /** Multilink: the rear links' upright ends. */
  | 'ucaOut2' | 'lcaOut2'
  /** Rocker layout: pivot axis and pushrod ends. */
  | 'rockerPivot1' | 'rockerPivot2' | 'pushrodLower' | 'pushrodUpper'
  /** Steering-arm mechanism: its pivot axis. */
  | 'steerPivot1' | 'steerPivot2'
  /** Custom linkage: a joint's point, `custom:<joint id>:p` or `:q`. */
  | `custom:${string}`;

export type GoalKind =
  | 'bumpSteer' | 'camberGain' | 'rollCamber' | 'rollCenter' | 'rcMigration'
  | 'kpi' | 'caster' | 'scrubRadius' | 'trail' | 'antiAngle' | 'motionRatio'
  | 'contactArea' | 'grip' | 'casterGain' | 'trackChange' | 'ackermann';

export interface GoalMeta {
  /** Short name for narrow tables. */
  short: string;
  label: string;
  /** Unit of the target and of the reported value. */
  unit: string;
  /** Default target. */
  target: number;
  /** One "unit of miss" for a residual (in the goal's unit). */
  tolerance: number;
  hint: string;
  /** Maximized (no target): the residual is start value / value, tolerance = relative change. */
  maximize?: boolean;
}

export const GOAL_META: Record<GoalKind, GoalMeta> = {
  bumpSteer: { short: 'Bump steer', label: 'Bump steer', unit: '°/100 mm', target: 0, tolerance: 0.01, hint: 'Toe change through the travel range should follow this slope (0 = no bump steer). + = toe-in in bump. Reported: largest deviation, °.' },
  camberGain: { short: 'Camber gain', label: 'Camber gain in heave', unit: '°/100 mm', target: -1.5, tolerance: 0.02, hint: 'Camber change per 100 mm of bump (− = top in under bump). Fitted over the travel range.' },
  rollCamber: { short: 'Roll inclination', label: 'Outside wheel inclination in roll', unit: '°', target: -1, tolerance: 0.05, hint: 'Wheel inclination to the ground of the outside wheel at the roll angle below (+ = top outboard). Most tires grip best slightly negative.' },
  rollCenter: { short: 'RC height', label: 'Roll center height (static)', unit: 'mm', target: 50, tolerance: 2, hint: 'Above ground, assuming a mirrored opposite corner.' },
  rcMigration: { short: 'RC migration', label: 'Roll center migration in heave', unit: 'mm/100 mm', target: 0, tolerance: 2, hint: 'Roll-center height change per 100 mm of bump.' },
  kpi: { short: 'KPI', label: 'KPI (static)', unit: '°', target: 8, tolerance: 0.1, hint: 'Kingpin inclination.' },
  caster: { short: 'Caster', label: 'Caster (static)', unit: '°', target: 4, tolerance: 0.1, hint: '+ = top of the steering axis rearward.' },
  scrubRadius: { short: 'Scrub radius', label: 'Scrub radius (static)', unit: 'mm', target: 10, tolerance: 1, hint: '+ = axis meets the ground inboard of the contact point.' },
  trail: { short: 'Trail', label: 'Mechanical trail (static)', unit: 'mm', target: 15, tolerance: 1, hint: '+ = axis meets the ground ahead of the contact point.' },
  antiAngle: { short: 'Anti angle', label: 'Side-view anti angle (static)', unit: '°', target: 3, tolerance: 0.1, hint: 'Angle of the contact patch → side-view IC line (anti-dive / anti-lift with outboard brakes).' },
  contactArea: { short: 'Contact area', label: 'Contact area (largest)', unit: 'cm²', target: 0, tolerance: 0.01, maximize: true, hint: 'Patch area, averaged over the static case and the outside wheel in roll (at the roll angle and roll load below). Needs a tire model.' },
  grip: { short: 'Grip', label: 'Grip: peak lateral force (largest)', unit: 'N', target: 0, tolerance: 0.01, maximize: true, hint: 'Peak lateral force of the tire (Magic Formula tire grip model: load, inclination, pressure). Averaged over the static case and the outside wheel in roll, where leaning its top into the turn adds camber thrust.' },
  casterGain: { short: 'Caster gain', label: 'Caster change in heave', unit: '°/100 mm', target: 0, tolerance: 0.05, hint: 'Caster change per 100 mm of bump, fitted over the travel range (anti-dive geometry gains caster in bump).' },
  trackChange: { short: 'Track change', label: 'Track change (scrub) in heave', unit: 'mm/100 mm', target: 0, tolerance: 0.5, hint: 'Half-track change per 100 mm of bump (+ = contact moves outboard): tire scrub over bumps. Fitted over the travel range.' },
  ackermann: { short: 'Ackermann', label: 'Ackermann (at the check rack travel)', unit: '%', target: 50, tolerance: 2, hint: 'With the mirrored corner, at the rack travel set for the bump-steer check (or 20 mm), the vehicle wheelbase and the steering-axis track: 100 % = ideal Ackermann, 0 = parallel, < 0 = anti-Ackermann.' },
  motionRatio: { short: 'Motion ratio', label: 'Motion ratio (static)', unit: '', target: 0.7, tolerance: 0.005, hint: 'Damper travel per wheel travel at design height.' },
};
export const GOAL_KINDS = Object.keys(GOAL_META) as GoalKind[];

export interface Goal { kind: GoalKind; target: number; weight: number }
export interface Variable { point: HardpointId; axis: 0 | 1 | 2; lo: number; hi: number }
/** Something the optimizer must keep: a locked arm dimension, or a held dimension between two points. */
export type Hold =
  | { arm: 'uca' | 'lca'; which: 'length' | 'inclination' | 'planAngle' | 'frontViewAngle' }
  | { dimension: DimensionSpec };

/** The value a hold must keep (arm dimensions: as they are now; held dimensions: their set value). */
export const holdTarget = (g: DoubleWishboneGeometry, h: Hold): number => ('dimension' in h ? h.dimension.value : holdValue(g, h));

export interface CornerProblem {
  geometry: DoubleWishboneGeometry;
  /** Travel range (wheel center, mm): droop (negative) to bump. */
  droop: number;
  bump: number;
  /** Travel samples across the range (odd, includes 0). */
  samples?: number;
  /** Also check bump steer at these rack positions (mm), besides 0. */
  rackPositions?: number[];
  /** Body roll angle for the roll-camber goal (deg). */
  rollAngle?: number;
  goals: Goal[];
  variables: Variable[];
  holds?: Hold[];
  /** Weight of the "prefer small changes" term (per 10 mm moved). */
  keepClose?: number;
  /** Wheelbase, mm (Ackermann goal; default 1550). */
  wheelbase?: number;
  /** Tire, static corner load and grip model, for the contact-area and grip goals. */
  tire?: { profile: TireProfile; model: TireForceModel; staticLoad: number; rollLoadFactor: number; grip?: GripModel; tireGrip?: TireGrip; pressure?: number };
  maxIterations?: number;
  /** Gradient runs: 1 = from the current design only; more = also from the best DOE samples (wider search). */
  starts?: number;
}

const AXES = ['x', 'y', 'z'] as const;

export function getPoint(g: DoubleWishboneGeometry, id: HardpointId): Vec3 | undefined {
  switch (id) {
    case 'ucaFwd': return g.uca.fwd; case 'ucaAft': return g.uca.aft; case 'ucaOut': return g.uca.out;
    case 'lcaFwd': return g.lca.fwd; case 'lcaAft': return g.lca.aft; case 'lcaOut': return g.lca.out;
    case 'trInner': return g.tieRod.inner; case 'trOuter': return g.tieRod.outer;
    case 'wheelCenter': return g.wheel.center;
    case 'damperChassis': return g.damper?.chassis; case 'damperArm': return g.damper?.armPoint;
    case 'ucaOut2': return g.uca.out2; case 'lcaOut2': return g.lca.out2;
    case 'rockerPivot1': return g.rocker?.pivot1; case 'rockerPivot2': return g.rocker?.pivot2;
    case 'pushrodLower': return g.rocker?.pushrodLower; case 'pushrodUpper': return g.rocker?.pushrodUpper;
    case 'steerPivot1': return g.steering?.kind === 'arm' ? g.steering.pivot1 : undefined;
    case 'steerPivot2': return g.steering?.kind === 'arm' ? g.steering.pivot2 : undefined;
  }
  if (id.startsWith('custom:')) {
    const [, jid, which] = id.split(':');
    const j = g.custom?.joints.find((x) => x.id === jid);
    return j ? (which === 'q' ? j.q : j.p) : undefined;
  }
  return undefined;
}

/** A copy of the geometry with the variables set to x. */
export function withVariables(g: DoubleWishboneGeometry, vars: Variable[], x: number[]): DoubleWishboneGeometry {
  const pts = new Map<HardpointId, Vec3>();
  vars.forEach((v, i) => {
    const p = pts.get(v.point) ?? getPoint(g, v.point);
    if (!p) return;
    pts.set(v.point, vec3(v.axis === 0 ? x[i]! : p.x, v.axis === 1 ? x[i]! : p.y, v.axis === 2 ? x[i]! : p.z));
  });
  const P = (id: HardpointId) => pts.get(id) ?? getPoint(g, id)!;
  return {
    ...g,
    uca: { fwd: P('ucaFwd'), aft: P('ucaAft'), out: P('ucaOut'), ...(g.uca.out2 ? { out2: P('ucaOut2') } : {}) },
    lca: { fwd: P('lcaFwd'), aft: P('lcaAft'), out: P('lcaOut'), ...(g.lca.out2 ? { out2: P('lcaOut2') } : {}) },
    tieRod: { inner: P('trInner'), outer: P('trOuter') },
    wheel: { ...g.wheel, center: P('wheelCenter') },
    damper: g.damper ? { ...g.damper, chassis: P('damperChassis'), armPoint: P('damperArm') } : undefined,
    ...(g.steering?.kind === 'arm' ? { steering: { kind: 'arm' as const, pivot1: P('steerPivot1'), pivot2: P('steerPivot2') } } : {}),
    ...(g.rocker ? { rocker: { ...g.rocker, pivot1: P('rockerPivot1'), pivot2: P('rockerPivot2'), pushrodLower: P('pushrodLower'), pushrodUpper: P('pushrodUpper') } } : {}),
    ...(g.custom ? {
      custom: {
        ...g.custom,
        joints: g.custom.joints.map((j) => ({ ...j, p: pts.get(`custom:${j.id}:p`) ?? j.p, ...(j.q ? { q: pts.get(`custom:${j.id}:q`) ?? j.q } : {}) })),
      },
    } : {}),
  };
}

export const variableValue = (g: DoubleWishboneGeometry, v: Variable): number => getPoint(g, v.point)?.[AXES[v.axis]] ?? NaN;

/** Solved samples of one geometry, the raw material for every goal. */
export interface CornerSamples {
  travels: number[];
  chars: Characteristics[];
  /** Index of travel 0. */
  i0: number;
  /** Toe through travel at each extra rack position. */
  rackToe: { rack: number; toe: number[] }[];
  /** Ackermann % with the mirrored corner (null when not asked or not solvable). */
  ackermann?: number | null;
  /** Outside-wheel travel and characteristics at the roll angle. */
  roll: { travel: number; chars: Characteristics; angle: number } | null;
  /** Motion ratio at design height (null without a damper). */
  motionRatio: number | null;
  /**
   * Patch (contact area) and peak lateral force (Magic Formula, N): static (travel 0, static load) and the
   * outside wheel in roll (roll load, pushing inboard: leaning its top inboard gains camber thrust).
   */
  grip: { static: PatchGrip; roll: PatchGrip | null; staticPeak: number; rollPeak: number | null } | null;
}

/**
 * Grip of the tire on a corner state against ground with normal `n` (corner frame), carrying `load`.
 * The ground height is solved so the tire carries the load.
 */
export function cornerGrip(state: CornerState, n: Vec3, profile: TireProfile, model: TireForceModel, load: number, grip: GripModel): PatchGrip {
  const wc = state.points.wheelCenter;
  const h = solveLoadedHeight(model, profile, dot(n, state.spinAxis), Math.max(load, 1)).centerHeight;
  return patchGrip(wc, state.spinAxis, { point: addScaled(wc, n, -h), normal: n }, profile, load, grip);
}

export function travelSamples(droop: number, bump: number, n = 9): number[] {
  const lo = Math.min(0, droop), hi = Math.max(0, bump);
  const k = Math.max(3, n | 1);
  const out = new Set<number>([0]);
  for (let i = 0; i < k; i++) out.add(Number((lo + ((hi - lo) * i) / (k - 1)).toFixed(6)));
  return [...out].sort((a, b) => a - b);
}

const converged = (s: CornerState) => s.solve.status === 'converged';

/** Sweep the geometry and gather what the goals need. null = the linkage can't be assembled. */
export function sampleCorner(geometry: DoubleWishboneGeometry, p: Omit<CornerProblem, 'geometry' | 'goals' | 'variables'> & { goals?: Goal[] }): CornerSamples | null {
  let corner: DoubleWishbone;
  try { corner = new DoubleWishbone(geometry); } catch { return null; }
  const travels = travelSamples(p.droop, p.bump, p.samples);
  const states = corner.sweep(travels, (travel) => ({ travel }));
  if (!states.every(converged)) return null;
  const chars = states.map(characteristics);
  const i0 = travels.indexOf(0);
  const need = new Set((p.goals ?? []).map((g) => g.kind));
  const all = !p.goals;

  const rackToe: CornerSamples['rackToe'] = [];
  if (all || need.has('bumpSteer')) {
    for (const rack of p.rackPositions ?? []) {
      if (!rack) continue;
      const rs = corner.sweep(travels, (travel) => ({ travel, rack }));
      if (!rs.every(converged)) return null;
      rackToe.push({ rack, toe: rs.map((s) => characteristics(s).toe) });
    }
  }

  let roll: CornerSamples['roll'] = null;
  const needGrip = (all || need.has('contactArea') || need.has('grip')) && !!p.tire;
  let rollState: CornerState | null = null;
  if ((all || need.has('rollCamber') || needGrip) && p.rollAngle) {
    // Outside wheel: the body rolls φ over it, so it moves up ≈ half track · tan φ relative to the body.
    const phi = rad(Math.abs(p.rollAngle));
    const travel = chars[i0]!.halfTrack * Math.tan(phi);
    const s = corner.solve({ travel }, states[i0]!.poses);
    if (!converged(s)) return null;
    roll = { travel, chars: characteristics(s), angle: phi };
    rollState = s;
  }

  let grip: CornerSamples['grip'] = null;
  if (needGrip && p.tire) {
    const t = p.tire;
    const gm = t.grip ?? DEFAULT_GRIP;
    const st = cornerGrip(states[i0]!, Y_AXIS, t.profile, t.model, t.staticLoad, gm);
    // Outside wheel in roll: the ground tilts by phi relative to the body (top of the wheel leans out).
    const phi = roll?.angle ?? 0;
    const rn = vec3(-Math.sin(phi), Math.cos(phi), 0);
    const rl = rollState ? cornerGrip(rollState, rn, t.profile, t.model, t.staticLoad * t.rollLoadFactor, gm) : null;
    // Inclination to the ground, + = top outboard.
    const incl = (st0: CornerState, n: Vec3) => -Math.asin(Math.max(-1, Math.min(1, dot(st0.spinAxis, n))));
    const mf = t.tireGrip ?? DEFAULT_MF;
    const g0 = incl(states[i0]!, Y_AXIS);
    // Straight ahead: either lean direction (camber only lowers the peak).
    const staticPeak = (mfPeaks(mf, { fz: t.staticLoad, gamma: g0, pressure: t.pressure }).y + mfPeaks(mf, { fz: t.staticLoad, gamma: -g0, pressure: t.pressure }).y) / 2;
    const rollPeak = rollState ? mfPeaks(mf, { fz: t.staticLoad * t.rollLoadFactor, gamma: -incl(rollState, rn), pressure: t.pressure }).y : null;
    grip = { static: st, roll: rl, staticPeak, rollPeak };
  }

  let motionRatio: number | null = null;
  if ((all || need.has('motionRatio')) && geometry.damper) {
    const d = 1;
    const a = corner.solve({ travel: -d }, states[i0]!.poses);
    const b = corner.solve({ travel: d }, states[i0]!.poses);
    const ca = characteristics(a), cb = characteristics(b);
    if (converged(a) && converged(b) && ca.damperLength !== undefined && cb.damperLength !== undefined) {
      motionRatio = -(cb.damperLength - ca.damperLength) / (cb.contactPoint.y - ca.contactPoint.y);
    }
  }
  let ackermannPct: number | null = null;
  if (all || need.has('ackermann')) {
    // The mirrored pair at ± rack travel: this wheel at +r, its mirror image (the other side) at −r.
    const r = Math.max(...(p.rackPositions ?? []).map(Math.abs), 0) || 20;
    const h0 = headingAngle(states[i0]!.spinAxis);
    const a = corner.solve({ rack: r }, states[i0]!.poses), b = corner.solve({ rack: -r }, states[i0]!.poses);
    const g = chars[i0]!.steeringAxisAtGround;
    if (converged(a) && converged(b)) {
      const v = ackermann(headingAngle(a.spinAxis) - h0, -(headingAngle(b.spinAxis) - h0), p.wheelbase ?? 1550, 2 * Math.abs(g ? g.x : chars[i0]!.contactPoint.x)).percent;
      ackermannPct = Number.isFinite(v) ? v : null;
    }
  }
  return { travels, chars, i0, rackToe, roll, motionRatio, grip, ackermann: ackermannPct };
}

/** Least-squares slope through the origin-shifted points (x, y − y0). */
const slopeThrough = (xs: number[], ys: number[], i0: number) => {
  let sxy = 0, sxx = 0;
  xs.forEach((x, i) => { sxy += x * (ys[i]! - ys[i0]!); sxx += x * x; });
  return sxx > 0 ? sxy / sxx : 0;
};

/**
 * The value reported for a goal (in its unit). For bump steer this is the largest deviation of the toe
 * curve from the target slope (°), so "0" means none at all.
 */
export function goalValue(kind: GoalKind, s: CornerSamples, target = GOAL_META[kind].target): number | null {
  const c0 = s.chars[s.i0]!;
  switch (kind) {
    case 'bumpSteer': {
      const curves = [s.chars.map((c) => c.toe), ...s.rackToe.map((r) => r.toe)];
      let worst = 0;
      for (const toe of curves) {
        s.travels.forEach((t, i) => { worst = Math.max(worst, Math.abs(deg(toe[i]! - toe[s.i0]!) - (target / 100) * t)); });
      }
      return worst;
    }
    case 'camberGain': return 100 * deg(slopeThrough(s.travels, s.chars.map((c) => c.camber), s.i0));
    case 'rollCamber': return s.roll ? deg(s.roll.chars.camber + s.roll.angle) : null;
    case 'rollCenter': return c0.rollCenterHeight;
    case 'rcMigration': {
      const rc = s.chars.map((c) => c.rollCenterHeight);
      if (rc.some((v) => v === null)) return null;
      return 100 * slopeThrough(s.travels, rc as number[], s.i0);
    }
    case 'kpi': return deg(c0.kpi);
    case 'caster': return deg(c0.caster);
    case 'scrubRadius': return c0.scrubRadius;
    case 'trail': return c0.mechanicalTrail;
    case 'antiAngle': return deg(c0.antiAngleContact);
    case 'motionRatio': return s.motionRatio;
    case 'casterGain': return 100 * deg(slopeThrough(s.travels, s.chars.map((c) => c.caster), s.i0));
    case 'trackChange': return 100 * slopeThrough(s.travels, s.chars.map((c) => c.halfTrack), s.i0);
    case 'ackermann': return s.ackermann ?? null;
    case 'contactArea': {
      if (!s.grip) return null;
      const v = [s.grip.static.area, ...(s.grip.roll ? [s.grip.roll.area] : [])];
      return v.reduce((a, b) => a + b, 0) / v.length / 100; // cm²
    }
    case 'grip': {
      if (!s.grip) return null;
      const v = [s.grip.staticPeak, ...(s.grip.rollPeak !== null ? [s.grip.rollPeak] : [])];
      return v.reduce((a, b) => a + b, 0) / v.length;
    }
  }
}

const BAD = 1e3;

/** Residuals of one goal (already divided by its tolerance, before the weight). */
export function cornerGoalResiduals(goal: Goal, s: CornerSamples, ref?: number | null): number[] {
  const tol = GOAL_META[goal.kind].tolerance;
  if (GOAL_META[goal.kind].maximize) {
    // Larger is better: start value / value, scaled so a 1 % gain counts about as much as removing
    // one tolerance of miss on a target goal.
    const v = goalValue(goal.kind, s);
    return [v === null || !(v > 0) || !ref ? BAD : (ref / v) / Math.sqrt(tol)];
  }
  switch (goal.kind) {
    case 'bumpSteer': {
      const curves = [s.chars.map((c) => c.toe), ...s.rackToe.map((r) => r.toe)];
      return curves.flatMap((toe) => s.travels.map((t, i) => (deg(toe[i]! - toe[s.i0]!) - (goal.target / 100) * t) / tol));
    }
    case 'camberGain':
      return s.travels.map((t, i) => (deg(s.chars[i]!.camber - s.chars[s.i0]!.camber) - (goal.target / 100) * t) / tol);
    case 'casterGain':
      return s.travels.map((t, i) => (deg(s.chars[i]!.caster - s.chars[s.i0]!.caster) - (goal.target / 100) * t) / tol);
    case 'trackChange':
      return s.travels.map((t, i) => (s.chars[i]!.halfTrack - s.chars[s.i0]!.halfTrack - (goal.target / 100) * t) / tol);
    case 'rcMigration': {
      const rc0 = s.chars[s.i0]!.rollCenterHeight;
      return s.travels.map((t, i) => {
        const rc = s.chars[i]!.rollCenterHeight;
        return rc === null || rc0 === null ? BAD : (rc - rc0 - (goal.target / 100) * t) / tol;
      });
    }
    default: {
      const v = goalValue(goal.kind, s, goal.target);
      return [v === null || !Number.isFinite(v) ? BAD : (v - goal.target) / tol];
    }
  }
}

export function holdValue(g: DoubleWishboneGeometry, h: Hold): number {
  if ('dimension' in h) return dimensionValue(g, h.dimension) ?? NaN;
  const m = armMetrics(g[h.arm]);
  return h.which === 'length' ? m.length : deg(h.which === 'inclination' ? m.inclination : h.which === 'planAngle' ? m.planAngle : m.frontViewAngle);
}

export interface GoalReport { kind: GoalKind; target: number; before: number | null; after: number | null }

export interface CornerReport {
  geometry: DoubleWishboneGeometry;
  /** Variable values before / after, and whether each ended on its range limit. */
  variables: (Variable & { before: number; after: number; atLimit: boolean })[];
  goals: GoalReport[];
}

export interface CornerOptimizeResult extends CornerReport { lsq: LsqResult }

export type ProgressInfo = { iteration: number; cost: number; cost0: number; evaluations: number; x: number[] };

const sampleOpts = (p: CornerProblem, goals?: Goal[]) =>
  ({ droop: p.droop, bump: p.bump, samples: p.samples, rackPositions: p.rackPositions, rollAngle: p.rollAngle, tire: p.tire, goals });

/** Before / after report for variable values x (also used for a stopped run's best point so far). */
export function reportCorner(p: CornerProblem, x: number[]): CornerReport {
  const geometry = withVariables(p.geometry, p.variables, x);
  const before = sampleCorner(p.geometry, sampleOpts(p));
  const after = sampleCorner(geometry, sampleOpts(p));
  const tol = 1e-9;
  return {
    geometry,
    variables: p.variables.map((v, i) => {
      const b = variableValue(p.geometry, v);
      const a = x[i]!;
      const onLimit = a <= Math.min(v.lo, v.hi) + tol || a >= Math.max(v.lo, v.hi) - tol;
      return { ...v, before: b, after: a, atLimit: onLimit && Math.abs(a - b) > 1e-6 };
    }),
    goals: p.goals.map((g) => ({
      kind: g.kind, target: g.target,
      before: before ? goalValue(g.kind, before, g.target) : null,
      after: after ? goalValue(g.kind, after, g.target) : null,
    })),
  };
}

export function optimizeCorner(p: CornerProblem, onIteration?: (info: ProgressInfo) => boolean | void): CornerOptimizeResult {
  const vars = p.variables;
  const goals = p.goals.filter((g) => g.weight > 0);
  const x0 = vars.map((v) => variableValue(p.geometry, v));
  const lo = vars.map((v) => Math.min(v.lo, v.hi));
  const hi = vars.map((v) => Math.max(v.lo, v.hi));
  const holds = (p.holds ?? []).map((h) => ({ h, v0: holdTarget(p.geometry, h) }));
  const keep = Math.sqrt(p.keepClose ?? 0.01);
  const opts = sampleOpts(p, goals);
  const start = sampleCorner(p.geometry, opts);
  const refs = new Map(goals.filter((g) => GOAL_META[g.kind].maximize).map((g) => [g.kind, start ? goalValue(g.kind, start) : null]));

  const residuals = (x: number[]): number[] | null => {
    const g = withVariables(p.geometry, vars, x);
    const s = sampleCorner(g, opts);
    if (!s) return null;
    const r: number[] = [];
    for (const goal of goals) {
      const w = Math.sqrt(goal.weight);
      for (const v of cornerGoalResiduals(goal, s, refs.get(goal.kind))) r.push(w * v);
    }
    // Held (locked) derived dimensions: stiff, tolerance 0.001 mm / 0.001°.
    for (const { h, v0 } of holds) r.push((holdValue(g, h) - v0) / 1e-3);
    x.forEach((v, i) => r.push((keep * (v - x0[i]!)) / 10));
    return r;
  };

  const lsq = multiStartLeastSquares(residuals, x0, lo, hi, {
    maxIterations: p.maxIterations ?? 60, step: 0.01, relTol: 1e-7,
    onIteration: onIteration ? (i) => onIteration({ iteration: i.iteration, cost: i.cost, cost0: i.cost0, evaluations: i.evaluations, x: i.x }) : undefined,
  }, { starts: p.starts ?? 1 });
  return { lsq, ...reportCorner(p, lsq.x) };
}
