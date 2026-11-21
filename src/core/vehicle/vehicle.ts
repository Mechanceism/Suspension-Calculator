/**
 * Vehicle-level quasi-static equilibrium (L6, docs/MATH.md § L6).
 *
 * Vehicle frame: X = left (the FL corner's outboard), Y up (0 = frame bottom), Z forward
 * (0 = front axle). Each corner keeps its own local frame (X outboard, Y up, Z forward from its own
 * axle); left corners map X as-is, right corners mirror X, and rear corners shift Z by −wheelbase.
 *
 * Unknowns: chassis heave dz, roll φ (about +Z) and pitch θ (about +X) relative to the design pose.
 * For a given chassis pose each corner settles independently: the travel q where the virtual work
 * of the tire force, its lateral force, the unsprung weight / inertia and the spring balances along
 * the corner's one degree of freedom. Jacking forces through the instant centers come out of this
 * automatically. Then the whole car must balance: vertical force, roll moment and pitch moment.
 * Lateral tire forces are shared in proportion to each tire's vertical load.
 */
import { type Vec3, vec3, add, sub, cross } from '../math/vec3';
import { illinois } from '../math/roots';
import { solveLinear } from '../math/linalg';
import { localPatch, type TireProfile } from '../tire/geometry';
import { tireForce, solveLoadedHeight, type TireForceModel } from '../tire/model';
import { springForce, type SpringSpec } from '../suspension/spring';
import type { CornerTable } from './cornerTable';

export type CornerId = 'FL' | 'FR' | 'RL' | 'RR';
export const CORNER_IDS: CornerId[] = ['FL', 'FR', 'RL', 'RR'];
export const isFront = (id: CornerId) => id === 'FL' || id === 'FR';
export const isLeft = (id: CornerId) => id === 'FL' || id === 'RL';

const G = 9.80665;

export interface VehicleCorner {
  id: CornerId;
  table: CornerTable;
  spring: SpringSpec;
  /** kg */
  unsprungMass: number;
  tire: { profile: TireProfile; model: TireForceModel };
}

export interface VehicleInput {
  corners: VehicleCorner[];
  /** Total vehicle mass including unsprung masses, kg. */
  totalMass: number;
  /** Total CG at the static design position, vehicle frame (mm). */
  cg: Vec3;
  /** Front axle (Z = 0) to rear axle, mm. */
  wheelbase: number;
  /**
   * Ground height in the vehicle frame at the design position (mm). The hardpoints describe the car
   * at static ride height on level ground, so this includes the static tire compression
   * (see designGroundY).
   */
  groundY: number;
  /** Lateral acceleration, g (+ = toward +X, a left turn). */
  lateralG: number;
}

/** Corner frame → vehicle frame. */
export const placement = (id: CornerId, wheelbase: number) => {
  const side = isLeft(id) ? 1 : -1;
  const dz = isFront(id) ? 0 : -wheelbase;
  return {
    point: (p: Vec3) => vec3(side * p.x, p.y, p.z + dz),
    dir: (d: Vec3) => vec3(side * d.x, d.y, d.z),
  };
};

export interface ChassisPose {
  heave: number;
  roll: number;
  pitch: number;
}

/** Chassis pose: world = Rz(roll)·Rx(pitch)·p + (0, heave, 0). */
export function poseFns(pose: ChassisPose) {
  const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll);
  const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
  const rot = (p: Vec3): Vec3 => {
    // Rx(pitch) then Rz(roll)
    const y1 = p.y * cp - p.z * sp;
    const z1 = p.y * sp + p.z * cp;
    return vec3(p.x * cr - y1 * sr, p.x * sr + y1 * cr, z1);
  };
  return { rot, point: (p: Vec3) => add(rot(p), vec3(0, pose.heave, 0)) };
}

export type CornerStatus = 'ok' | 'droop-limit' | 'bump-limit';

export interface CornerResult {
  id: CornerId;
  /** Wheel-center travel, mm (+ bump). */
  travel: number;
  status: CornerStatus;
  /** Vertical tire load, N. */
  tireLoad: number;
  /** Lateral tire force, N (world X). */
  lateralForce: number;
  /** Spring force, N. */
  springForce: number;
  /** Contact point and wheel center in world coordinates. */
  contact: Vec3;
  wheelCenter: Vec3;
  /** Wheel inclination to the ground, rad, + = top toward the corner's outboard side. */
  inclination: number;
}

export interface VehicleResult {
  pose: ChassisPose;
  corners: Record<CornerId, CornerResult>;
  converged: boolean;
  iterations: number;
  /** Residuals: vertical force (N), roll and pitch moments (N·m). */
  residual: [number, number, number];
  sprungMass: number;
  sprungCg: Vec3;
}

