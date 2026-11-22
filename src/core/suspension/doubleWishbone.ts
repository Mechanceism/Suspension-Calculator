/**
 * Corner kinematics (L1): double wishbone (SLA), MacPherson strut and five-link multilink, all built from
 * the same relations (docs/MATH.md § L1).
 *
 * Double wishbone:
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
 * MacPherson strut (bodies: chassis, rack, LCA, upright with the strut tube):
 *   LCA ↔ chassis revolute 5 · LCA ↔ upright ball joint 3 · strut axis (on the upright) through the
 *   top mount (chassis) 2 · tie rod 1 · travel 1                                 total 12 = 2 × 6
 *   The steering axis runs from the lower ball joint to the top mount.
 * Multilink, five links (bodies: chassis, rack, upright): each link is a rod with ball ends between a
 *   chassis point and an upright point (upper front, upper rear, lower front, lower rear, tie rod / toe
 *   link) 5 · travel 1                                                             total 6 = 1 × 6
 *   A double wishbone is the special case where each pair of links meets at one ball joint. The
 *   steering axis is virtual: through the points where each pair of links passes closest.
 *
 * Single arm (bodies: chassis, rack, arm, upright): the knuckle rides on the arm, turning only on a kingpin
 *   fixed to the arm (UCA_Out top, LCA_Out bottom); the arm pivots on the frame (LCA_Fwd – LCA_Aft):
 *   arm revolute 5 · kingpin revolute 5 · tie rod 1 · travel 1                      total 12 = 2 × 6
 *   The suspension's instant axis is the arm's pivot line. Pivot line along the car = swing arm (long-
 *   travel trophy-truck style), across it = trailing arm, angled = semi-trailing.
 * Twist beam (bodies: chassis, rack, the arm = the upright): the hub is fixed to its trailing arm. As a
 *   corner (both wheels in heave) the arm swings about the line through the two bushings (LCA_Fwd and its
 *   mirror): revolute 5 · travel 1 = 6. In roll each arm turns about the line from its bushing to the
 *   beam's shear center (LCA_Aft, on the centerline): the whole axle is a TwistBeam (two travels), which
 *   the car uses. The beam's twist stiffness is the axle's anti-roll bar.
 * No suspension (rigid; bodies: chassis, a "carrier" that only takes the travel input as a vertical shift,
 *   rack, upright): the upright turns on a fixed kingpin (UCA_Out top, LCA_Out bottom) for steering:
 *   revolute 5 · tie rod 1 = 6. Travel lifts the whole corner straight up (no camber or toe change); the
 *   vehicle and ride models hold a rigid corner's travel at 0, so only the tire is compliant.
 *
 * Pushrod / pullrod + rocker (any type but MacPherson and rigid): a rocker body on a frame pivot axis
 *   (revolute 5) and a pushrod of fixed length from an arm / the knuckle to the rocker (1) = 6, so it adds
 *   no freedom; the spring / damper then runs from the rocker to the frame.
 *
 * Pivot axes are NOT assumed parallel to Z and ball joints are NOT assumed centered between pivots.
 * Steering jacking is not a separate formula: moving the rack rotates the upright about the
 * UBJ–LBJ line and the solve produces the height change directly.
 */
import {
  type Vec3, vec3, add, sub, scale, length, normalize, rejectFrom, Y_AXIS, X_AXIS, distance as dist,
} from '../math/vec3';
import { mulVec, transpose, fromAxisAngle } from '../math/mat3';
import { TwistBeam, type TwistBeamGeometry } from './twistBeam';
import { SolidAxle, axleCharacteristics, mirroredLinks, type SolidAxleGeometry, type AxleState, type AxleCharacteristics } from './solidAxle';
import {
  ConstraintSystem, PoseContext, type Poses, type SolveResult, type PointRef,
  coincident, fixedDistance, revolute, coordinate, hingeAngle, pointOnLine,
} from '../solver/system';

