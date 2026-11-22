/**
 * Trailer sway (docs/MATH.md § Towing, sway): the trailer as a second yawing body in the handling model,
 * joined to the car at the hitch ball, on its own axle with tires.
 *
 * Car frame (x forward, y left), articulation φ = trailer heading − car heading (+ = trailer turned left),
 * trailer yaw rate r_t = r + φ̇. Hitch c behind the car's CG; trailer CG d behind the hitch, its axle L_t
 * behind. Unknowns v̇, ṙ (car), ṙ_t (trailer) and F, the hitch's side force on the trailer (along its left
 * axis n = (−sin φ, cos φ)); the pull along the trailer's axis e = (cos φ, sin φ) is F_t = m_t·a_x (less what
 * the trailer's own brakes take when braking):
 *
 *   car lateral      m (v̇ + u r) = ΣF_y + m g_bank − F cos φ − F_t sin φ
 *   car yaw          I ṙ = M_z + c (F cos φ + F_t sin φ)
 *   trailer lateral  m_t (a_hitch · n − d ṙ_t) = F + Y_t + m_t g_bank cos φ,
 *                    a_hitch = (a_x + c r², v̇ + u r − c ṙ)
 *   trailer yaw      I_t ṙ_t = d F − (L_t − d) Y_t
 *
 * Trailer tires: Y_t = μ F_z tanh(C α / (μ F_z)), C = 7 · F_z per rad (≈ 0.12 per degree), α from the axle's
 * velocity. Pushing (braking without trailer brakes) turns F_t sin φ into a jackknifing force.
 *
 * Sway is measured against a kinematic trailer driven by the same car (its axle never slips sideways):
 * φ̇_k = (−u sin φ_k + (v − c r) cos φ_k) / L_t − r. The tires' steady slip offset is removed by a 1 s low
 * pass, so sway = |(φ − φ_k) − LP(φ − φ_k)|; past 30° from the kinematic trailer it has jackknifed.
 */
import type { TrailerSpec } from '../vehicle/towing';

const G = 9.80665;

export interface SwayTrailer {
  m: number;
  /** Yaw inertia about its CG, kg·m². */
  I: number;
  /** Hitch behind the car's CG, trailer CG behind the hitch, axle behind the hitch, m. */
  c: number;
  d: number;
  Lt: number;
  /** Axle load, N; cornering stiffness, N/rad; tire friction. */
  Fz: number;
  C: number;
  mu: number;
  brakeShare: number;
}

export interface SwayState {
  phi: number;
  rt: number;
  /** The kinematic (no-slip) trailer's articulation, and the low-passed deviation from it, rad. */
  phiK: number;
  devLP: number;
}

export interface SwayAccel { vdot: number; rdot: number; rtdot: number; F: number; Yt: number }

/** The trailer for the sway model (hitch distance behind the car's CG, mm). */
export function swayTrailer(t: TrailerSpec, hitchBehindCg: number): SwayTrailer {
  const m = Math.max(1, t.mass), tau = Math.min(0.9, Math.max(-0.5, t.tongueShare));
  const Lt = Math.max(t.hitchToAxle, 100) / 1000;
  const k = (t.yawRadius && t.yawRadius > 0 ? t.yawRadius : 0.45 * t.hitchToAxle) / 1000;
  const Fz = Math.max(1, m * G * (1 - tau));
  return { m, I: m * k * k, c: Math.max(0, hitchBehindCg / 1000), d: Lt * (1 - tau), Lt, Fz, C: 7 * Fz, mu: 0.9, brakeShare: Math.min(1, Math.max(0, t.brakeShare)) };
}

export const newSwayState = (): SwayState => ({ phi: 0, rt: 0, phiK: 0, devLP: 0 });

/** The trailer tires' side force (along the trailer's left axis), N. */
export function trailerTireForce(tr: SwayTrailer, st: SwayState, u: number, v: number, r: number): number {
  const s = Math.sin(st.phi), co = Math.cos(st.phi);
  const vy = v - tr.c * r;
  const ut = u * co + vy * s, vAx = -u * s + vy * co - tr.Lt * st.rt;
  const alpha = -Math.atan2(vAx, Math.max(ut, 0.5));
  const lim = tr.mu * tr.Fz;
  return lim * Math.tanh((tr.C * alpha) / lim);
}

