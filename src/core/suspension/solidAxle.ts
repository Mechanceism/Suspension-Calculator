/**
 * Solid (beam) axle kinematics (docs/MATH.md § L1, solid axle): one rigid axle carries both wheels and is
 * located by links to the frame. Coordinates: x left of the centerline, y up, z forward from the axle line
 * (the vehicle frame shifted to this axle).
 *
 *   axle body: 6 DOF − 4 link equations (rods with ball ends, fixed lengths) = 2 DOF
 *   inputs:    left and right wheel-center travel (vertical, mm) → 2 driver equations
 *
 * Link sets that give 4 equations: 4-link (two lower trailing links + two upper links angled to locate the
 * axle sideways), 3-link + Panhard rod, or the leaf-spring equivalent (see leafLinks). Rolling the axle
 * (left up, right down) and heaving it give the roll center, roll steer, the side-view instant center and
 * the axle's wind-up (pinion angle change).
 */
import { type Vec3, vec3, add, sub, scale, cross, normalize, length, distance as dist, Y_AXIS } from '../math/vec3';
import type { Mat3 } from '../math/mat3';
import { ConstraintSystem, PoseContext, type Poses, type SolveResult, type PointRef, fixedDistance, coordinate } from '../solver/system';
import { contactPoint } from './doubleWishbone';

export interface AxleLink {
  name: string;
  /** Frame end and axle end, mm. */
  chassis: Vec3;
  axle: Vec3;
}

export interface SolidAxleGeometry {
  readonly kind: 'solidAxle';
  /** The left wheel (x > 0): center, spin axis (outboard; static camber / toe), rolling radius. The right one mirrors it. */
  readonly wheel: { readonly center: Vec3; readonly spinAxis: Vec3; readonly radius: number; readonly width?: number };
  /** Links locating the axle: four equations in total (4-link, 3-link + Panhard, leaf equivalent). */
  readonly links: readonly AxleLink[];
  /** Coilovers / spring seats: frame end and axle end per side (left; the right mirrors unless given). */
  readonly springs?: { readonly left: { chassis: Vec3; axle: Vec3 }; readonly right?: { chassis: Vec3; axle: Vec3 } };
}

export interface AxleInputs { left?: number; right?: number }

export interface AxleWheel { center: Vec3; spinAxis: Vec3; contact: Vec3 }

export interface AxleState {
  inputs: { left: number; right: number };
  solve: SolveResult;
  poses: Poses;
  left: AxleWheel;
  right: AxleWheel;
  /** Each link's axle end now. */
  links: { name: string; chassis: Vec3; axle: Vec3 }[];
  /** Spring lengths (mount to mount), mm. */
  springLength?: { left: number; right: number };
}

const mirror = (p: Vec3): Vec3 => vec3(-p.x, p.y, p.z);
const mid = (a: Vec3, b: Vec3) => scale(add(a, b), 0.5);

export class SolidAxle {
  private readonly rightCenter: Vec3;
  private readonly spinL: Vec3;
  private readonly spinR: Vec3;

  constructor(readonly geometry: SolidAxleGeometry) {
    const g = geometry;
    this.rightCenter = mirror(g.wheel.center);
    this.spinL = normalize(g.wheel.spinAxis);
    this.spinR = mirror(this.spinL);
    if (g.links.length < 1) throw new Error('A solid axle needs links to locate it');
    for (const l of g.links) if (dist(l.chassis, l.axle) < 1e-6) throw new Error(`Degenerate geometry: ${l.name} link ends coincide`);
    if (Math.abs(g.wheel.center.x) < 1e-6) throw new Error('Degenerate geometry: the wheel center is on the centerline');
  }

  /** Spring mounts (left given; right mirrored unless given). */
  private springMounts() {
    const s = this.geometry.springs;
    if (!s) return null;
    return { left: s.left, right: s.right ?? { chassis: mirror(s.left.chassis), axle: mirror(s.left.axle) } };
  }

  design(): AxleState { return this.solve({}); }