/** Suspension type of a corner. */
export type SuspensionKind = 'doubleWishbone' | 'macpherson' | 'multilink' | 'singleArm' | 'twistBeam' | 'beam4' | 'beam3' | 'beamLeaf' | 'rigid';
export const SUSPENSION_KINDS: SuspensionKind[] = ['doubleWishbone', 'macpherson', 'multilink', 'singleArm', 'twistBeam', 'beam4', 'beam3', 'beamLeaf', 'rigid'];
/** Solid (beam) axle types: one design spans the whole axle (both wheels). */
export const isBeam = (k: SuspensionKind | undefined) => k === 'beam4' || k === 'beam3' || k === 'beamLeaf';
export const SUSPENSION_LABELS: Record<SuspensionKind, string> = {
  doubleWishbone: 'Double wishbone (SLA)', macpherson: 'MacPherson strut', multilink: 'Multilink (5 links)',
  singleArm: 'Single arm (swing / trailing arm, knuckle on the arm)',
  twistBeam: 'Twist beam (trailing arms on a twisting beam)',
  beam4: 'Solid axle, 4-link', beam3: 'Solid axle, 3-link + Panhard rod', beamLeaf: 'Solid axle on leaf springs', rigid: 'No suspension (rigid, e.g. a kart)',
};

export interface ArmPoints {
  /** Forward inboard pivot (larger Z). */
  readonly fwd: Vec3;
  /** Rearward inboard pivot (smaller Z). */
  readonly aft: Vec3;
  /** Outboard ball joint (multilink: the front link's upright end). */
  readonly out: Vec3;
  /** Multilink only: the rear link's upright end (the two links of a pair no longer share a ball joint). */
  readonly out2?: Vec3;
}

/**
 * Geometry of one corner, any type (`kind`, default double wishbone). The point names are shared:
 * MacPherson uses the lower arm, tie rod, wheel and the damper as the strut (the upper arm is ignored); multilink uses
 * both arms' pivots as the chassis ends of four links, with `out` / `out2` as their upright ends.
 */
export interface DoubleWishboneGeometry {
  readonly kind?: SuspensionKind;
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
  /**
   * Steering mechanism: a rack (TR_In slides along rackAxis by the rack input, mm; default) or a steering
   * arm / plate (TR_In swings about the axis pivot1 → pivot2 by the input in degrees): an ATV-style plate
   * on the steering column, or a pitman / idler arm driving a center link (each inner joint then moves on
   * the arm's circle).
   */
  readonly steering?: { readonly kind: 'rack' } | { readonly kind: 'arm'; readonly pivot1: Vec3; readonly pivot2: Vec3 };
  /**
   * Pushrod (or pullrod) and rocker: the rocker pivots on the frame axis pivot1 → pivot2; the pushrod
   * runs from `pushrodLower` (on `pushrodBody`) to `pushrodUpper` (on the rocker). The damper's armPoint
   * is then on the rocker (damper.arm = 'rocker').
   */
  /** Solid axle, 3-link: the Panhard rod (frame end — usually on the other side — and axle end). */
  readonly panhard?: { readonly chassis: Vec3; readonly axle: Vec3 };
  readonly rocker?: {
    readonly pivot1: Vec3; readonly pivot2: Vec3;
    readonly pushrodBody: MountBody; readonly pushrodLower: Vec3; readonly pushrodUpper: Vec3;
  };
  /**
   * Optional spring/damper: chassis mount and a mount on an arm, the upright or the rocker. MacPherson:
   * required, it is the strut (chassis = the top mount, armPoint = a point on the strut axis fixed to the upright).
   */
  readonly damper?: { readonly chassis: Vec3; readonly arm: MountBody; readonly armPoint: Vec3 };
}

/** Any corner type's geometry. */
export type CornerGeometry = DoubleWishboneGeometry;
/** Moving body a mount is fixed to. */
export type MountBody = 'uca' | 'lca' | 'upright' | 'rocker';
export const kindOf = (g: DoubleWishboneGeometry): SuspensionKind => g.kind ?? 'doubleWishbone';
/** MacPherson strut: top mount and its point on the upright (the damper's two mounts). */
export const strutOf = (g: DoubleWishboneGeometry): { top: Vec3; lower: Vec3 } | null =>
  (g.damper ? { top: g.damper.chassis, lower: g.damper.armPoint } : null);

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
  /** Steering (kingpin) axis: lower and upper points (ball joints; MacPherson: LBJ and top mount; multilink: virtual pivots). */
  steerLower: Vec3;
  steerUpper: Vec3;
  /** Multilink: the rear links' upright ends. */
  ucaOut2?: Vec3;
  lcaOut2?: Vec3;
  /** MacPherson: strut top mount (chassis) and the strut's point on the upright. */
  strutTop?: Vec3;
  strutLower?: Vec3;
  /** Steering-arm mechanism: its pivot axis (frame). */
  steerPivot1?: Vec3;
  steerPivot2?: Vec3;
  /** Solid axle: the Panhard rod's ends now, and the right wheel's center (the axle's other end). */
  panhardChassis?: Vec3;
  panhardAxle?: Vec3;
  axleRight?: Vec3;
  /** Leaf springs: the front eye and rear shackle (frame), for drawing. */
  leafEye?: Vec3;
  leafShackle?: Vec3;
  /** Rocker layout: the rocker's pivot axis (frame) and the pushrod's two ends. */
  rockerPivot1?: Vec3;
  rockerPivot2?: Vec3;
  pushrodLower?: Vec3;
  pushrodUpper?: Vec3;
}

