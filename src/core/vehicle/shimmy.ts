/**
 * Shimmy and death wobble (round 3, R8; docs/MATH.md § Shimmy): whether the steered wheels' oscillation
 * about their steering axes dies out or grows at a speed.
 *
 * States (SI, knuckle angles): ψ the front wheels' steer about their axes (both together through the tie
 * rod), θ the steering wheel's angle seen at the knuckles (its inertia I_sw / ratio²), F the two tires'
 * side force (lagging the slip by the relaxation length σ), and for a solid axle φ its tramp (roll about
 * the car's length) coupled by the spinning wheels' gyroscopic moment g = 2 I_spin u / R.
 *
 *   I_k ψ̈ = −k_d ψ̇ − c_s (ψ − θ) − (e + t_p) F + g φ̇            (e mechanical, t_p pneumatic trail)
 *   I_θ θ̈ = −k_h θ̇ − c_h θ + c_s (ψ − θ)                          (hands off: c_h = k_h = 0)
 *   (σ / u) Ḟ = −F + C (ψ + e ψ̇ / u − h φ̇ / u)                     (C both tires' cornering stiffness)
 *   I_φ φ̈ = −k_φ φ̇ − c_φ φ + h F − g ψ̇                           (h the axle's roll-axis height)
 *
 * The slip is the wheel's heading less the contact's sideways motion: the contact sits e behind the steering
 * axis (steering swings it the other way) and h below the axle's roll axis (tramp swings it sideways).
 * Small motions: ẋ = A x; the eigenvalues give each mode's damping ratio ζ = −Re λ / |λ|; a mode with
 * Re λ > 0 grows (shimmy). Free play (worn parts) can't be linear: for the scan it becomes the dead-zone's
 * describing-function stiffness at an oscillation of twice the play; the time simulation (`shimmyKick`)
 * keeps the real dead zone and kicks the wheels.
 */

export interface ShimmyParams {
  /** Mechanical and pneumatic trail, m. */
  trail: number;
  pneumaticTrail: number;
  /** Relaxation length, m; both front tires' cornering stiffness, N/rad. */
  relaxation: number;
  cornering: number;
  /** Both knuckle + wheel assemblies about their steering axes, kg·m². */
  knuckleInertia: number;
  /** Steering wheel's inertia seen at the knuckles (I_sw / ratio²), kg·m². */
  wheelInertia: number;
  /** Steering-system stiffness between knuckles and steering wheel, at the knuckles (N·m/rad), its free play (rad). */
  stiffness: number;
  freePlay: number;
  /** Steering damper at the knuckles, N·m·s/rad (plus the system's own friction). */
  damper: number;
  /** Driver's hands on the steering wheel, at the knuckles (0 = hands off, the worst case). */
  hands?: { stiffness: number; damping: number };
  /** Kingpin offset at the wheel center, m (the lever of a wheel imbalance's shake). */
  kingpinOffset?: number;
  /** Spin inertia per wheel (kg·m²) and rolling radius (m), for the gyroscopic coupling. */
  spinInertia: number;
  radius: number;
  /** Solid axle: its tramp inertia, stiffness and damping (about the car's length) and roll-axis height (m). */
  axle?: { inertia: number; stiffness: number; damping: number; height: number };
}

/** The worn condition: free play and the stiffness / damping left (shares). */
export interface Wear { freePlay: number; stiffness: number; damper: number }

/** Dead zone of half-width b as a spring at oscillation amplitude A: its describing-function stiffness ÷ c. */
export function deadZoneGain(b: number, A: number): number {
  if (!(b > 0)) return 1;
  if (A <= b) return 0;
  const r = b / A;
  return 1 - (2 / Math.PI) * (Math.asin(r) + r * Math.sqrt(1 - r * r));
}

/** The worn parameters (free play as a describing-function stiffness at twice the play). */
export function wornParams(p: ShimmyParams, w: Wear): ShimmyParams {
  return { ...p, freePlay: w.freePlay, stiffness: p.stiffness * w.stiffness * deadZoneGain(w.freePlay, 2 * w.freePlay), damper: p.damper * w.damper };
}

