/**
 * Fit a Magic Formula 6.1 tire model to measured data (docs/MATH.md § Tire grip: fitting).
 *
 * Data: one row per measurement with slip angle, slip ratio, load, inclination, pressure and the
 * forces (e.g. a TTC run exported as CSV / tab-separated text). Pure-cornering rows (|slip ratio| small)
 * fit the lateral coefficients, pure braking / driving rows (|slip angle| small) the longitudinal ones,
 * each by bounded least squares on (model − measured) ÷ Fz0. The data's own sign convention is kept
 * (the coefficients take whatever signs fit it). Moments, combined slip and turn slip are not fitted.
 */
import { boundedLeastSquares } from '../optimize/leastSquares';
import { tirFx0, tirFy0, type TirModel } from './tir';

export interface TireSample {
  /** Slip angle and inclination, rad; slip ratio; load N (positive); pressure kPa; forces N. */
  sa: number;
  sl: number;
  fz: number;
  ia: number;
  p?: number;
  fx?: number;
  fy?: number;
}

export interface TireCsv {
  samples: TireSample[];
  columns: string[];
  warnings: string[];
  errors: string[];
}

const ALIASES: Record<keyof TireSample, RegExp> = {
  sa: /^(sa|alpha|slip_?angle|slipangle)$/i,
  sl: /^(sl|sr|kappa|slip_?ratio|slipratio|long_?slip)$/i,
  fz: /^(fz|load|normal_?load|vertical_?load)$/i,
  ia: /^(ia|gamma|camber|inclination|incl)$/i,
  p: /^(p|pressure|press|inflation)$/i,
  fx: /^(fx|long_?force)$/i,
  fy: /^(fy|lat_?force|side_?force)$/i,
};

/**
 * Read a table of measurements: comma, semicolon, tab or space separated; the first row whose cells
 * name the columns is the header (an optional units row after it is skipped); angles in degrees unless
 * the units row says rad (or `angles` is given); pressure in kPa (psi / bar / Pa from the units row).
 */
export function parseTireTable(text: string, angles?: 'deg' | 'rad'): TireCsv {
  const warnings: string[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const split = (l: string) => l.trim().split(/[,;\t]|\s+/).map((c) => c.trim().replace(/^"|"$/g, '')).filter((c) => c !== '');
  let header = -1;
  let cols: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const cells = split(lines[i]!);
    if (cells.filter((c) => Object.values(ALIASES).some((re) => re.test(c))).length >= 3) { header = i; cols = cells; break; }
  }
  if (header < 0) return { samples: [], columns: [], warnings, errors: ['No header row naming the columns (e.g. SA, SL, FZ, IA, P, FX, FY).'] };
  const idx = {} as Record<keyof TireSample, number>;
  for (const k of Object.keys(ALIASES) as (keyof TireSample)[]) idx[k] = cols.findIndex((c) => ALIASES[k].test(c));
  if (idx.fz < 0) errors.push('No load column (FZ).');
  if (idx.fy < 0 && idx.fx < 0) errors.push('No force column (FY or FX).');
  if (idx.sa < 0 && idx.fy >= 0) errors.push('No slip angle column (SA).');
  if (errors.length) return { samples: [], columns: cols, warnings, errors };
  // Optional units row right after the header.
  let first = header + 1;
  const unitsRow = lines[first] ? split(lines[first]!) : [];
  const numeric = (c: string) => c !== '' && Number.isFinite(Number(c));
  let angleUnit = angles ?? 'deg';
  let pFactor = 1;
  if (unitsRow.length && !unitsRow.every(numeric)) {
    first++;
    const u = (k: keyof TireSample) => (idx[k] >= 0 ? (unitsRow[idx[k]] ?? '').toLowerCase() : '');
    if (!angles && /rad/.test(u('sa'))) angleUnit = 'rad';
    const pu = u('p');
    pFactor = /psi/.test(pu) ? 6.89476 : /bar/.test(pu) ? 100 : /^pa$/.test(pu) ? 0.001 : /mpa/.test(pu) ? 1000 : 1;
  }
  const a = angleUnit === 'deg' ? Math.PI / 180 : 1;
  const samples: TireSample[] = [];
  for (let i = first; i < lines.length; i++) {
    const c = split(lines[i]!).map(Number);
    const v = (k: keyof TireSample) => (idx[k] >= 0 ? c[idx[k]] : undefined);
    const fz = v('fz');
    if (fz === undefined || !Number.isFinite(fz)) continue;
    const s: TireSample = { sa: (v('sa') ?? 0) * a, sl: v('sl') ?? 0, fz: Math.abs(fz), ia: (v('ia') ?? 0) * a };
    const p = v('p'), fx = v('fx'), fy = v('fy');
    if (p !== undefined && Number.isFinite(p)) s.p = p * pFactor;
    if (fx !== undefined && Number.isFinite(fx)) s.fx = fx;
    if (fy !== undefined && Number.isFinite(fy)) s.fy = fy;
    if ([s.sa, s.sl, s.ia].every(Number.isFinite) && s.fz > 10) samples.push(s);
  }
  if (!samples.length) errors.push('No usable rows (numbers with a load above 10 N).');
  if (idx.ia < 0) warnings.push('No inclination column: camber effects are not fitted.');
  if (idx.p < 0) warnings.push('No pressure column: pressure effects are not fitted.');
  if (angleUnit === 'deg') warnings.push('Slip and inclination angles read as degrees.');
  return { samples, columns: cols, warnings, errors };
}

