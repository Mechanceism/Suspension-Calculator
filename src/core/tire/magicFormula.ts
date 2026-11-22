/**
 * Official tire grip model: Magic Formula (Pacejka), a compact subset of MF 5.2 / 6.1 (docs/MATH.md
 * § Tire grip: Magic Formula). Steady-state force vs. slip for one tire:
 *
 *   F(s) = D · sin(C · atan(B·s − E·(B·s − atan(B·s)))) + S_V
 *
 *   lateral, s = slip angle α (rad):
 *     dfz = (Fz − Fz0)/Fz0,  dp = (p − p0)/p0
 *     D  = (pDy1 + pDy2·dfz)·(1 + ppy3·dp)·(1 − pDy3·γ²)·Fz          peak (load sensitivity, camber, pressure)
 *     K  = pKy1·Fz0·sin(2·atan(Fz / (pKy2·Fz0)))·(1 − pKy3·|γ|)·(1 + ppy1·dp)   cornering stiffness, N/rad
 *     C = pCy1,  B = K / (C·D),  E = pEy1 + pEy2·dfz (≤ 1)
 *     S_V = pVy3·γ·Fz                                                  camber thrust
 *   longitudinal, s = slip ratio κ:
 *     D = (pDx1 + pDx2·dfz)·(1 + ppx3·dp)·(1 − pDx3·γ²)·Fz,  K = pKx1·Fz,  C = pCx1,  E = pEx1
 *
 * γ is the inclination to the road (rad), signed so + leans the top of the wheel toward + force:
 * a wheel leaning into the turn gets camber thrust on top of its peak, one leaning out loses it.
 * With C ≥ 1 the peak is D (+ S_V); far past the peak the force falls to D·sin(C·π/2): the sliding
 * friction. Combined slip uses the friction ellipse (Fx/Dx)² + (Fy/Dy)² ≤ 1.
 *
 * The default coefficients are GENERIC (a plausible tire, not fitted to any real one).
 */

import { tirLateralToward, tirLongitudinalToward, type TirModel } from './tir';

/** The tire grip model: the simple generic subset (editable) or a full model loaded from a `.tir` file. */
export type TireGrip = MFCoeffs | TirModel;
const isTir = (m: TireGrip): m is TirModel => (m as TirModel).kind === 'tir';
/** Nominal load of either model, N. */
export const nominalLoad = (m: TireGrip) => (isTir(m) ? m.fnomin : m.fz0);

export interface MFCoeffs {
  /** Nominal load Fz0, N. */
  fz0: number;
  /** Nominal (reference) inflation pressure p0, kPa. */
  p0: number;
  // Lateral
  pCy1: number; pDy1: number; pDy2: number; pDy3: number; pEy1: number; pEy2: number;
  pKy1: number; pKy2: number; pKy3: number; pVy3: number; ppy1: number; ppy3: number;
  // Longitudinal
  pCx1: number; pDx1: number; pDx2: number; pDx3: number; pEx1: number; pKx1: number; ppx3: number;
}

/** Generic coefficients: a plausible tire, NOT fitted to any real tire. */
export const DEFAULT_MF: MFCoeffs = {
  fz0: 1000, p0: 83,
  pCy1: 1.3, pDy1: 1.0, pDy2: -0.1, pDy3: 12, pEy1: -0.5, pEy2: 0,
  pKy1: 22, pKy2: 1.7, pKy3: 0.5, pVy3: 1.0, ppy1: 0, ppy3: -0.1,
  pCx1: 1.5, pDx1: 1.05, pDx2: -0.1, pDx3: 5, pEx1: 0, pKx1: 20, ppx3: -0.1,
};

export interface MFInputs {
  /** Vertical load, N. */
  fz: number;
  /** Inclination to the road, rad (+ = top of the wheel leaning toward + force). */
  gamma?: number;
  /** Inflation pressure, kPa (omit = nominal). */
  pressure?: number;
}