/** The system matrix at speed u (m/s). States [ψ, ψ̇, θ, θ̇, F] (+ [φ, φ̇] for a solid axle). */
export function shimmyMatrix(p: ShimmyParams, u: number): number[][] {
  const n = p.axle ? 7 : 5;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const uu = Math.max(u, 0.1);
  const e = p.trail, tp = p.pneumaticTrail, C = p.cornering, s = Math.max(p.relaxation, 1e-3);
  const g = (2 * p.spinInertia * uu) / Math.max(p.radius, 1e-3);
  const Ik = Math.max(p.knuckleInertia, 1e-6), It = Math.max(p.wheelInertia, 1e-6);
  const ch = p.hands?.stiffness ?? 0, kh = p.hands?.damping ?? 0;
  // ψ̇
  A[0]![1] = 1;
  A[1]![0] = -p.stiffness / Ik; A[1]![1] = -p.damper / Ik; A[1]![2] = p.stiffness / Ik; A[1]![4] = -(e + tp) / Ik;
  A[2]![3] = 1;
  A[3]![0] = p.stiffness / It; A[3]![2] = -(p.stiffness + ch) / It; A[3]![3] = -kh / It;
  // Ḟ = (u/σ)(−F + C(ψ + e ψ̇/u − h φ̇/u))
  const k = uu / s;
  A[4]![4] = -k; A[4]![0] = k * C; A[4]![1] = (k * C * e) / uu;
  if (p.axle) {
    const ax = p.axle, If = Math.max(ax.inertia, 1e-6);
    A[1]![6] = g / Ik;
    A[4]![6] = -(k * C * ax.height) / uu;
    A[5]![6] = 1;
    A[6]![5] = -ax.stiffness / If; A[6]![6] = -ax.damping / If; A[6]![4] = ax.height / If; A[6]![1] = -g / If;
  }
  return A;
}

export interface Complex { re: number; im: number }

/** Eigenvalues of a small real matrix: characteristic polynomial (Faddeev–LeVerrier, scaled) and its roots (Aberth). */
export function eigenvalues(M: number[][]): Complex[] {
  const n = M.length;
  // Scale time so the entries are about 1: λ = ω0 · μ.
  const w0 = Math.max(1e-9, ...M.flatMap((r) => r.map(Math.abs)));
  const A = M.map((r) => r.map((v) => v / w0));
  // Faddeev–LeVerrier: c[k] of λ^n + c1 λ^(n−1) + … + cn.
  const c = new Array<number>(n + 1).fill(0);
  c[0] = 1;
  let Mk = A.map((r) => r.map(() => 0)); // M0 = 0
  for (let k = 1; k <= n; k++) {
    // Mk = A·M(k−1) + c(k−1) I
    const prev = Mk;
    Mk = A.map((r, i) => r.map((_, j) => {
      let sum = 0;
      for (let q = 0; q < n; q++) sum += r[q]! * prev[q]![j]!;
      return sum + (i === j ? c[k - 1]! : 0);
    }));
    let tr = 0;
    for (let i = 0; i < n; i++) for (let q = 0; q < n; q++) tr += A[i]![q]! * Mk[q]![i]!;
    c[k] = -tr / k;
  }
  // Aberth–Ehrlich on the monic polynomial.
  const ev = (z: Complex) => {
    let p: Complex = { re: 1, im: 0 }, dp: Complex = { re: 0, im: 0 };
    for (let k = 1; k <= n; k++) {
      dp = { re: dp.re * z.re - dp.im * z.im + p.re, im: dp.re * z.im + dp.im * z.re + p.im };
      p = { re: p.re * z.re - p.im * z.im + c[k]!, im: p.re * z.im + p.im * z.re };
    }
    return { p, dp };
  };
  const div = (a: Complex, b: Complex): Complex => { const d = b.re * b.re + b.im * b.im || 1e-300; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; };
  const R = 1 + Math.max(...c.slice(1).map(Math.abs));
  let z: Complex[] = Array.from({ length: n }, (_, k) => ({ re: R * 0.9 * Math.cos((2 * Math.PI * k) / n + 0.4), im: R * 0.9 * Math.sin((2 * Math.PI * k) / n + 0.4) }));
  for (let it = 0; it < 500; it++) {
    let moved = 0;
    const next = z.map((zi, i) => {
      const { p, dp } = ev(zi);
      const ratio = div(p, dp);
      let s: Complex = { re: 0, im: 0 };
      z.forEach((zj, j) => { if (j !== i) { const d = div({ re: 1, im: 0 }, { re: zi.re - zj.re, im: zi.im - zj.im }); s = { re: s.re + d.re, im: s.im + d.im }; } });
      const denom = { re: 1 - (ratio.re * s.re - ratio.im * s.im), im: -(ratio.re * s.im + ratio.im * s.re) };
      const w = div(ratio, denom);
      moved = Math.max(moved, Math.hypot(w.re, w.im));
      return { re: zi.re - w.re, im: zi.im - w.im };
    });
    z = next;
    if (moved < 1e-13 * R) break;
  }
  return z.map((v) => ({ re: v.re * w0, im: v.im * w0 }));
}

export interface ShimmyAt {
  speed: number;
  /** Least damping ratio of the oscillating modes (< 0 = one grows) and its frequency, Hz. */
  zeta: number;
  frequency: number;
}

/**
 * Shimmy's band: the wheels against the steering system, ≈ 4–25 Hz (death wobble ≈ 5–10 Hz). Slower modes
 * (the whole steering swinging with the steering wheel) are the car's own steering response, which this
 * model can't judge: it holds the car's path straight (no body yaw / sideways motion).
 */