function sprungProperties(input: VehicleInput) {
  let m = input.totalMass;
  let sum = vec3(input.cg.x * m, input.cg.y * m, input.cg.z * m);
  for (const c of input.corners) {
    const wc = placement(c.id, input.wheelbase).point(c.table.at(0).wc);
    m -= c.unsprungMass;
    sum = sub(sum, vec3(wc.x * c.unsprungMass, wc.y * c.unsprungMass, wc.z * c.unsprungMass));
  }
  return { mass: m, cg: vec3(sum.x / m, sum.y / m, sum.z / m) };
}

/** Settle one corner for a chassis pose and a lateral tire force. */
function settleCorner(c: VehicleCorner, input: VehicleInput, pose: ChassisPose, lateral: number, guess?: number): CornerResult {
  const pl = placement(c.id, input.wheelbase);
  const P = poseFns(pose);
  const eval1 = (q: number) => {
    const s = c.table.at(q);
    const wc = P.point(pl.point(s.wc));
    const axis = P.rot(pl.dir(s.axis));
    const dcp = P.rot(pl.dir(s.dcp));
    const dwc = P.rot(pl.dir(s.dwc));
    const h0 = wc.y - input.groundY;
    // Tilt toward the corner's own outboard direction (mirrored axis already points outboard).
    const patch = localPatch(c.tire.profile, h0, axis.y);
    const ft = tireForce(c.tire.model, c.tire.profile, patch).force;
    const fs = Number.isFinite(s.L) ? springForce(c.spring, s.L) : 0;
    const work = ft * dcp.y + lateral * dcp.x
      - c.unsprungMass * G * dwc.y
      - c.unsprungMass * input.lateralG * G * dwc.x
      + (Number.isFinite(s.dL) ? fs * s.dL : 0);
    return { work, ft, fs, s, wc, axis };
  };
  const lo = c.table.lo;
  const hi = c.table.hi;
  let status: CornerStatus = 'ok';
  let q: number;
  const atLo = eval1(lo);
  const atHi = eval1(hi);
  if (atLo.work <= 0) { q = lo; status = 'droop-limit'; }
  else if (atHi.work >= 0) { q = hi; status = 'bump-limit'; }
  else {
    // Narrow bracket around the guess first (animation / Newton steps move q only a little).
    let a = lo, b = hi, fa = atLo.work, fb = atHi.work;
    if (guess !== undefined) {
      const ga = Math.max(lo, guess - 3), gb = Math.min(hi, guess + 3);
      const wa = eval1(ga).work, wb = eval1(gb).work;
      if (wa > 0 && wb < 0) { a = ga; b = gb; fa = wa; fb = wb; }
    }
    q = illinois((x) => eval1(x).work, a, b, fa, fb, 1e-5);
  }
  const r = eval1(q);
  const cpWorld = P.point(pl.point(r.s.cp));
  return {
    id: c.id, travel: q, status, tireLoad: r.ft, lateralForce: lateral, springForce: r.fs,
    contact: vec3(cpWorld.x, input.groundY, cpWorld.z), wheelCenter: r.wc,
    // Axis points outboard; its upward component means the top leans inboard (negative camber sense).
    inclination: -Math.asin(Math.max(-1, Math.min(1, r.axis.y))),
  };
}

/** Moments about the vehicle origin: [roll about Z, pitch about X]. */
function momentOf(r: Vec3, f: Vec3): [number, number] {
  const m = cross(r, f);
  return [m.z, m.x];
}

export interface VehicleSolveOptions {
  guess?: ChassisPose;
  cornerGuess?: Partial<Record<CornerId, number>>;
  maxIterations?: number;
}