interface Curve { B: number; C: number; D: number; E: number; SV: number }

const dfzOf = (m: MFCoeffs, fz: number) => (fz - m.fz0) / m.fz0;
const dpOf = (m: MFCoeffs, p?: number) => (p !== undefined && Number.isFinite(p) && m.p0 > 0 ? (p - m.p0) / m.p0 : 0);

function lateralCurve(m: MFCoeffs, i: MFInputs): Curve {
  const fz = Math.max(i.fz, 0), g = i.gamma ?? 0, dfz = dfzOf(m, fz), dp = dpOf(m, i.pressure);
  const C = m.pCy1;
  const D = Math.max(0, (m.pDy1 + m.pDy2 * dfz) * (1 + m.ppy3 * dp) * (1 - m.pDy3 * g * g)) * fz;
  const K = m.pKy1 * m.fz0 * Math.sin(2 * Math.atan(fz / Math.max(m.pKy2 * m.fz0, 1e-9))) * Math.max(0, 1 - m.pKy3 * Math.abs(g)) * (1 + m.ppy1 * dp);
  return { B: D > 0 && C ? K / (C * D) : 0, C, D, E: Math.min(1, m.pEy1 + m.pEy2 * dfz), SV: m.pVy3 * g * fz };
}

function longitudinalCurve(m: MFCoeffs, i: MFInputs): Curve {
  const fz = Math.max(i.fz, 0), g = i.gamma ?? 0, dfz = dfzOf(m, fz), dp = dpOf(m, i.pressure);
  const C = m.pCx1;
  const D = Math.max(0, (m.pDx1 + m.pDx2 * dfz) * (1 + m.ppx3 * dp) * (1 - m.pDx3 * g * g)) * fz;
  const K = m.pKx1 * fz;
  return { B: D > 0 && C ? K / (C * D) : 0, C, D, E: Math.min(1, m.pEx1), SV: 0 };
}

const curve = (c: Curve, s: number) => {
  const bs = c.B * s;
  return c.D * Math.sin(c.C * Math.atan(bs - c.E * (bs - Math.atan(bs)))) + c.SV;
};

