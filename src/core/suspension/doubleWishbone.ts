/**
 * Double wishbone (SLA) corner kinematics (L1).
 *
 * Bodies: chassis (fixed), rack (fixed, positioned by rack travel), UCA, LCA, upright.
 * Relations:
 *   UCA ↔ chassis   revolute about UCA_Fwd–UCA_Aft         5 eq
 *   LCA ↔ chassis   revolute about LCA_Fwd–LCA_Aft         5 eq
 *   UCA ↔ upright   ball joint at UCA_Out                  3 eq
 *   LCA ↔ upright   ball joint at LCA_Out                  3 eq
 *   tie rod         fixed length TR_In (rack) → TR_Out     1 eq
 *   travel driver   wheel center / contact patch / arm angle  1 eq
 *                                                     total 18 = 3 free bodies × 6
 *
 * Pivot axes are NOT assumed parallel to Z and ball joints are NOT assumed centered between pivots.
 * Steering jacking is not a separate formula: moving the rack rotates the upright about the
 * UBJ–LBJ line and the solve produces the height change directly.
 */
import {
  type Vec3, add, sub, scale, length, normalize, rejectFrom, Y_AXIS, X_AXIS, distance as dist,
} from '../math/vec3';
import { mulVec, transpose } from '../math/mat3';
import {
  ConstraintSystem, PoseContext, type Poses, type SolveResult, type PointRef,
  coincident, fixedDistance, revolute, coordinate, hingeAngle,
} from '../solver/system';

export interface ArmPoints {
  /** Forward inboard pivot (larger Z). */
  readonly fwd: Vec3;
  /** Rearward inboard pivot (smaller Z). */
  readonly aft: Vec3;
  /** Outboard ball joint. */
  readonly out: Vec3;
}

export interface DoubleWishboneGeometry {
  readonly uca: ArmPoints;
  readonly lca: ArmPoints;
  readonly tieRod: { readonly inner: Vec3; readonly outer: Vec3 };
  readonly wheel: {
    readonly center: Vec3;
    /** Spin axis direction, pointing outboard. Need not be unit length. */
    readonly spinAxis: Vec3;
    /** Rolling radius used for the kinematic (rigid) contact point. */
    readonly radius: number;
    /** Tire section width (display; used by the tire layer later). */
    readonly width?: number;
  };
  /** Direction TR_In moves for positive rack travel. Default +X (outboard). */
  readonly rackAxis?: Vec3;
  /** Optional spring/damper: chassis mount and a mount on one of the arms. */
  readonly damper?: { readonly chassis: Vec3; readonly arm: 'uca' | 'lca'; readonly armPoint: Vec3 };
}

/**
 * How suspension travel is prescribed.
 * - wheelCenter:   wheel center Y = design Y + travel (mm)
 * - contactPatch:  rigid-tire contact point Y = design Y + travel (mm)
 * - lowerArmAngle: LCA rotation about its pivot axis = armAngle (rad, + = ball joint up)
 */
export type TravelDriver = 'wheelCenter' | 'contactPatch' | 'lowerArmAngle';

export interface CornerInputs {
  /** Bump-positive travel, mm (wheelCenter / contactPatch drivers). */
  readonly travel?: number;
  /** LCA angle, rad (lowerArmAngle driver). */
  readonly armAngle?: number;
  /** Rack travel, mm along rackAxis. */
  readonly rack?: number;
  readonly driver?: TravelDriver;
}

export interface CornerPoints {
  ucaFwd: Vec3; ucaAft: Vec3; ucaOut: Vec3;
  lcaFwd: Vec3; lcaAft: Vec3; lcaOut: Vec3;
  trInner: Vec3; trOuter: Vec3;
  wheelCenter: Vec3;
  /** Rigid-tire contact point (lowest point of the wheel center-plane circle). */
  contact: Vec3;
  damperChassis?: Vec3;
  damperArm?: Vec3;
}

export interface CornerState {
  readonly inputs: Required<CornerInputs>;
  readonly solve: SolveResult;
  readonly poses: Poses;
  readonly points: CornerPoints;
  /** Unit spin axis, outboard. */
  readonly spinAxis: Vec3;
}

/**
 * Outboard spin axis for a static camber and toe (radians; + camber = top outboard, + toe = toe-in).
 * Inverse of the camber/toe definitions in characteristics.ts.
 */
export const spinAxisFromCamberToe = (camber: number, toe: number): Vec3 => ({
  x: Math.cos(camber) * Math.cos(toe),
  y: -Math.sin(camber),
  z: Math.cos(camber) * Math.sin(toe),
});

const centroid = (...pts: Vec3[]): Vec3 => scale(pts.reduce((a, b) => add(a, b)), 1 / pts.length);