export interface FitQuality { rows: number; rmsN: number; r2: number }
export interface TireFitResult { model: TirModel; lateral: FitQuality | null; longitudinal: FitQuality | null; warnings: string[] }

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const thin = <T,>(xs: T[], max: number) => (xs.length <= max ? xs : xs.filter((_, i) => i % Math.ceil(xs.length / max) === 0));

interface ParamSpec { key: string; x0: number; lo: number; hi: number }

function quality(rows: TireSample[], pred: (s: TireSample) => number, meas: (s: TireSample) => number): FitQuality {
  const y = rows.map(meas);
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  let ss = 0, st = 0;
  rows.forEach((s, i) => { ss += (pred(s) - y[i]!) ** 2; st += (y[i]! - mean) ** 2; });
  return { rows: rows.length, rmsN: Math.sqrt(ss / rows.length), r2: st > 0 ? 1 - ss / st : 0 };
}

/** Fit the pure-slip force coefficients of an MF 6.1 model to the samples. */
export function fitTire(samples: TireSample[], opts: { name?: string; fnomin?: number; nompres?: number; maxRows?: number } = {}, onProgress?: (stage: string, iteration: number) => void): TireFitResult {
  const warnings: string[] = [];
  const fnomin = Math.round(opts.fnomin ?? median(samples.map((s) => s.fz)));
  const ps = samples.map((s) => s.p).filter((p): p is number => p !== undefined);
  const nompres = opts.nompres ?? (ps.length ? Math.round(median(ps)) : 0);
  const pSpread = ps.length ? Math.max(...ps) - Math.min(...ps) : 0;
  const iaSpread = samples.length ? Math.max(...samples.map((s) => Math.abs(s.ia))) : 0;
  const p: Record<string, number> = { PKY4: 2 };
  const base = (): TirModel => ({ kind: 'tir', name: opts.name ?? 'fitted.tir', fittyp: 61, version: '6.1', fnomin, nompres, p: { ...p } });
  const max = opts.maxRows ?? 2500;

  const fitOne = (stage: string, rows: TireSample[], specs: ParamSpec[], pred: (m: TirModel, s: TireSample) => number, meas: (s: TireSample) => number) => {
    const keys = specs.map((s) => s.key);
    const model = base();
    const res = (x: number[]) => {
      keys.forEach((k, i) => { model.p[k] = x[i]!; });
      return rows.map((s) => (pred(model, s) - meas(s)) / fnomin);
    };
    const r = boundedLeastSquares(res, specs.map((s) => s.x0), specs.map((s) => s.lo), specs.map((s) => s.hi), {
      maxIterations: 80, step: 1e-4, relTol: 1e-9,
      onIteration: (i) => { onProgress?.(stage, i.iteration); },
    });
    keys.forEach((k, i) => { p[k] = r.x[i]!; });
    const fitted = base();
    return quality(rows, (s) => pred(fitted, s), meas);
  };

  // Lateral: pure cornering rows.
  let lateral: FitQuality | null = null;
  const latRows = thin(samples.filter((s) => s.fy !== undefined && Math.abs(s.sl) < 0.02), max);
  if (latRows.length >= 30) {
    const near = latRows.filter((s) => Math.abs(s.sa) < 0.035 && Math.abs(s.ia) < 0.01);
    // Cornering stiffness sign and size from a line through the small-slip rows.
    const sxy = near.reduce((a, s) => a + s.sa * s.fy! / s.fz, 0), sxx = near.reduce((a, s) => a + s.sa * s.sa, 0);
    const slope = sxx > 0 ? sxy / sxx : -15; // ≈ Ky / Fz, per rad
    const muy = Math.max(...latRows.map((s) => Math.abs(s.fy!) / s.fz));
    const specs: ParamSpec[] = [
      { key: 'PCY1', x0: 1.4, lo: 0.8, hi: 2.5 },
      { key: 'PDY1', x0: muy, lo: 0.1, hi: 4 },
      { key: 'PDY2', x0: -0.1, lo: -1, hi: 0.5 },
      { key: 'PEY1', x0: -0.5, lo: -10, hi: 1 },
      { key: 'PEY2', x0: 0, lo: -5, hi: 5 },
      { key: 'PKY1', x0: slope / Math.sin(2 * Math.atan(1 / 1.7)), lo: slope < 0 ? -200 : 0.5, hi: slope < 0 ? -0.5 : 200 },
      { key: 'PKY2', x0: 1.7, lo: 0.3, hi: 6 },
      { key: 'PHY1', x0: 0, lo: -0.05, hi: 0.05 },
      { key: 'PVY1', x0: 0, lo: -0.3, hi: 0.3 },
    ];
    if (iaSpread > 0.01) specs.push(
      { key: 'PDY3', x0: 5, lo: -20, hi: 60 },
      { key: 'PKY6', x0: 1, lo: -10, hi: 10 },
      { key: 'PVY3', x0: 0, lo: -5, hi: 5 },
    );
    if (pSpread > 5 && nompres > 0) specs.push({ key: 'PPY1', x0: 0, lo: -3, hi: 3 }, { key: 'PPY3', x0: 0, lo: -3, hi: 3 });
    // The peak (PDY1) is positive; the data's sign convention goes into the cornering stiffness (PKY1).
    lateral = fitOne('lateral', latRows, specs, (m, s) => tirFy0(m, { fz: s.fz, kappa: 0, alpha: s.sa, gamma: s.ia, pressure: s.p }).fy, (s) => s.fy!);
  } else warnings.push(`Only ${latRows.length} pure-cornering rows (slip ratio near 0): lateral coefficients not fitted.`);

  // Longitudinal: pure braking / driving rows.
  let longitudinal: FitQuality | null = null;
  const lonRows = thin(samples.filter((s) => s.fx !== undefined && Math.abs(s.sa) < 0.01), max);
  if (lonRows.length >= 30) {
    const mux = Math.max(...lonRows.map((s) => Math.abs(s.fx!) / s.fz));
    const specs: ParamSpec[] = [
      { key: 'PCX1', x0: 1.6, lo: 0.8, hi: 2.5 },
      { key: 'PDX1', x0: mux, lo: 0.1, hi: 4 },
      { key: 'PDX2', x0: -0.1, lo: -1, hi: 0.5 },
      { key: 'PEX1', x0: 0, lo: -10, hi: 1 },
      { key: 'PKX1', x0: 20, lo: 1, hi: 200 },
      { key: 'PKX2', x0: 0, lo: -50, hi: 50 },
      { key: 'PHX1', x0: 0, lo: -0.05, hi: 0.05 },
      { key: 'PVX1', x0: 0, lo: -0.3, hi: 0.3 },
    ];
    if (iaSpread > 0.01) specs.push({ key: 'PDX3', x0: 0, lo: -20, hi: 60 });
    if (pSpread > 5 && nompres > 0) specs.push({ key: 'PPX1', x0: 0, lo: -3, hi: 3 }, { key: 'PPX3', x0: 0, lo: -3, hi: 3 });
    longitudinal = fitOne('longitudinal', lonRows, specs, (m, s) => tirFx0(m, { fz: s.fz, kappa: s.sl, alpha: 0, gamma: s.ia, pressure: s.p }).fx, (s) => s.fx!);
  } else warnings.push(`Only ${lonRows.length} pure braking / driving rows (slip angle near 0): longitudinal coefficients not fitted (generic ones used).`);
  // A model needs both directions: fill what wasn't fitted with plausible values.
  if (!lateral) Object.assign(p, { PCY1: 1.3, PDY1: 1.0, PKY1: -15, PKY2: 1.7, PEY1: -0.5 });
  if (!longitudinal) Object.assign(p, { PCX1: 1.5, PDX1: (p.PDY1 ?? 1) * 1.05, PKX1: 20 });
  return { model: base(), lateral, longitudinal, warnings };
}