/** Slip where the curve peaks (beyond it the tire slides), or a large slip when C < 1 (no peak). */
function peakSlip(c: Curve, max: number): number {
  if (!(c.B > 0)) return max;
  if (c.C <= 1) return max;
  const target = Math.tan(Math.PI / (2 * c.C));
  const X = (s: number) => { const bs = c.B * s; return bs - c.E * (bs - Math.atan(bs)); };
  if (X(max) < target) return max;
  let lo = 0, hi = max;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (X(mid) < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Lateral force at slip angle α (rad), N. */
export const mfLateral = (m: TireGrip, alpha: number, i: MFInputs): number => (isTir(m)
  ? Math.sign(alpha || 1) * tirLateralToward(m, Math.abs(alpha), i.fz, Math.sign(alpha || 1) * (i.gamma ?? 0), i.pressure)
  : curve(lateralCurve(m, i), alpha));
/** Longitudinal force at slip ratio κ, N. */
export const mfLongitudinal = (m: TireGrip, kappa: number, i: MFInputs): number => (isTir(m)
  ? Math.sign(kappa || 1) * tirLongitudinalToward(m, Math.abs(kappa), i.fz, i.gamma ?? 0, i.pressure)
  : curve(longitudinalCurve(m, i), kappa));

export interface MFPeaks {
  /** Peak lateral force in the + direction (camber thrust included), N. */
  y: number;
  /** Peak longitudinal force, N. */
  x: number;
  /** Force far past the peak ÷ peak force: the sliding friction share (lateral, longitudinal). */
  slideY: number;
  slideX: number;
  /** Cornering stiffness (N/rad) and slip stiffness (N per unit slip). */
  ky: number;
  kx: number;
}

const ALPHA_MAX = 1.2; // rad
const KAPPA_MAX = 1.0;

export function mfPeaks(m: TireGrip, i: MFInputs): MFPeaks {
  if (isTir(m)) return tirPeaksCached(m, i);
  const cy = lateralCurve(m, i), cx = longitudinalCurve(m, i);
  const y = Math.max(0, curve(cy, peakSlip(cy, ALPHA_MAX)));
  const x = Math.max(0, curve(cx, peakSlip(cx, KAPPA_MAX)));
  const slide = (c: Curve, peak: number) => (peak > 0 ? Math.max(0, Math.min(1, (c.D * Math.sin((c.C * Math.PI) / 2) + c.SV) / peak)) : 1);
  return { y, x, slideY: slide(cy, y), slideX: slide(cx, x), ky: cy.B * cy.C * cy.D, kx: cx.B * cx.C * cx.D };
}

/** Slip on the rising part of the curve that gives force f (NaN when f is beyond the peak). */
function invert(c: Curve, f: number, max: number): number {
  const sp = peakSlip(c, max);
  const lo0 = -sp, hi0 = sp;
  const flo = curve(c, lo0), fhi = curve(c, hi0);
  if (f < Math.min(flo, fhi) - 1e-9 || f > Math.max(flo, fhi) + 1e-9) return NaN;
  let lo = lo0, hi = hi0;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (curve(c, mid) < f) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Slip angle (rad) that gives lateral force fy, NaN beyond the peak. */
export const mfSlipAngle = (m: TireGrip, fy: number, i: MFInputs): number => (isTir(m)
  ? invertToward((a) => tirLateralToward(m, a, i.fz, i.gamma ?? 0, i.pressure), fy, TIR_ALPHA)
  : invert(lateralCurve(m, i), fy, ALPHA_MAX));
/** Slip ratio that gives longitudinal force fx, NaN beyond the peak. */
export const mfSlipRatio = (m: TireGrip, fx: number, i: MFInputs): number => (isTir(m)
  ? invertToward((k) => tirLongitudinalToward(m, k, i.fz, i.gamma ?? 0, i.pressure), fx, TIR_KAPPA)
  : invert(longitudinalCurve(m, i), fx, KAPPA_MAX));

/** Peak slip angle (rad) and slip ratio: past these the tire slides. */
export function mfPeakSlips(m: TireGrip, i: MFInputs): { alpha: number; kappa: number } {
  if (isTir(m)) {
    return {
      alpha: scanPeak((a) => tirLateralToward(m, a, i.fz, i.gamma ?? 0, i.pressure), TIR_ALPHA).at,
      kappa: scanPeak((k) => tirLongitudinalToward(m, k, i.fz, i.gamma ?? 0, i.pressure), TIR_KAPPA).at,
    };
  }
  return { alpha: peakSlip(lateralCurve(m, i), ALPHA_MAX), kappa: peakSlip(longitudinalCurve(m, i), KAPPA_MAX) };
}

// ---------------------------------------------------------------- .tir models: numeric peaks, cached

const TIR_ALPHA = 0.6; // rad scanned for the side-force peak
const TIR_KAPPA = 0.5;

/** Largest value of f on [0, max] (scan, then golden-section refine). */
function scanPeak(f: (x: number) => number, max: number, n = 60): { at: number; value: number } {
  let bi = 0, bv = -Infinity;
  for (let k = 0; k <= n; k++) { const v = f((max * k) / n); if (v > bv) { bv = v; bi = k; } }
  let a = (max * Math.max(0, bi - 1)) / n, b = (max * Math.min(n, bi + 1)) / n;
  const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a), d = a + r * (b - a), fc = f(c), fd = f(d);
  for (let it = 0; it < 30; it++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - r * (b - a); fc = f(c); } else { a = c; c = d; fc = fd; d = a + r * (b - a); fd = f(d); }
  }
  const at = (a + b) / 2, v = f(at);
  return v >= bv ? { at, value: v } : { at: (max * bi) / n, value: bv };
}

/** Slip on the rising part of a toward-frame curve that gives |force| (sign of force); NaN past the peak. */
function invertToward(f: (x: number) => number, force: number, max: number): number {
  const target = Math.abs(force);
  const pk = scanPeak(f, max);
  if (target > pk.value + 1e-9) return NaN;
  if (target <= f(0)) return 0;
  let lo = 0, hi = pk.at;
  for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (f(mid) < target) lo = mid; else hi = mid; }
  return Math.sign(force || 1) * (lo + hi) / 2;
}