/**
 * Accelerations of the car and trailer, and the hitch side force, for the car's tire forces (ΣF_y, M_z
 * about its CG), speed u, its v, r, longitudinal acceleration a_x (m/s²) and the bank's pull g_bank.
 */
export function coupleTrailer(tr: SwayTrailer, st: SwayState, car: { m: number; I: number }, u: number, v: number, r: number, ax: number, grav: number, sumFy: number, mz: number): SwayAccel {
  const s = Math.sin(st.phi), co = Math.cos(st.phi);
  const Ft = tr.m * ax * (ax < 0 ? 1 - tr.brakeShare : 1);
  const Yt = trailerTireForce(tr, st, u, v, r);
  const { m, I } = car, mt = tr.m, c = tr.c, d = tr.d;
  // Unknowns [v̇, ṙ, ṙ_t, F].
  const A = [
    [m, 0, 0, co],
    [0, I, 0, -c * co],
    [mt * co, -mt * c * co, -mt * d, -1],
    [0, 0, tr.I, -d],
  ];
  const b = [
    sumFy + m * grav - m * u * r - Ft * s,
    mz + c * Ft * s,
    Yt + mt * grav * co - mt * co * u * r + mt * s * (ax + c * r * r),
    -(tr.Lt - d) * Yt,
  ];
  const x = solve4(A, b) ?? [(sumFy + m * grav) / m - u * r, mz / I, 0, 0];
  return { vdot: x[0]!, rdot: x[1]!, rtdot: x[2]!, F: x[3]!, Yt };
}

/** Advance the trailer by h after the car's v, r were (r_t by its acceleration, φ by r_t − r, and the kinematic trailer). */
export function stepTrailer(tr: SwayTrailer, st: SwayState, u: number, v: number, r: number, rtdot: number, h: number): void {
  st.rt += h * rtdot;
  st.phi += h * (st.rt - r);
  // Past ~70° the model means little: hold it (the jackknife check has long failed).
  st.phi = Math.max(-1.2, Math.min(1.2, st.phi));
  const vy = v - tr.c * r;
  st.phiK += h * ((-u * Math.sin(st.phiK) + vy * Math.cos(st.phiK)) / tr.Lt - r);
  st.devLP += (st.phi - st.phiK - st.devLP) * Math.min(1, h / 1.0);
}

/** Slow (kinematic) driving: the trailer follows without slip. */
export function followTrailer(tr: SwayTrailer, st: SwayState, u: number, v: number, r: number, h: number): void {
  const vy = v - tr.c * r;
  const phidot = (-u * Math.sin(st.phiK) + vy * Math.cos(st.phiK)) / tr.Lt - r;
  st.phiK += h * phidot;
  st.phi = st.phiK;
  st.rt = r + phidot;
  st.devLP += (0 - st.devLP) * Math.min(1, h / 1.0);
}

/** Sway now (rad): the oscillation about the trailer's slow deviation from the kinematic one; jackknifed past 30°. */
export function swayOf(st: SwayState): { sway: number; jackknife: boolean } {
  const dev = st.phi - st.phiK;
  return { sway: Math.abs(dev - st.devLP), jackknife: Math.abs(dev) > 0.52 || Math.abs(st.phi) >= 1.2 - 1e-9 };
}

function solve4(A: number[][], b: number[]): number[] | null {
  const n = 4;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i]![k]!) > Math.abs(M[p]![k]!)) p = i;
    if (Math.abs(M[p]![k]!) < 1e-12) return null;
    [M[k], M[p]] = [M[p]!, M[k]!];
    for (let i = k + 1; i < n; i++) {
      const f = M[i]![k]! / M[k]![k]!;
      for (let j = k; j <= n; j++) M[i]![j]! -= f * M[k]![j]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= M[i]![j]! * x[j]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}