export interface CornerState {
  readonly kind: SuspensionKind;
  /** Solid axle: the whole axle's state and characteristics (the corner shows its left wheel in heave). */
  readonly axle?: { state: AxleState; chars: AxleCharacteristics };
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
  readonly kind: SuspensionKind;
  /** Moving bodies of this type (a mount on a body it doesn't have goes on the upright). */
  readonly bodies: MountBody[];
  private readonly spinAxisDesign: Vec3;

  /** Solid axle types: the axle itself. */
  readonly solidAxle: SolidAxle | null = null;
  /** Twist beam: the whole axle (two travels). */
  readonly twistBeam: TwistBeam | null = null;

  constructor(readonly geometry: DoubleWishboneGeometry) {
    this.rackAxis = normalize(geometry.rackAxis ?? X_AXIS);
    this.spinAxisDesign = normalize(geometry.wheel.spinAxis);
    this.kind = kindOf(geometry);
    if (isBeam(this.kind)) {
      this.bodies = ['upright'];
      this.solidAxle = new SolidAxle(solidAxleOf(geometry));
      return;
    }
    const sa = geometry.steering;
    if (sa?.kind === 'arm' && dist(sa.pivot1, sa.pivot2) < 1e-6) throw new Error('Degenerate geometry: steering arm pivot axis points coincide');
    const rk = geometry.rocker;
    if (rk) {
      if (this.kind === 'macpherson' || this.kind === 'rigid') throw new Error('A pushrod and rocker needs an arm or knuckle to push from (not a MacPherson strut or a rigid corner)');
      if (dist(rk.pivot1, rk.pivot2) < 1e-6) throw new Error('Degenerate geometry: rocker pivot axis points coincide');
      if (dist(rk.pushrodLower, rk.pushrodUpper) < 1e-6) throw new Error('Degenerate geometry: pushrod ends coincide');
    }
    this.bodies = this.kind === 'doubleWishbone' ? ['uca', 'lca', 'upright'] : this.kind === 'macpherson' || this.kind === 'singleArm' ? ['lca', 'upright'] : ['upright'];
    if (this.kind === 'twistBeam') {
      this.bodies = ['upright'];
      this.twistBeam = new TwistBeam(twistBeamOf(geometry));
      if (dist(geometry.lca.fwd, geometry.lca.aft) < 1e-6) throw new Error('Degenerate geometry: the arm bushing and the beam shear center coincide');
      return;
    }
    if (this.kind === 'singleArm') {
      const g = geometry;
      for (const [label, a, b] of [['arm pivots', g.lca.fwd, g.lca.aft], ['kingpin top and bottom', g.uca.out, g.lca.out], ['tie rod', g.tieRod.inner, g.tieRod.outer]] as const) {
        if (dist(a, b) < 1e-6) throw new Error(`Degenerate geometry: ${label} coincide`);
      }
      return;
    }
    if (this.kind === 'rigid') {
      if (dist(geometry.uca.out, geometry.lca.out) < 1e-6) throw new Error('Degenerate geometry: kingpin top and bottom coincide');
      if (dist(geometry.tieRod.inner, geometry.tieRod.outer) < 1e-6) throw new Error('Degenerate geometry: tie rod coincide');
      return;
    }
    const g = geometry;
    const pairs: [string, Vec3, Vec3][] = [['tie rod', g.tieRod.inner, g.tieRod.outer], ['LCA pivots', g.lca.fwd, g.lca.aft]];
    if (this.kind === 'doubleWishbone') pairs.push(['UCA pivots', g.uca.fwd, g.uca.aft], ['ball joints', g.uca.out, g.lca.out]);
    if (this.kind === 'macpherson') {
      const st = strutOf(g);
      if (!st) throw new Error('MacPherson strut: the strut (damper) top mount and lower point are missing');
      pairs.push(['strut points', st.top, st.lower], ['lower ball joint and strut top', g.lca.out, st.top]);
    }
    if (this.kind === 'multilink') {
      const l = multiLinks(g);
      for (const k of l) pairs.push([`${k.name} link ends`, k.chassis, k.upright]);
      pairs.push(['upper links', g.uca.fwd, g.uca.aft]);
    }
    for (const [label, a, b] of pairs) {
      if (dist(a, b) < 1e-6) throw new Error(`Degenerate geometry: ${label} coincide`);
    }
  }