/** Rigid-tire contact point: lowest point of the circle of `radius` in the wheel plane. */
export function contactPoint(center: Vec3, spinAxisUnit: Vec3, radius: number): Vec3 {
  const down = normalize(rejectFrom(Y_AXIS, spinAxisUnit));
  return sub(center, scale(down, radius));
}

export class DoubleWishbone {
  readonly rackAxis: Vec3;
  private readonly spinAxisDesign: Vec3;

  constructor(readonly geometry: DoubleWishboneGeometry) {
    this.rackAxis = normalize(geometry.rackAxis ?? X_AXIS);
    this.spinAxisDesign = normalize(geometry.wheel.spinAxis);
    const g = geometry;
    const pairs: [string, Vec3, Vec3][] = [
      ['UCA pivots', g.uca.fwd, g.uca.aft],
      ['LCA pivots', g.lca.fwd, g.lca.aft],
      ['ball joints', g.uca.out, g.lca.out],
      ['tie rod', g.tieRod.inner, g.tieRod.outer],
    ];
    for (const [label, a, b] of pairs) {
      if (dist(a, b) < 1e-6) throw new Error(`Degenerate geometry: ${label} coincide`);
    }
  }

  /**
   * Where a point fixed to one of the moving bodies (given at its design position) is in a solved
   * state — e.g. an anti-roll-bar drop-link mount on the lower arm.
   */
  pointOn(state: CornerState, body: 'uca' | 'lca' | 'upright', designPoint: Vec3): Vec3 {
    const g = this.geometry;
    const origin = body === 'uca' ? centroid(g.uca.fwd, g.uca.aft, g.uca.out)
      : body === 'lca' ? centroid(g.lca.fwd, g.lca.aft, g.lca.out)
        : centroid(g.uca.out, g.lca.out, g.tieRod.outer, g.wheel.center);
    return new PoseContext(state.poses).world({ body, local: sub(designPoint, origin) });
  }

  /** Inverse of pointOn: the design position of the body point that is at `worldPoint` in `state`. */
  designPointOf(state: CornerState, body: 'uca' | 'lca' | 'upright', worldPoint: Vec3): Vec3 {
    const g = this.geometry;
    const origin = body === 'uca' ? centroid(g.uca.fwd, g.uca.aft, g.uca.out)
      : body === 'lca' ? centroid(g.lca.fwd, g.lca.aft, g.lca.out)
        : centroid(g.uca.out, g.lca.out, g.tieRod.outer, g.wheel.center);
    const pose = state.poses[body]!;
    return add(origin, mulVec(transpose(pose.rotation), sub(worldPoint, pose.position)));
  }

  /** Design (static) state: all inputs zero. */
  design(): CornerState {
    return this.solve({});
  }

  solve(inputs: CornerInputs, initial?: Poses): CornerState {
    const full: Required<CornerInputs> = {
      travel: inputs.travel ?? 0,
      armAngle: inputs.armAngle ?? 0,
      rack: inputs.rack ?? 0,
      driver: inputs.driver ?? 'wheelCenter',
    };
    const { sys, refs } = this.build(full);
    const start: Poses = { ...sys.designPoses(), ...(initial ?? {}) };
    // Fixed bodies always take their input-driven pose.
    start.rack = {
      position: add(sys.getBody('rack').origin, scale(this.rackAxis, full.rack)),
      rotation: sys.designPoses().rack!.rotation,
    };
    start.chassis = sys.designPoses().chassis!;
    const result = sys.solve(start);
    const ctx = new PoseContext(result.poses);
    const spinAxis = normalize(ctx.direction('upright', this.spinAxisDesign));
    const wheelCenter = ctx.world(refs.wheelCenter);
    const g = this.geometry;
    const points: CornerPoints = {
      ucaFwd: g.uca.fwd, ucaAft: g.uca.aft, ucaOut: ctx.world(refs.ucaOut),
      lcaFwd: g.lca.fwd, lcaAft: g.lca.aft, lcaOut: ctx.world(refs.lcaOut),
      trInner: ctx.world(refs.trInner), trOuter: ctx.world(refs.trOuter),
      wheelCenter,
      contact: contactPoint(wheelCenter, spinAxis, g.wheel.radius),
    };
    if (refs.damperArm && g.damper) {
      points.damperChassis = g.damper.chassis;
      points.damperArm = ctx.world(refs.damperArm);
    }
    return { inputs: full, solve: result, poses: result.poses, points, spinAxis };
  }