  solve(inputs: AxleInputs, initial?: Poses): AxleState {
    const qL = inputs.left ?? 0, qR = inputs.right ?? 0;
    const g = this.geometry;
    const sys = new ConstraintSystem();
    sys.addBody('chassis', vec3(0, 0, 0), { fixed: true });
    const origin = mid(g.wheel.center, this.rightCenter);
    sys.addBody('axle', origin, { size: Math.max(Math.abs(g.wheel.center.x), 1) });
    const refs = g.links.map((l) => ({ l, a: sys.attach('axle', l.axle) as PointRef }));
    for (const { l, a } of refs) sys.add(fixedDistance(`${l.name} link`, sys.attach('chassis', l.chassis), a, dist(l.chassis, l.axle)));
    const wl = sys.attach('axle', g.wheel.center), wr = sys.attach('axle', this.rightCenter);
    sys.add(coordinate('left travel', wl, Y_AXIS, g.wheel.center.y + qL));
    sys.add(coordinate('right travel', wr, Y_AXIS, this.rightCenter.y + qR));
    const sp = this.springMounts();
    const spL = sp ? sys.attach('axle', sp.left.axle) : null, spR = sp ? sys.attach('axle', sp.right.axle) : null;
    const result = sys.solve({ ...sys.designPoses(), ...(initial ?? {}), chassis: sys.designPoses().chassis! });
    const ctx = new PoseContext(result.poses);
    const wheel = (c: PointRef, spin: Vec3): AxleWheel => {
      const center = ctx.world(c);
      const spinAxis = normalize(ctx.direction('axle', spin));
      return { center, spinAxis, contact: contactPoint(center, spinAxis, g.wheel.radius) };
    };
    return {
      inputs: { left: qL, right: qR }, solve: result, poses: result.poses,
      left: wheel(wl, this.spinL), right: wheel(wr, this.spinR),
      links: refs.map(({ l, a }) => ({ name: l.name, chassis: l.chassis, axle: ctx.world(a) })),
      ...(sp && spL && spR ? { springLength: { left: length(sub(ctx.world(spL), sp.left.chassis)), right: length(sub(ctx.world(spR), sp.right.chassis)) } } : {}),
    };
  }
}

export interface AxleCharacteristics {
  /** Per wheel: camber (+ top outboard) and toe (+ in), rad; half track (contact |x|), mm. */
  camber: { left: number; right: number };
  toe: { left: number; right: number };
  halfTrack: { left: number; right: number };
  /** Roll center height above the ground (axle rolling about it relative to the body), mm, and its lateral position (+ left). */
  rollCenterHeight: number | null;
  rollCenterX: number | null;
  /** Roll steer: the axle's yaw per degree of its roll relative to the body (deg/deg; + = steers left when the left side rises). */
  rollSteer: number;
  /** Side-view instant center of the axle in heave (y, z), and its angle from the contact patch (anti-squat / anti-dive). */
  sideViewIC: { y: number; z: number } | null;
  antiAngleContact: number;
  /** Axle wind-up: its pitch per mm of heave (deg/mm, + = top of the axle rotates forward). */
  windUp: number;
  /** Lateral shift of the axle per mm of heave (Panhard rod arc), mm/mm. */
  lateralShift: number;
}

const D = Math.PI / 180;

/**
 * The axle's rotation between two poses, rad: roll about +Z (left side up = +), yaw about +Y (front toward
 * the left = +), pitch about +X (top forward = +), from where its own X and Z axes point.
 */
function rotBetween(a: AxleState, b: AxleState): { roll: number; yaw: number; pitch: number } {
  const col = (R: Mat3, j: number) => vec3(R[j]!, R[3 + j]!, R[6 + j]!);
  const R0 = a.poses.axle!.rotation, R1 = b.poses.axle!.rotation;
  const x0 = col(R0, 0), x1 = col(R1, 0), z0 = col(R0, 2), z1 = col(R1, 2);
  return {
    roll: Math.atan2(x1.y, x1.x) - Math.atan2(x0.y, x0.x),
    yaw: Math.atan2(-x1.z, x1.x) - Math.atan2(-x0.z, x0.x),
    pitch: Math.atan2(-z1.y, z1.z) - Math.atan2(-z0.y, z0.z),
  };
}