  /** Body origin (design coordinates) of a moving body. */
  private originOf(body: MountBody): Vec3 {
    const g = this.geometry;
    if (body === 'rocker' && g.rocker) return centroid(g.rocker.pivot1, g.rocker.pivot2, g.rocker.pushrodUpper, ...(g.damper ? [g.damper.armPoint] : []));
    if (body === 'uca') return centroid(g.uca.fwd, g.uca.aft, g.uca.out);
    if (body === 'lca') return centroid(g.lca.fwd, g.lca.aft, g.lca.out);
    if (this.kind === 'macpherson') return centroid(g.lca.out, strutOf(g)!.lower, g.tieRod.outer, g.wheel.center);
    if (this.kind === 'multilink') return centroid(g.uca.out, g.uca.out2 ?? g.uca.out, g.lca.out, g.lca.out2 ?? g.lca.out, g.tieRod.outer, g.wheel.center);
    if (this.kind === 'twistBeam') return centroid(g.lca.fwd, g.lca.out, g.wheel.center);
    return centroid(g.uca.out, g.lca.out, g.tieRod.outer, g.wheel.center);
  }

  /** The body a mount ends up on for this type (the upright when this type has no such arm). */
  mountBody(body: MountBody): MountBody {
    if (body === 'rocker') return this.geometry.rocker ? 'rocker' : 'upright';
    return this.bodies.includes(body) ? body : 'upright';
  }

  /**
   * Where a point fixed to one of the moving bodies (given at its design position) is in a solved
   * state — e.g. an anti-roll-bar drop-link mount on the lower arm.
   */
  pointOn(state: CornerState, body: MountBody, designPoint: Vec3): Vec3 {
    const b = this.mountBody(body);
    return new PoseContext(state.poses).world({ body: b, local: sub(designPoint, this.originOf(b)) });
  }

