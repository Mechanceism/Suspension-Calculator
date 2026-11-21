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

export type BrakeMount = 'none' | 'outboard' | 'inboard';

export interface VehicleCorner {
  id: CornerId;
  /** Tabulated kinematics. If an anti-roll bar uses drop links, the table tracks the drop-link mount. */
  table: CornerTable;
  spring: SpringSpec;
  /** kg */
  unsprungMass: number;
  tire: { profile: TireProfile; model: TireForceModel };
  /**
   * Brake mounting. Outboard: the brake torque is reacted by the upright, so the braking force acts
   * at the contact patch. Inboard: reacted by the chassis, so it acts at the wheel center.
   */
  brake?: BrakeMount;
}

/** Anti-roll bar between the two corners of an axle. */
export type AntiRollBar =
  | { kind: 'none' }
  /** Rate at the wheel, N/mm of left/right travel difference. */
  | { kind: 'wheelRate'; rate: number }
  /**
   * Torsion bar with drop links to a point on each arm (the corner tables track that point).
   * barRate in N·mm per radian of twist; lever = bar arm length (mm).
   */
  | { kind: 'torsionBar'; barRate: number; lever: number };

/** Heave (third) spring shared by the two corners of an axle: rate at the wheel, N/mm, on the average travel. */
export type HeaveSpring = { kind: 'none' } | { kind: 'wheelRate'; rate: number };

export interface AxleShared {
  antiRollBar: AntiRollBar;
  heaveSpring: HeaveSpring;
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
  /** Braking deceleration, g (≥ 0). */
  brakingG?: number;
  /** Fraction of the braking force on the front axle (0–1). */
  brakeBias?: number;
  /** Shared components per axle. */
  shared?: { front: AxleShared; rear: AxleShared };
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

/** Chassis pose: world = Rz(roll)·Rx(pitch)·p + (0, heave, 0). + pitch = nose down. */
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
  /** Longitudinal tire force, N (world Z; braking is negative). */
  longitudinalForce: number;
  /** Spring force, N. */
  springForce: number;
  /** Generalized force from shared components (anti-roll bar + heave spring), N at the wheel. */
  sharedForce: number;
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

const NO_SHARED: AxleShared = { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } };
const partner = (id: CornerId): CornerId => ({ FL: 'FR', FR: 'FL', RL: 'RR', RR: 'RL' } as const)[id];

/**
 * Generalized force (N, along this corner's travel q) from the axle's shared components, with the
 * partner corner's travel held at `qOther`. Energy-based so left and right get equal and opposite
 * (anti-roll bar) or equal (heave spring) shares.
 */
function sharedForce(c: VehicleCorner, partnerC: VehicleCorner | undefined, axle: AxleShared, q: number, qOther: number): number {
  let f = 0;
  const arb = axle.antiRollBar;
  if (arb.kind === 'wheelRate') f -= arb.rate * (q - qOther);
  else if (arb.kind === 'torsionBar' && partnerC && arb.lever > 0) {
    // Twist = (drop-link mount height on this side − other side) / lever; torque = barRate · twist.
    const a = c.table.at(q);
    const b = partnerC.table.at(qOther);
    const y0a = c.table.at(0).ex.y;
    const y0b = partnerC.table.at(0).ex.y;
    const twist = ((a.ex.y - y0a) - (b.ex.y - y0b)) / arb.lever;
    f -= ((arb.barRate * twist) / arb.lever) * a.dex.y;
  }
  const hs = axle.heaveSpring;
  if (hs.kind === 'wheelRate') f -= hs.rate * (q + qOther) / 2;
  return f;
}

interface CornerLoads {
  lateral: number;
  longitudinal: number;
}