function tirPeaksRaw(m: TirModel, fz: number, gamma: number, pressure?: number): MFPeaks {
  const fy = (a: number) => tirLateralToward(m, a, fz, gamma, pressure);
  const fx = (k: number) => tirLongitudinalToward(m, k, fz, gamma, pressure);
  const py = scanPeak(fy, TIR_ALPHA), px = scanPeak(fx, TIR_KAPPA);
  const h = 1e-4;
  return {
    y: Math.max(0, py.value), x: Math.max(0, px.value),
    slideY: py.value > 0 ? Math.max(0, Math.min(1, fy(1.2) / py.value)) : 1,
    slideX: px.value > 0 ? Math.max(0, Math.min(1, fx(1.0) / px.value)) : 1,
    ky: (fy(h) - fy(-h)) / (2 * h), kx: (fx(h) - fx(0)) / h,
  };
}

interface PeakTable { fzMax: number; gMax: number; nf: number; ng: number; data: MFPeaks[] }
const tables = new WeakMap<TirModel, Map<string, PeakTable>>();
const PEAK_KEYS = ['y', 'x', 'slideY', 'slideX', 'ky', 'kx'] as const;

/** Peaks from a table over load (0 … 4·Fz0) and lean (±0.15 rad), per pressure: the car calls this a lot. */
function tirPeaksCached(m: TirModel, i: MFInputs): MFPeaks {
  let byP = tables.get(m);
  if (!byP) { byP = new Map(); tables.set(m, byP); }
  const pk = i.pressure !== undefined && Number.isFinite(i.pressure) ? i.pressure.toFixed(1) : '-';
  let t = byP.get(pk);
  if (!t) {
    const nf = 25, ng = 13, fzMax = 4 * m.fnomin, gMax = 0.15;
    const data: MFPeaks[] = [];
    for (let a = 0; a < nf; a++) for (let b = 0; b < ng; b++) data.push(tirPeaksRaw(m, (fzMax * a) / (nf - 1) || 1, -gMax + (2 * gMax * b) / (ng - 1), i.pressure));
    t = { fzMax, gMax, nf, ng, data };
    byP.set(pk, t);
  }
  const fa = Math.min(t.nf - 1, Math.max(0, (Math.max(0, i.fz) / t.fzMax) * (t.nf - 1)));
  const gb = Math.min(t.ng - 1, Math.max(0, (((i.gamma ?? 0) + t.gMax) / (2 * t.gMax)) * (t.ng - 1)));
  const a0 = Math.min(t.nf - 2, Math.floor(fa)), b0 = Math.min(t.ng - 2, Math.floor(gb));
  const u = fa - a0, v = gb - b0;
  const at = (a: number, b: number) => t!.data[a * t!.ng + b]!;
  const out = {} as MFPeaks;
  for (const k of PEAK_KEYS) {
    out[k] = (1 - u) * ((1 - v) * at(a0, b0)[k] + v * at(a0, b0 + 1)[k]) + u * ((1 - v) * at(a0 + 1, b0)[k] + v * at(a0 + 1, b0 + 1)[k]);
  }
  // Beyond 4·Fz0: scale the peaks with load.
  if (i.fz > t.fzMax) { out.y *= i.fz / t.fzMax; out.x *= i.fz / t.fzMax; }
  return out;
}