/** Characteristics at a solved state (± h mm in roll and heave for the instant centers and rates). */
export function axleCharacteristics(axle: SolidAxle, s: AxleState, h = 1): AxleCharacteristics {
  // Camber + = top outboard (each wheel's own outboard spin axis), toe + = in (the right wheel mirrored).
  const camberOf = (w: AxleWheel) => Math.asin(Math.max(-1, Math.min(1, -w.spinAxis.y)));
  const toeOf = (w: AxleWheel, side: 1 | -1) => {
    const a = vec3(side * w.spinAxis.x, w.spinAxis.y, w.spinAxis.z); // left-hand frame for the right wheel
    const heading = normalize(cross(a, Y_AXIS));
    return Math.atan2(-heading.x, heading.z);
  };
  const groundY = (s.left.contact.y + s.right.contact.y) / 2;
  // Roll: left up h, right down h.
  const rp = axle.solve({ left: s.inputs.left + h, right: s.inputs.right - h }, s.poses);
  const rm = axle.solve({ left: s.inputs.left - h, right: s.inputs.right + h }, s.poses);
  const rr = rotBetween(rm, rp);
  // Roll center: the point in the axle's transverse plane with no velocity in front view. From the two
  // poses: the axle rotates by Δφ in front view and its center moves by Δc; the instant center p solves
  // Δc = Δφ ẑ × (c − p) (front-view planar motion).
  const c0 = mid(rm.left.center, rm.right.center), c1 = mid(rp.left.center, rp.right.center);
  const dc = sub(c1, c0), dphi = rr.roll;
  let rcY: number | null = null, rcX: number | null = null;
  if (Math.abs(dphi) > 1e-12) {
    const c = mid(c0, c1);
    // dc = dphi · (−(c.y − p.y), c.x − p.x)  →  p = c − (dc.y, −dc.x)/dphi
    rcX = c.x - dc.y / dphi;
    rcY = c.y + dc.x / dphi;
  }
  // Heave: both up h.
  const hp = axle.solve({ left: s.inputs.left + h, right: s.inputs.right + h }, s.poses);
  const hm = axle.solve({ left: s.inputs.left - h, right: s.inputs.right - h }, s.poses);
  const hr = rotBetween(hm, hp);
  const hc0 = mid(hm.left.center, hm.right.center), hc1 = mid(hp.left.center, hp.right.center);
  const hdc = sub(hc1, hc0);
  // Side-view IC of the heave motion: the point (y, z) about which the axle pitches in side view.
  let sv: { y: number; z: number } | null = null;
  if (Math.abs(hr.pitch) > 1e-12) {
    const c = mid(hc0, hc1);
    // Rotation dθ about +X through p: dc = dθ x̂ × (c − p) = dθ (0, −(c.z − p.z), c.y − p.y).
    sv = { y: c.y - hdc.z / hr.pitch, z: c.z + hdc.y / hr.pitch };
  }
  const cp = s.left.contact;
  // As for the corners: the angle of the contact → side-view IC line (+ = IC above, toward the car's middle).
  const antiAngleContact = sv && Math.abs(cp.z - sv.z) > 1e-9 ? Math.atan((sv.y - cp.y) / (cp.z - sv.z)) : 0;
  return {
    camber: { left: camberOf(s.left), right: camberOf(s.right) },
    toe: { left: toeOf(s.left, 1), right: toeOf(s.right, -1) },
    halfTrack: { left: Math.abs(s.left.contact.x), right: Math.abs(s.right.contact.x) },
    rollCenterHeight: rcY === null ? null : rcY - groundY,
    rollCenterX: rcX,
    rollSteer: Math.abs(rr.roll) > 1e-12 ? rr.yaw / rr.roll : 0,
    sideViewIC: sv,
    antiAngleContact,
    windUp: hr.pitch / D / (2 * h),
    lateralShift: hdc.x / (2 * h),
  };
}

/** Helpers for common link sets (left side given; mirrored to the right). */
export function mirroredLinks(left: { name: string; chassis: Vec3; axle: Vec3 }[]): AxleLink[] {
  return left.flatMap((l) => [
    { name: `${l.name} (left)`, chassis: l.chassis, axle: l.axle },
    { name: `${l.name} (right)`, chassis: mirror(l.chassis), axle: mirror(l.axle) },
  ]);
}