/** Virtual work along the corner's travel (N) at q, with the partner corner at qOther. Decreasing in q. */
function cornerWork(
  c: VehicleCorner, input: VehicleInput, pose: ChassisPose, f: CornerLoads,
  shared: { partner: VehicleCorner | undefined; axle: AxleShared }, q: number, qOther: number,
) {
  const pl = placement(c.id, input.wheelbase);
  const P = poseFns(pose);
  const brakingG = input.brakingG ?? 0;
  const inboard = c.brake === 'inboard';
  const s = c.table.at(q);
  const wc = P.point(pl.point(s.wc));
  const axis = P.rot(pl.dir(s.axis));
  // Tire forces work through the material point at the contact (not the lowest-point path).
  const dcp = P.rot(pl.dir(s.dcpm));
  const dwc = P.rot(pl.dir(s.dwc));
  const h0 = wc.y - input.groundY;
  // Tilt toward the corner's own outboard direction (mirrored axis already points outboard).
  const patch = localPatch(c.tire.profile, h0, axis.y);
  const ft = tireForce(c.tire.model, c.tire.profile, patch).force;
  const fs = Number.isFinite(s.L) ? springForce(c.spring, s.L) : 0;
  const fShared = sharedForce(c, shared.partner, shared.axle, q, qOther);
  const work = ft * dcp.y + f.lateral * dcp.x
    // Braking force: at the patch (outboard brake) or the wheel center (inboard brake).
    + f.longitudinal * (inboard ? dwc.z : dcp.z)
    - c.unsprungMass * G * dwc.y
    - c.unsprungMass * input.lateralG * G * dwc.x
    + c.unsprungMass * brakingG * G * dwc.z
    + (Number.isFinite(s.dL) ? fs * s.dL : 0)
    + fShared;
  return { work, ft, fs, fShared, s, wc, axis, P, pl };
}

function cornerResult(c: VehicleCorner, input: VehicleInput, f: CornerLoads, q: number, status: CornerStatus, r: ReturnType<typeof cornerWork>): CornerResult {
  const cpWorld = r.P.point(r.pl.point(r.s.cp));
  return {
    id: c.id, travel: q, status, tireLoad: r.ft, lateralForce: f.lateral, longitudinalForce: f.longitudinal,
    springForce: r.fs, sharedForce: r.fShared,
    contact: vec3(cpWorld.x, input.groundY, cpWorld.z), wheelCenter: r.wc,
    // Axis points outboard; its upward component means the top leans inboard (negative camber sense).
    inclination: -Math.asin(Math.max(-1, Math.min(1, r.axis.y))),
  };
}

/** 1-D settle of a corner with the partner's travel held fixed (bracketed, so it always converges). */
function settle1(work: (q: number) => number, lo: number, hi: number, guess?: number): { q: number; status: CornerStatus } {
  const wLo = work(lo);
  const wHi = work(hi);
  if (wLo <= 0) return { q: lo, status: 'droop-limit' };
  if (wHi >= 0) return { q: hi, status: 'bump-limit' };
  let a = lo, b = hi, fa = wLo, fb = wHi;
  if (guess !== undefined) {
    // Narrow bracket around the guess first (animation / Newton steps move q only a little).
    const ga = Math.max(lo, guess - 3), gb = Math.min(hi, guess + 3);
    const wa = work(ga), wb = work(gb);
    if (wa > 0 && wb < 0) { a = ga; b = gb; fa = wa; fb = wb; }
  }
  return { q: illinois(work, a, b, fa, fb, 1e-5), status: 'ok' };
}

/**
 * Settle both corners of an axle together when an anti-roll bar or heave spring couples them:
 * 2-unknown Newton on (q_left, q_right), then any corner pushed past its travel limit is held there
 * and the other re-settled.
 */