export const SHIMMY_MIN_HZ = 3;

/** The least-damped oscillating mode in shimmy's band at speed u. */
export function shimmyAt(p: ShimmyParams, u: number): ShimmyAt {
  let zeta = Infinity, frequency = 0;
  for (const l of eigenvalues(shimmyMatrix(p, u))) {
    const f = Math.abs(l.im) / (2 * Math.PI);
    if (f < SHIMMY_MIN_HZ) continue;
    const z = -l.re / Math.hypot(l.re, l.im);
    if (z < zeta) { zeta = z; frequency = f; }
  }
  return { speed: u, zeta: Number.isFinite(zeta) ? zeta : 1, frequency };
}

export interface ShimmyScan {
  points: ShimmyAt[];
  /** Least damping over the speeds, where (m/s), and the lowest speed a mode grows at (null = none). */
  minZeta: number;
  worstSpeed: number;
  onset: number | null;
}

/** Scan speeds from `from` to `to` (m/s) in `steps`. */
export function shimmyScan(p: ShimmyParams, to: number, from = 3, steps = 40): ShimmyScan {
  const points: ShimmyAt[] = [];
  for (let i = 0; i <= steps; i++) points.push(shimmyAt(p, from + ((to - from) * i) / steps));
  let worst = points[0]!;
  for (const q of points) if (q.zeta < worst.zeta) worst = q;
  const on = points.find((q) => q.zeta < 0);
  return { points, minZeta: worst.zeta, worstSpeed: worst.speed, onset: on ? on.speed : null };
}

export interface ShimmyKick {
  /** The oscillation keeps going (or grows) beyond the free play: the wheels shimmy. */
  shimmies: boolean;
  /** Steer amplitude (deg) early and late after the kick, and late ÷ early. */
  early: number;
  late: number;
  ratio: number;
}

/**
 * Time simulation with the real dead zone (free play) and a kick: the wheels knocked to `kickRate` rad/s
 * of steer (a one-sided bump), plus optional wheel imbalance (a steer torque at the wheels' spin frequency,
 * N·m amplitude). RK4, 1 ms, `seconds` long.
 */
export function shimmyKick(p: ShimmyParams, u: number, o: { kickRate?: number; imbalance?: number; seconds?: number } = {}): ShimmyKick {
  const T = o.seconds ?? 3, dt = 1e-3, kick = o.kickRate ?? 1;
  const lin = shimmyMatrix({ ...p, stiffness: 0 }, u); // the steering spring is added with its dead zone
  const n = lin.length;
  const Ik = Math.max(p.knuckleInertia, 1e-6), It = Math.max(p.wheelInertia, 1e-6);
  const b = Math.max(0, p.freePlay);
  const spring = (d: number) => p.stiffness * (Math.abs(d) <= b ? 0 : d - Math.sign(d) * b);
  const omega = Math.max(u, 0.1) / Math.max(p.radius, 1e-3);
  const f = (t: number, x: number[]) => {
    const dx = lin.map((r) => r.reduce((a, v, j) => a + v * x[j]!, 0));
    const ts = spring(x[0]! - x[2]!);
    dx[1] = dx[1]! - ts / Ik + ((o.imbalance ?? 0) * Math.sin(omega * t)) / Ik;
    dx[3] = dx[3]! + ts / It;
    return dx;
  };
  let x = new Array<number>(n).fill(0);
  x[1] = kick;
  let early = 0, late = 0;
  for (let i = 0; i < Math.round(T / dt); i++) {
    const t = i * dt;
    const k1 = f(t, x);
    const k2 = f(t + dt / 2, x.map((v, j) => v + (dt / 2) * k1[j]!));
    const k3 = f(t + dt / 2, x.map((v, j) => v + (dt / 2) * k2[j]!));
    const k4 = f(t + dt, x.map((v, j) => v + dt * k3[j]!));
    x = x.map((v, j) => v + (dt / 6) * (k1[j]! + 2 * k2[j]! + 2 * k3[j]! + k4[j]!));
    if (!x.every(Number.isFinite) || Math.abs(x[0]!) > 1) return { shimmies: true, early, late: Infinity, ratio: Infinity };
    const a = Math.abs(x[0]!) * (180 / Math.PI);
    if (t >= 0.1 && t < 0.8) early = Math.max(early, a);
    if (t >= T - 1) late = Math.max(late, a);
  }
  const ratio = early > 0 ? late / early : 0;
  const playDeg = (b * 180) / Math.PI;
  // Sustained or growing, and more than rattling inside the play.
  return { shimmies: ratio > 0.8 && late > Math.max(1.5 * playDeg, 0.05), early, late, ratio };
}