  /** Inverse of pointOn: the design position of the body point that is at `worldPoint` in `state`. */
  designPointOf(state: CornerState, body: MountBody, worldPoint: Vec3): Vec3 {
    const b = this.mountBody(body);
    const pose = state.poses[b]!;
    return add(this.originOf(b), mulVec(transpose(pose.rotation), sub(worldPoint, pose.position)));
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
    if (this.solidAxle) return this.solveBeam(full, initial);
    const { sys, refs } = this.build(full);
    const start: Poses = { ...sys.designPoses(), ...(initial ?? {}) };
    // Fixed bodies always take their input-driven pose.
    const st = this.geometry.steering;
    if (st?.kind === 'arm') {
      // The steering arm turns by the input (degrees) about its pivot axis; the inner joint rides on it.
      const R = fromAxisAngle(normalize(sub(st.pivot2, st.pivot1)), (full.rack * Math.PI) / 180);
      const o = sys.getBody('rack').origin;
      start.rack = { position: add(st.pivot1, mulVec(R, sub(o, st.pivot1))), rotation: R };
    } else {
      start.rack = {
        position: add(sys.getBody('rack').origin, scale(this.rackAxis, full.rack)),
        rotation: sys.designPoses().rack!.rotation,
      };
    }
    start.chassis = sys.designPoses().chassis!;
    if (this.kind === 'rigid') {
      // The whole corner shifts up by the travel; the rack goes with it (nothing moves relative to the frame).
      const up = { x: 0, y: full.travel, z: 0 };
      start.carrier = { position: add(sys.getBody('carrier').origin, up), rotation: sys.designPoses().carrier!.rotation };
      start.rack = { ...start.rack, position: add(start.rack.position, up) };
    }
    const result = sys.solve(start);
    const ctx = new PoseContext(result.poses);
    const spinAxis = normalize(ctx.direction('upright', this.spinAxisDesign));
    const wheelCenter = ctx.world(refs.wheelCenter);
    const g = this.geometry;
    const ucaOut = ctx.world(refs.ucaOut), lcaOut = ctx.world(refs.lcaOut);
    const points: CornerPoints = {
      ucaFwd: g.uca.fwd, ucaAft: g.uca.aft, ucaOut,
      lcaFwd: g.lca.fwd, lcaAft: g.lca.aft, lcaOut,
      trInner: ctx.world(refs.trInner), trOuter: ctx.world(refs.trOuter),
      wheelCenter,
      contact: contactPoint(wheelCenter, spinAxis, g.wheel.radius),
      steerLower: lcaOut, steerUpper: ucaOut,
    };
    if (this.kind === 'macpherson') {
      points.strutTop = strutOf(g)!.top;
      points.strutLower = ctx.world(refs.strutLower!);
      points.steerUpper = points.strutTop;
    }
    if (this.kind === 'twistBeam') {
      // No steering: a vertical line through the wheel. The shear center moves with the arms in heave.
      points.steerLower = points.contact; points.steerUpper = add(wheelCenter, scale(Y_AXIS, 100));
      points.lcaAft = ctx.world({ body: 'upright', local: sub(g.lca.aft, this.originOf('upright')) });
    }
    if (this.kind === 'multilink') {
      points.ucaOut2 = ctx.world(refs.ucaOut2!);
      points.lcaOut2 = ctx.world(refs.lcaOut2!);
      points.steerUpper = virtualPivot(g.uca.fwd, ucaOut, g.uca.aft, points.ucaOut2);
      points.steerLower = virtualPivot(g.lca.fwd, lcaOut, g.lca.aft, points.lcaOut2);
    }
    if (refs.damperArm && g.damper) {
      points.damperChassis = g.damper.chassis;
      points.damperArm = ctx.world(refs.damperArm);
    }
    if (g.steering?.kind === 'arm') { points.steerPivot1 = g.steering.pivot1; points.steerPivot2 = g.steering.pivot2; }
    if (g.rocker && refs.pushrodLower && refs.pushrodUpper) {
      points.rockerPivot1 = g.rocker.pivot1;
      points.rockerPivot2 = g.rocker.pivot2;
      points.pushrodLower = ctx.world(refs.pushrodLower);
      points.pushrodUpper = ctx.world(refs.pushrodUpper);
    }
    return { kind: this.kind, inputs: full, solve: result, poses: result.poses, points, spinAxis };
  }