/** Write a model as a .tir file (the force coefficients and what they need). */
export function writeTir(m: TirModel): string {
  const L: string[] = [];
  const line = (k: string, v: string | number) => L.push(`${k.padEnd(28)} = ${typeof v === 'number' ? Number(v.toPrecision(8)) : `'${v}'`}`);
  L.push('[MDI_HEADER]'); line('FILE_TYPE', 'tir'); line('FILE_VERSION', 3); line('FILE_FORMAT', 'ASCII');
  L.push(`$ ${m.name}: written by Suspension Calculator (Magic Formula ${m.version} force coefficients)`);
  L.push('[UNITS]'); line('LENGTH', 'meter'); line('FORCE', 'newton'); line('ANGLE', 'radians'); line('MASS', 'kg'); line('TIME', 'second');
  L.push('[MODEL]'); line('FITTYP', m.version === '6.1' ? 61 : 52);
  L.push('[OPERATING_CONDITIONS]'); if (m.nompres > 0) line('NOMPRES', m.nompres * 1000);
  L.push('[VERTICAL]'); line('FNOMIN', m.fnomin);
  const groups: [string, RegExp][] = [
    ['DIMENSION', /^(UNLOADED_RADIUS|WIDTH|RIM_RADIUS|RIM_WIDTH|ASPECT_RATIO)$/],
    ['SCALING_COEFFICIENTS', /^L[A-Z0-9]+$/],
    ['LONGITUDINAL_COEFFICIENTS', /^P[A-Z]X\d$|^PPX\d$/],
    ['LATERAL_COEFFICIENTS', /^P[A-Z]Y\d$|^PPY\d$/],
    ['COMBINED_SLIP', /^R[A-Z]{2}\d$/],
  ];
  for (const [section, re] of groups) {
    const keys = Object.keys(m.p).filter((k) => re.test(k)).sort();
    if (!keys.length) continue;
    L.push(`[${section}]`);
    for (const k of keys) line(k, m.p[k]!);
  }
  return L.join('\n') + '\n';
}