  /**
   * Solve a list of inputs, continuing from neighbouring solutions so large ranges converge.
   * Results are returned in the same order as `values`.
   */
  sweep(values: number[], make: (v: number) => CornerInputs): CornerState[] {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array<CornerState>(values.length);
    // Start from the value closest to zero (design), then walk outward both ways.
    let startIdx = 0;
    order.forEach((o, k) => { if (Math.abs(o.v) < Math.abs(order[startIdx]!.v)) startIdx = k; });
    const first = this.solve(make(order[startIdx]!.v));
    out[order[startIdx]!.i] = first;
    let prev = first.poses;
    for (let k = startIdx + 1; k < order.length; k++) {
      const s = this.solve(make(order[k]!.v), prev);
      out[order[k]!.i] = s; prev = s.poses;
    }
    prev = first.poses;
    for (let k = startIdx - 1; k >= 0; k--) {
      const s = this.solve(make(order[k]!.v), prev);
      out[order[k]!.i] = s; prev = s.poses;
    }
    return out;
  }

  private build(inputs: Required<CornerInputs>) {
    const g = this.geometry;
    const sys = new ConstraintSystem();
    sys.addBody('chassis', { x: 0, y: 0, z: 0 }, { fixed: true });
    sys.addBody('rack', g.tieRod.inner, { fixed: true });
    const ucaOrigin = centroid(g.uca.fwd, g.uca.aft, g.uca.out);
    const lcaOrigin = centroid(g.lca.fwd, g.lca.aft, g.lca.out);
    const uprOrigin = centroid(g.uca.out, g.lca.out, g.tieRod.outer, g.wheel.center);
    sys.addBody('uca', ucaOrigin, { size: Math.max(dist(ucaOrigin, g.uca.out), 1) });
    sys.addBody('lca', lcaOrigin, { size: Math.max(dist(lcaOrigin, g.lca.out), 1) });
    sys.addBody('upright', uprOrigin, { size: Math.max(dist(g.uca.out, g.lca.out) / 2, 1) });

    sys.add(revolute(sys, 'UCA pivot', 'chassis', 'uca', g.uca.fwd, g.uca.aft));
    sys.add(revolute(sys, 'LCA pivot', 'chassis', 'lca', g.lca.fwd, g.lca.aft));
    sys.add(coincident('UCA ball joint', sys.attach('uca', g.uca.out), sys.attach('upright', g.uca.out)));
    sys.add(coincident('LCA ball joint', sys.attach('lca', g.lca.out), sys.attach('upright', g.lca.out)));
    const trInner = sys.attach('rack', g.tieRod.inner);
    const trOuter = sys.attach('upright', g.tieRod.outer);
    sys.add(fixedDistance('tie rod', trInner, trOuter, dist(g.tieRod.inner, g.tieRod.outer)));

    const wheelCenter = sys.attach('upright', g.wheel.center);
    const spin = this.spinAxisDesign;
    const radius = g.wheel.radius;
    switch (inputs.driver) {
      case 'wheelCenter':
        sys.add(coordinate('travel (wheel center)', wheelCenter, Y_AXIS, g.wheel.center.y + inputs.travel));
        break;
      case 'contactPatch': {
        const designContactY = contactPoint(g.wheel.center, spin, radius).y;
        sys.add(coordinate(
          'travel (contact patch)',
          (ctx) => contactPoint(ctx.world(wheelCenter), normalize(ctx.direction('upright', spin)), radius),
          Y_AXIS, designContactY + inputs.travel,
        ));
        break;
      }
      case 'lowerArmAngle':
        // Axis aft → fwd (+Z-ish) so a positive angle raises the outboard ball joint.
        sys.add(hingeAngle(sys, 'travel (LCA angle)', 'lca', g.lca.aft, g.lca.fwd, g.lca.out, inputs.armAngle));
        break;
    }

    const refs: CornerRefs = {
      ucaOut: sys.attach('upright', g.uca.out),
      lcaOut: sys.attach('upright', g.lca.out),
      trInner, trOuter, wheelCenter,
      damperArm: g.damper ? sys.attach(g.damper.arm, g.damper.armPoint) : undefined,
    };
    return { sys, refs };
  }
}

interface CornerRefs {
  ucaOut: PointRef; lcaOut: PointRef; trInner: PointRef; trOuter: PointRef; wheelCenter: PointRef;
  damperArm: PointRef | undefined;
}

/** Convenience: distance helpers used by checks and tests. */
export const linkLengths = (p: CornerPoints) => ({
  ucaFwd: length(sub(p.ucaOut, p.ucaFwd)),
  ucaAft: length(sub(p.ucaOut, p.ucaAft)),
  lcaFwd: length(sub(p.lcaOut, p.lcaFwd)),
  lcaAft: length(sub(p.lcaOut, p.lcaAft)),
  tieRod: length(sub(p.trOuter, p.trInner)),
  ballJoints: length(sub(p.ucaOut, p.lcaOut)),
  damper: p.damperChassis && p.damperArm ? length(sub(p.damperArm, p.damperChassis)) : undefined,
});