  /**
   * Solid axle as a corner: the axle heaves by the travel (both wheels), and the corner is its left wheel.
   * The links show as the arm points (lower: LCA_Fwd → LCA_Out, upper: UCA_Fwd → UCA_Out); the steering
   * axis is a vertical line through the wheel (a beam axle here doesn't steer).
   */
  private solveBeam(full: Required<CornerInputs>, initial?: Poses): CornerState {
    const ax = this.solidAxle!;
    const st = ax.solve({ left: full.travel, right: full.travel }, initial);
    const g = this.geometry;
    const find = (name: string) => st.links.find((l) => l.name === name);
    const lower = find('lower (left)'), upper = find('upper (left)') ?? find('upper (center)');
    const pan = find('Panhard rod');
    const w = st.left;
    const points: CornerPoints = {
      ucaFwd: g.uca.fwd, ucaAft: g.uca.fwd, ucaOut: upper?.axle ?? g.uca.out,
      lcaFwd: g.lca.fwd, lcaAft: g.lca.fwd, lcaOut: lower?.axle ?? g.lca.out,
      trInner: g.tieRod.inner, trOuter: g.tieRod.outer,
      wheelCenter: w.center, contact: w.contact,
      steerLower: w.contact, steerUpper: add(w.center, scale(Y_AXIS, 100)),
      ...(pan ? { panhardChassis: pan.chassis, panhardAxle: pan.axle } : {}),
      axleRight: st.right.center,
    };
    const springs = ax.geometry.springs;
    if (springs && st.springLength) {
      // The left spring's axle end: where the axle carries it now.
      const R = st.poses.axle!.rotation, o = st.poses.axle!.position;
      const c0 = scale(add(g.wheel.center, vec3(-g.wheel.center.x, g.wheel.center.y, g.wheel.center.z)), 0.5);
      points.damperChassis = springs.left.chassis;
      points.damperArm = add(o, mulVec(R, sub(springs.left.axle, c0)));
    }
    if (this.kind === 'beamLeaf') { points.leafEye = g.lca.fwd; points.leafShackle = g.lca.aft; }
    let chars: AxleCharacteristics | null = null;
    try { chars = axleCharacteristics(ax, st); } catch { chars = null; }
    return { kind: this.kind, inputs: full, solve: st.solve, poses: st.poses, points, spinAxis: w.spinAxis, ...(chars ? { axle: { state: st, chars } } : {}) };
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
    const uprOrigin = this.originOf('upright');
    if (this.kind === 'doubleWishbone') {
      const ucaOrigin = this.originOf('uca');
      const lcaOrigin = this.originOf('lca');
      sys.addBody('uca', ucaOrigin, { size: Math.max(dist(ucaOrigin, g.uca.out), 1) });
      sys.addBody('lca', lcaOrigin, { size: Math.max(dist(lcaOrigin, g.lca.out), 1) });
      sys.addBody('upright', uprOrigin, { size: Math.max(dist(g.uca.out, g.lca.out) / 2, 1) });
      sys.add(revolute(sys, 'UCA pivot', 'chassis', 'uca', g.uca.fwd, g.uca.aft));
      sys.add(revolute(sys, 'LCA pivot', 'chassis', 'lca', g.lca.fwd, g.lca.aft));
      sys.add(coincident('UCA ball joint', sys.attach('uca', g.uca.out), sys.attach('upright', g.uca.out)));
      sys.add(coincident('LCA ball joint', sys.attach('lca', g.lca.out), sys.attach('upright', g.lca.out)));
    } else if (this.kind === 'macpherson') {
      const st = strutOf(g)!;
      const lcaOrigin = this.originOf('lca');
      sys.addBody('lca', lcaOrigin, { size: Math.max(dist(lcaOrigin, g.lca.out), 1) });
      sys.addBody('upright', uprOrigin, { size: Math.max(dist(st.top, g.lca.out) / 2, 1) });
      sys.add(revolute(sys, 'LCA pivot', 'chassis', 'lca', g.lca.fwd, g.lca.aft));
      sys.add(coincident('LCA ball joint', sys.attach('lca', g.lca.out), sys.attach('upright', g.lca.out)));
      sys.add(pointOnLine(sys, 'strut through the top mount', 'upright', st.lower, st.top, st.top));
    } else if (this.kind === 'twistBeam') {
      // The arm carries the hub: it is the upright here.
      sys.addBody('upright', uprOrigin, { size: Math.max(dist(g.lca.fwd, g.wheel.center) / 2, 1) });
      sys.add(revolute(sys, 'arm pivot (bushing line)', 'chassis', 'upright', g.lca.fwd, add(g.lca.fwd, scale(X_AXIS, 100))));
    } else if (this.kind === 'singleArm') {
      const lcaOrigin = this.originOf('lca');
      sys.addBody('lca', lcaOrigin, { size: Math.max(dist(lcaOrigin, g.lca.out), 1) });
      sys.addBody('upright', uprOrigin, { size: Math.max(dist(g.uca.out, g.lca.out) / 2, 1) });
      sys.add(revolute(sys, 'arm pivot', 'chassis', 'lca', g.lca.fwd, g.lca.aft));
      sys.add(revolute(sys, 'kingpin', 'lca', 'upright', g.lca.out, g.uca.out));
    } else if (this.kind === 'rigid') {
      sys.addBody('carrier', { x: 0, y: 0, z: 0 }, { fixed: true });
      sys.addBody('upright', uprOrigin, { size: Math.max(dist(g.uca.out, g.lca.out) / 2, 1) });
      sys.add(revolute(sys, 'kingpin', 'carrier', 'upright', g.lca.out, g.uca.out));
    } else {
      sys.addBody('upright', uprOrigin, { size: Math.max(dist(g.uca.out, g.lca.out) / 2, 1) });
      for (const l of multiLinks(g)) {
        sys.add(fixedDistance(`${l.name} link`, sys.attach('chassis', l.chassis), sys.attach('upright', l.upright), dist(l.chassis, l.upright)));
      }
    }
    // Rocker and pushrod (the arm bodies exist by now).
    let pushrodLower: PointRef | undefined, pushrodUpper: PointRef | undefined;
    if (g.rocker) {
      const r = g.rocker;
      const o = this.originOf('rocker');
      sys.addBody('rocker', o, { size: Math.max(dist(o, r.pushrodUpper), 1) });
      sys.add(revolute(sys, 'rocker pivot', 'chassis', 'rocker', r.pivot1, r.pivot2));
      pushrodLower = sys.attach(this.mountBody(r.pushrodBody === 'rocker' ? 'lca' : r.pushrodBody), r.pushrodLower);
      pushrodUpper = sys.attach('rocker', r.pushrodUpper);
      sys.add(fixedDistance('pushrod', pushrodLower, pushrodUpper, dist(r.pushrodLower, r.pushrodUpper)));
    }
    const trInner = sys.attach('rack', g.tieRod.inner);
    const trOuter = sys.attach('upright', g.tieRod.outer);
    // (A twist beam doesn't steer: its arm is fully located by the bushing line.)
    if (this.kind !== 'twistBeam') sys.add(fixedDistance('tie rod', trInner, trOuter, dist(g.tieRod.inner, g.tieRod.outer)));

    const wheelCenter = sys.attach('upright', g.wheel.center);
    const spin = this.spinAxisDesign;
    const radius = g.wheel.radius;
    if (this.kind !== 'rigid') switch (inputs.driver) {
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
        // Axis aft → fwd (+Z-ish) so a positive angle raises the outboard ball joint. Multilink: the lower
        // front link's upright end turning about the two lower chassis points (a virtual arm).
        sys.add(hingeAngle(sys, 'travel (LCA angle)', this.kind === 'multilink' ? 'upright' : 'lca', g.lca.aft, g.lca.fwd, g.lca.out, inputs.armAngle));
        break;
    }

    const refs: CornerRefs = {
      // MacPherson has no upper arm: its "upper ball joint" reads as the strut top (a fixed point).
      ucaOut: sys.attach(this.kind === 'macpherson' ? 'chassis' : 'upright', this.kind === 'macpherson' ? strutOf(g)!.top : g.uca.out),
      lcaOut: sys.attach('upright', g.lca.out),
      trInner, trOuter, wheelCenter,
      damperArm: g.damper ? sys.attach(this.mountBody(g.damper.arm), g.damper.armPoint) : undefined,
      ...(this.kind === 'macpherson' ? { strutLower: sys.attach('upright', strutOf(g)!.lower) } : {}),
      ...(pushrodLower && pushrodUpper ? { pushrodLower, pushrodUpper } : {}),
      ...(this.kind === 'multilink' ? { ucaOut2: sys.attach('upright', g.uca.out2 ?? g.uca.out), lcaOut2: sys.attach('upright', g.lca.out2 ?? g.lca.out) } : {}),
    };
    return { sys, refs };
  }
}