export function solveVehicle(input: VehicleInput, options: VehicleSolveOptions = {}): VehicleResult {
  const sp = sprungProperties(input);
  const W = input.totalMass * G;
  const latTotal = input.totalMass * input.lateralG * G;
  // Lateral force shares start from the static load split and follow the solved loads.
  let shares: Record<CornerId, number> = { FL: 0.25, FR: 0.25, RL: 0.25, RR: 0.25 };
  const cornerGuess: Partial<Record<CornerId, number>> = { ...(options.cornerGuess ?? {}) };

  const evaluate = (pose: ChassisPose) => {
    const corners = {} as Record<CornerId, CornerResult>;
    for (const c of input.corners) {
      corners[c.id] = settleCorner(c, input, pose, latTotal * shares[c.id], cornerGuess[c.id]);
    }
    const P = poseFns(pose);
    let fy = 0, mRoll = 0, mPitch = 0;
    const add2 = ([a, b]: [number, number]) => { mRoll += a; mPitch += b; };
    for (const c of input.corners) {
      const r = corners[c.id];
      fy += r.tireLoad;
      add2(momentOf(r.contact, vec3(r.lateralForce, r.tireLoad, 0)));
      // Unsprung weight and lateral inertia at the wheel center.
      add2(momentOf(r.wheelCenter, vec3(-c.unsprungMass * input.lateralG * G, -c.unsprungMass * G, 0)));
    }
    const cg = P.point(sp.cg);
    add2(momentOf(cg, vec3(-sp.mass * input.lateralG * G, -sp.mass * G, 0)));
    return { corners, res: [fy - W, mRoll / 1000, mPitch / 1000] as [number, number, number] };
  };

  let pose: ChassisPose = options.guess ?? { heave: 0, roll: 0, pitch: 0 };
  let cur = evaluate(pose);
  const norm = (r: number[]) => Math.hypot(r[0]! / Math.max(W, 1), r[1]! / Math.max(W, 1), r[2]! / Math.max(W, 1));
  const tolN = 1e-7;
  let it = 0;
  const maxIt = options.maxIterations ?? 40;
  for (; it < maxIt; it++) {
    // Update lateral shares from the latest loads (fixed point alongside Newton).
    const total = Object.values(cur.corners).reduce((s, r) => s + Math.max(0, r.tireLoad), 0);
    const nextShares = { ...shares };
    for (const id of CORNER_IDS) nextShares[id] = total > 0 ? Math.max(0, cur.corners[id]?.tireLoad ?? 0) / total : 0.25;
    const sharesMoved = CORNER_IDS.some((id) => Math.abs(nextShares[id] - shares[id]) > 1e-6);
    shares = nextShares;
    if (sharesMoved) cur = evaluate(pose);
    for (const id of CORNER_IDS) cornerGuess[id] = cur.corners[id]?.travel;
    if (norm(cur.res) < tolN && !sharesMoved) break;

    // Newton step with a numeric Jacobian.
    const h = [0.01, 1e-5, 1e-5];
    const keys: (keyof ChassisPose)[] = ['heave', 'roll', 'pitch'];
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    keys.forEach((k, j) => {
      const p2 = { ...pose, [k]: pose[k] + h[j]! };
      const r2 = evaluate(p2).res;
      for (let i = 0; i < 3; i++) J[i]![j] = (r2[i]! - cur.res[i]!) / h[j]!;
    });
    const step = solveLinear(J, cur.res.map((v) => -v));
    if (!step) break;
    // Limit the step, then backtrack until the residual drops.
    const lim = [20, 0.05, 0.05];
    let s = step.map((v, i) => Math.max(-lim[i]!, Math.min(lim[i]!, v)));
    let accepted = false;
    for (let k = 0; k < 8; k++) {
      const trial = { heave: pose.heave + s[0]!, roll: pose.roll + s[1]!, pitch: pose.pitch + s[2]! };
      const rt = evaluate(trial);
      if (norm(rt.res) < norm(cur.res) || k === 7) { pose = trial; cur = rt; accepted = true; break; }
      s = s.map((v) => v / 2);
    }
    if (!accepted) break;
  }
  return {
    pose, corners: cur.corners, converged: norm(cur.res) < 1e-5, iterations: it, residual: cur.res,
    sprungMass: sp.mass, sprungCg: sp.cg,
  };
}

/**
 * Static corner weights from the CG (N), treating each axle as a beam: front/rear split by the CG's
 * Z position, left/right within each axle by its X position. Used to fit springs and as the default
 * corner load in the Corner workbench.
 */
export function staticCornerLoads(totalMass: number, cg: Vec3, wheelbase: number, contactX: Record<CornerId, number>): Record<CornerId, number> {
  const W = totalMass * G;
  const front = W * ((cg.z + wheelbase) / wheelbase);
  const rear = W - front;
  const split = (load: number, xl: number, xr: number) => {
    const left = load * ((cg.x - xr) / (xl - xr));
    return [left, load - left] as const;
  };
  const [fl, fr] = split(front, contactX.FL, -contactX.FR);
  const [rl, rr] = split(rear, contactX.RL, -contactX.RR);
  return { FL: fl, FR: fr, RL: rl, RR: rr };
}

/** Kinematic roll center of an axle from its two corners (world/vehicle front view). */
export function axleRollCenter(
  left: { contact: Vec3; ic: Vec3 | null; dir?: Vec3 }, right: { contact: Vec3; ic: Vec3 | null; dir?: Vec3 },
): { x: number; y: number } | null {
  const line = (c: { contact: Vec3; ic: Vec3 | null; dir?: Vec3 }) => {
    const d = c.ic ? sub(c.ic, c.contact) : c.dir;
    return d ? { p: c.contact, d } : null;
  };
  const a = line(left);
  const b = line(right);
  if (!a || !b) return null;
  const den = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}


/**
 * Design ground height: the rigid-tire contact height raised by the average static tire compression so the car sits at its design ride height under static load.
 */
export function designGroundY(
  corners: { contactY: number; profile: TireProfile; model: TireForceModel; staticLoad: number; tilt: number }[],
): number {
  let sum = 0;
  for (const c of corners) {
    const h = solveLoadedHeight(c.model, c.profile, c.tilt, Math.max(c.staticLoad, 1)).centerHeight;
    sum += c.contactY + (c.profile.radius - h);
  }
  return sum / corners.length;
}