function settleAxle(
  cs: [VehicleCorner, VehicleCorner], input: VehicleInput, pose: ChassisPose, f: [CornerLoads, CornerLoads],
  axle: AxleShared, guess: [number | undefined, number | undefined],
): [CornerResult, CornerResult] {
  const [a, b] = cs;
  const wA = (qa: number, qb: number) => cornerWork(a, input, pose, f[0], { partner: b, axle }, qa, qb).work;
  const wB = (qb: number, qa: number) => cornerWork(b, input, pose, f[1], { partner: a, axle }, qb, qa).work;
  let qa = guess[0] ?? 0;
  let qb = guess[1] ?? 0;
  const clampA = (q: number) => Math.min(a.table.hi, Math.max(a.table.lo, q));
  const clampB = (q: number) => Math.min(b.table.hi, Math.max(b.table.lo, q));
  for (let it = 0; it < 30; it++) {
    const ga = wA(qa, qb);
    const gb = wB(qb, qa);
    if (Math.abs(ga) < 1e-3 && Math.abs(gb) < 1e-3) break;
    const h = 1e-3;
    const j11 = (wA(qa + h, qb) - ga) / h;
    const j12 = (wA(qa, qb + h) - ga) / h;
    const j21 = (wB(qb, qa + h) - gb) / h;
    const j22 = (wB(qb + h, qa) - gb) / h;
    const det = j11 * j22 - j12 * j21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    let da = (-ga * j22 + gb * j12) / det;
    let db = (-gb * j11 + ga * j21) / det;
    const m = Math.max(Math.abs(da), Math.abs(db));
    if (m > 10) { da *= 10 / m; db *= 10 / m; }
    const na = clampA(qa + da);
    const nb = clampB(qb + db);
    if (Math.abs(na - qa) < 1e-7 && Math.abs(nb - qb) < 1e-7) break; // stuck at limits
    qa = na; qb = nb;
  }
  // Limits: if either corner is pinned, hold it and settle the other on its own.
  let sa: CornerStatus = 'ok';
  let sb: CornerStatus = 'ok';
  const pinned = (q: number, c: VehicleCorner, w: number) =>
    (q <= c.table.lo + 1e-6 && w < 0) ? 'droop-limit' : (q >= c.table.hi - 1e-6 && w > 0) ? 'bump-limit' : 'ok';
  sa = pinned(qa, a, wA(qa, qb));
  sb = pinned(qb, b, wB(qb, qa));
  if (sa !== 'ok' && sb === 'ok') ({ q: qb, status: sb } = settle1((q) => wB(q, qa), b.table.lo, b.table.hi, qb));
  else if (sb !== 'ok' && sa === 'ok') ({ q: qa, status: sa } = settle1((q) => wA(q, qb), a.table.lo, a.table.hi, qa));
  const ra = cornerWork(a, input, pose, f[0], { partner: b, axle }, qa, qb);
  const rb = cornerWork(b, input, pose, f[1], { partner: a, axle }, qb, qa);
  return [cornerResult(a, input, f[0], qa, sa, ra), cornerResult(b, input, f[1], qb, sb, rb)];
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

/** Braking-force shares: front axle gets the bias, split within each axle by tire load among braked corners. */
function brakeShares(input: VehicleInput, loads: Record<CornerId, number>): Record<CornerId, number> {
  const out: Record<CornerId, number> = { FL: 0, FR: 0, RL: 0, RR: 0 };
  const braked = (id: CornerId) => (input.corners.find((c) => c.id === id)?.brake ?? 'outboard') !== 'none';
  const axleLoad = (ids: CornerId[]) => ids.filter(braked).reduce((s, id) => s + Math.max(0, loads[id]), 0);
  const front: CornerId[] = ['FL', 'FR'];
  const rear: CornerId[] = ['RL', 'RR'];
  let bias = Math.min(1, Math.max(0, input.brakeBias ?? 0.6));
  if (axleLoad(front) <= 0) bias = 0;
  if (axleLoad(rear) <= 0) bias = axleLoad(front) > 0 ? 1 : bias;
  for (const [ids, share] of [[front, bias], [rear, 1 - bias]] as const) {
    const total = axleLoad(ids);
    for (const id of ids) out[id] = total > 0 && braked(id) ? (share * Math.max(0, loads[id])) / total : 0;
  }
  return out;
}

export function solveVehicle(input: VehicleInput, options: VehicleSolveOptions = {}): VehicleResult {
  const sp = sprungProperties(input);
  const W = input.totalMass * G;
  const latTotal = input.totalMass * input.lateralG * G;
  const brakingG = input.brakingG ?? 0;
  const brakeTotal = input.totalMass * brakingG * G; // magnitude; acts rearward (−Z) on the tires
  const byId = Object.fromEntries(input.corners.map((c) => [c.id, c])) as Partial<Record<CornerId, VehicleCorner>>;
  const axleOf = (id: CornerId) => (isFront(id) ? input.shared?.front : input.shared?.rear) ?? NO_SHARED;
  const isCoupled = (a: AxleShared) => a.antiRollBar.kind !== 'none' || a.heaveSpring.kind !== 'none';

  // Tire-force shares (lateral by load; braking by bias then load) follow the solved loads.
  let loads: Record<CornerId, number> = { FL: W / 4, FR: W / 4, RL: W / 4, RR: W / 4 };
  const cornerGuess: Partial<Record<CornerId, number>> = { ...(options.cornerGuess ?? {}) };

  const evaluate = (pose: ChassisPose) => {
    const total = CORNER_IDS.reduce((s, id) => s + Math.max(0, loads[id]), 0);
    const bShares = brakeShares(input, loads);
    const corners = {} as Record<CornerId, CornerResult>;
    const forces = (id: CornerId): CornerLoads => ({
      lateral: total > 0 ? (latTotal * Math.max(0, loads[id])) / total : 0,
      longitudinal: -brakeTotal * bShares[id],
    });
    for (const [l, r] of [['FL', 'FR'], ['RL', 'RR']] as const) {
      const cl = byId[l];
      const cr = byId[r];
      const axle = axleOf(l);
      if (cl && cr && isCoupled(axle)) {
        const [rl, rr] = settleAxle([cl, cr], input, pose, [forces(l), forces(r)], axle, [cornerGuess[l], cornerGuess[r]]);
        corners[l] = rl; corners[r] = rr;
        continue;
      }
      for (const c of [cl, cr]) {
        if (!c) continue;
        const f = forces(c.id);
        const work = (q: number) => cornerWork(c, input, pose, f, { partner: undefined, axle: NO_SHARED }, q, 0).work;
        const { q, status } = settle1(work, c.table.lo, c.table.hi, cornerGuess[c.id]);
        corners[c.id] = cornerResult(c, input, f, q, status, cornerWork(c, input, pose, f, { partner: undefined, axle: NO_SHARED }, q, 0));
      }
    }
    const P = poseFns(pose);
    let fy = 0, mRoll = 0, mPitch = 0;
    const add2 = ([a, b]: [number, number]) => { mRoll += a; mPitch += b; };
    for (const c of input.corners) {
      const r = corners[c.id];
      fy += r.tireLoad;
      add2(momentOf(r.contact, vec3(r.lateralForce, r.tireLoad, r.longitudinalForce)));
      // Unsprung weight and inertia (lateral, braking) at the wheel center.
      add2(momentOf(r.wheelCenter, vec3(-c.unsprungMass * input.lateralG * G, -c.unsprungMass * G, c.unsprungMass * brakingG * G)));
    }
    const cg = P.point(sp.cg);
    add2(momentOf(cg, vec3(-sp.mass * input.lateralG * G, -sp.mass * G, sp.mass * brakingG * G)));
    return { corners, res: [fy - W, mRoll / 1000, mPitch / 1000] as [number, number, number] };
  };

  let pose: ChassisPose = options.guess ?? { heave: 0, roll: 0, pitch: 0 };
  let cur = evaluate(pose);
  const norm = (r: number[]) => Math.hypot(r[0]! / Math.max(W, 1), r[1]! / Math.max(W, 1), r[2]! / Math.max(W, 1));
  const tolN = 1e-7;
  let it = 0;
  const maxIt = options.maxIterations ?? 40;
  for (; it < maxIt; it++) {
    // Update the tire-force shares and partner travels from the latest solution.
    const nextLoads = Object.fromEntries(CORNER_IDS.map((id) => [id, cur.corners[id]?.tireLoad ?? 0])) as Record<CornerId, number>;
    const loadsMoved = CORNER_IDS.some((id) => Math.abs(nextLoads[id] - loads[id]) > 1e-4 * W);
    loads = nextLoads;
    if (loadsMoved) cur = evaluate(pose);
    for (const id of CORNER_IDS) cornerGuess[id] = cur.corners[id]?.travel;
    if (norm(cur.res) < tolN && !loadsMoved) break;

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