interface CornerRefs {
  ucaOut: PointRef; lcaOut: PointRef; trInner: PointRef; trOuter: PointRef; wheelCenter: PointRef;
  damperArm: PointRef | undefined;
  strutLower?: PointRef; ucaOut2?: PointRef; lcaOut2?: PointRef;
  pushrodLower?: PointRef; pushrodUpper?: PointRef;
}

/** The four arm links of a multilink corner (chassis end → upright end); the tie rod is the fifth. */
export function multiLinks(g: DoubleWishboneGeometry): { name: string; chassis: Vec3; upright: Vec3 }[] {
  return [
    { name: 'upper front', chassis: g.uca.fwd, upright: g.uca.out },
    { name: 'upper rear', chassis: g.uca.aft, upright: g.uca.out2 ?? g.uca.out },
    { name: 'lower front', chassis: g.lca.fwd, upright: g.lca.out },
    { name: 'lower rear', chassis: g.lca.aft, upright: g.lca.out2 ?? g.lca.out },
  ];
}

/**
 * Virtual pivot of two links (a1 → b1, a2 → b2): the midpoint of the shortest segment between their
 * lines, where the pair acts like one ball joint (multilink virtual steering axis). Parallel links: the
 * midpoint of their upright ends.
 */
export function virtualPivot(a1: Vec3, b1: Vec3, a2: Vec3, b2: Vec3): Vec3 {
  const d1 = sub(b1, a1), d2 = sub(b2, a2), r = sub(a1, a2);
  const a = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z, e = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z;
  const b = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z;
  const c = d1.x * r.x + d1.y * r.y + d1.z * r.z, f = d2.x * r.x + d2.y * r.y + d2.z * r.z;
  const den = a * e - b * b;
  if (!(Math.abs(den) > 1e-9 * a * e)) return scale(add(b1, b2), 0.5);
  const s = (b * f - c * e) / den, t = (a * f - b * c) / den;
  return scale(add(add(a1, scale(d1, s)), add(a2, scale(d2, t))), 0.5);
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

/**
 * The solid axle a beam-type design describes (left-side points; the right side mirrors): lower links
 * LCA_Fwd → LCA_Out, upper links UCA_Fwd → UCA_Out (4-link: one per side; 3-link: one in the middle, as
 * given), the Panhard rod (3-link), the spring Dmp_Chs → Dmp_Arm per side, the wheel.
 */
export function solidAxleOf(g: DoubleWishboneGeometry): SolidAxleGeometry {
  const kind = kindOf(g);
  if (kind === 'beamLeaf') return leafAxleOf(g);
  const lower = mirroredLinks([{ name: 'lower', chassis: g.lca.fwd, axle: g.lca.out }]);
  const links = kind === 'beam3'
    ? [...lower, { name: 'upper (center)', chassis: g.uca.fwd, axle: g.uca.out }, ...(g.panhard ? [{ name: 'Panhard rod', chassis: g.panhard.chassis, axle: g.panhard.axle }] : [])]
    : [...lower, ...mirroredLinks([{ name: 'upper', chassis: g.uca.fwd, axle: g.uca.out }])];
  return {
    kind: 'solidAxle',
    wheel: { center: g.wheel.center, spinAxis: g.wheel.spinAxis, radius: g.wheel.radius, ...(g.wheel.width ? { width: g.wheel.width } : {}) },
    links,
    ...(g.damper ? { springs: { left: { chassis: g.damper.chassis, axle: g.damper.armPoint } } } : {}),
  };
}

/**
 * Solid axle on leaf springs (SAE 3-link equivalent; docs/MATH.md § L1): per side the leaf's front half acts
 * like a link from a pivot a quarter of the way from the front eye (LCA_Fwd) to the spring seat (LCA_Out,
 * on the axle), so the seat moves on that ¾-length arc; a stiff virtual link in the middle holds the axle's
 * wind-up (it keeps its pitch, like a parallelogram), and a long virtual lateral link at seat height
 * locates it sideways (the leaves are stiff sideways: roll center ≈ seat height). The leaf's rate is a
 * vertical spring at each seat (its rate = the leaf rate at the seat; as long as the design's coilover was,
 * so its free length, damper stroke and bump stop still fit).
 */
export function leafAxleOf(g: DoubleWishboneGeometry): SolidAxleGeometry {
  const eye = g.lca.fwd, seat = g.lca.out;
  const L = g.damper ? Math.max(dist(g.damper.chassis, g.damper.armPoint), 1) : 400;
  const piv = add(eye, scale(sub(seat, eye), 0.25));
  return {
    kind: 'solidAxle',
    wheel: { center: g.wheel.center, spinAxis: g.wheel.spinAxis, radius: g.wheel.radius, ...(g.wheel.width ? { width: g.wheel.width } : {}) },
    links: [
      ...mirroredLinks([{ name: 'lower', chassis: piv, axle: seat }]),
      { name: 'upper (center)', chassis: vec3(0, piv.y + 150, piv.z), axle: vec3(0, seat.y + 150, seat.z) },
      { name: 'leaf lateral (virtual)', chassis: vec3(-seat.x - 1500, seat.y, seat.z), axle: seat },
    ],
    springs: { left: { chassis: add(seat, vec3(0, L, 0)), axle: seat } },
  };
}

/** The twist-beam axle a twistBeam design describes (bushing LCA_Fwd, shear center LCA_Aft, coilover on the arm). */
export function twistBeamOf(g: DoubleWishboneGeometry): TwistBeamGeometry {
  return {
    kind: 'twistBeam',
    wheel: { center: g.wheel.center, spinAxis: g.wheel.spinAxis, radius: g.wheel.radius, ...(g.wheel.width ? { width: g.wheel.width } : {}) },
    bushing: g.lca.fwd, shearCenter: g.lca.aft,
    ...(g.damper ? { spring: { chassis: g.damper.chassis, arm: g.damper.armPoint } } : {}),
  };
}
