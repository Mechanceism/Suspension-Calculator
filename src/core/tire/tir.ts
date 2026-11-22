/**
 * Magic Formula tire models from `.tir` files (docs/MATH.md § Tire grip: .tir files).
 *
 * Implements the steady-state force equations of MF 6.1 / 6.2 (FITTYP 61 / 62) and MF 5.2 (FITTYP 52)
 * as published by Pacejka ("Tire and Vehicle Dynamics", 3rd ed., ch. 4) and the MF-Tyre 6.1 equation
 * manual: pure longitudinal and lateral slip with shifts, camber stiffness, load and pressure
 * dependence and the scaling factors λ, plus the combined-slip weighting functions Gxα and Gyκ.
 * Not included: aligning / overturning / rolling moments, turn slip, transient (relaxation) behavior.
 *
 * Conventions: the file's own (ISO, as fitted). Slip angle α and inclination γ in rad, slip ratio κ,
 * load Fz in N, pressure in kPa (converted from the file's units).
 */

export interface TirModel {
  kind: 'tir';
  /** File name (shown to the user). */
  name: string;
  /** FITTYP as written in the file (52, 61, 62; 6 in some older files). */
  fittyp: number;
  /** Which equations are used: MF 6.x (camber stiffness, pressure) or MF 5.2. */
  version: '6.1' | '5.2';
  /** Nominal load Fz0, N, and nominal pressure p0, kPa (0 = none in the file). */
  fnomin: number;
  nompres: number;
  /** Every numeric coefficient in the file, by name (upper case), in SI as the equations need them. */
  p: Record<string, number>;
}

export interface TirParse { model: TirModel | null; warnings: string[]; errors: string[] }

/** Read a `.tir` file. Unknown sections are fine; the force coefficients and FNOMIN are needed. */
export function parseTir(text: string, name = 'tire.tir'): TirParse {
  const warnings: string[] = [];
  const errors: string[] = [];
  const p: Record<string, number> = {};
  const str: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\$.*$/, '').replace(/!.*$/, '').trim();
    if (!line || line.startsWith('[') || line.startsWith('{')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toUpperCase();
    const val = m[2]!.trim();
    if (val === '') continue;
    if (/^'.*'$/.test(val) || /^".*"$/.test(val)) { str[key] = val.slice(1, -1).trim().toLowerCase(); continue; }
    const n = Number(val.replace(/[dD]/, 'e'));
    if (Number.isFinite(n)) p[key] = n;
  }
  // Units: lengths, forces (pressure = force / length²). Angles must be radians.
  const len = str.LENGTH ?? 'meter';
  const force = str.FORCE ?? 'newton';
  const lenToM = /^(mm|millimet)/.test(len) ? 1e-3 : /^(cm|centimet)/.test(len) ? 1e-2 : /^(in|inch)/.test(len) ? 0.0254 : 1;
  const forceToN = /^kn|kilonewton/.test(force) ? 1000 : /^(lbf|pound)/.test(force) ? 4.44822 : 1;
  if (str.ANGLE && !/^rad/.test(str.ANGLE)) warnings.push(`Angles in ${str.ANGLE}: the coefficients are read as radians, results may be wrong.`);
  if (forceToN !== 1) {
    for (const k of ['FNOMIN', 'VERTICAL_STIFFNESS']) if (p[k] !== undefined) p[k] = p[k]! * forceToN;
    warnings.push(`Forces converted from ${force} to N.`);
  }
  if (lenToM !== 1) {
    for (const k of ['UNLOADED_RADIUS', 'WIDTH', 'RIM_RADIUS', 'RIM_WIDTH']) if (p[k] !== undefined) p[k] = p[k]! * lenToM;
    warnings.push(`Lengths converted from ${len} to m.`);
  }
  const paFactor = forceToN / (lenToM * lenToM); // file pressure units → Pa
  const fittyp = p.FITTYP ?? (str.FITTYP ? Number(str.FITTYP) : NaN);
  // FITTYP alone isn't reliable (some MF 6 files say 6): coefficients only MF 6.x has decide it,
  // unless the file has MF 5.2's camber shift PHY3.
  const has6 = ['PKY4', 'PKY5', 'PKY6', 'PKY7', 'PEY5', 'PPY1', 'PPY2', 'PPY3', 'PPX1', 'PPX3'].some((k) => p[k] !== undefined);
  const version: '6.1' | '5.2' = fittyp >= 60 || (has6 && !(p.PHY3 !== undefined && p.PHY3 !== 0)) ? '6.1' : '5.2';
  if (!Number.isFinite(fittyp)) warnings.push(`No FITTYP: read with the MF ${version} equations.`);
  else if ((fittyp >= 60) !== (version === '6.1') || ![52, 61, 62].includes(fittyp)) warnings.push(`FITTYP ${fittyp}: read with the MF ${version} equations (from the coefficients in the file).`);
  const fnomin = p.FNOMIN ?? 0;
  if (!(fnomin > 0)) errors.push('FNOMIN (nominal load) is missing.');
  for (const k of ['PCY1', 'PDY1', 'PKY1', 'PCX1', 'PDX1', 'PKX1']) if (p[k] === undefined) errors.push(`${k} is missing: not a complete Magic Formula force fit.`);
  const nompresPa = (p.NOMPRES ?? 0) * paFactor;
  if (!(nompresPa > 0)) warnings.push('No NOMPRES (nominal pressure): pressure effects are off.');
  const inflKpa = (p.INFLPRES ?? 0) * paFactor / 1000;
  if (inflKpa > 0) p.INFLPRES_KPA = inflKpa;
  if (errors.length) return { model: null, warnings, errors };
  return { model: { kind: 'tir', name, fittyp: Number.isFinite(fittyp) ? fittyp : 0, version, fnomin, nompres: nompresPa / 1000, p }, warnings, errors };
}

export interface TirInputs {
  fz: number;
  /** Slip ratio κ and slip angle α (rad). */
  kappa: number;
  alpha: number;
  /** Inclination (rad), file convention. */
  gamma: number;
  /** Inflation pressure, kPa (omit = nominal). */
  pressure?: number;
}

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const EPS = 1e-6;

/** Coefficient lookup: missing ones are 0, scaling factors (L…) 1, PKY4 2 (MF 6.1 defaults). */
function coef(m: TirModel) {
  const q = m.p;
  const c = (k: string) => q[k] ?? 0;
  const l = (k: string) => q[k] ?? 1;
  return { c, l, mf6: m.version === '6.1' };
}

function common(m: TirModel, i: TirInputs) {
  const { c, l } = coef(m);
  const fz0 = m.fnomin * l('LFZO');
  const fz = Math.max(0, i.fz);
  const dfz = (fz - fz0) / fz0;
  const p = i.pressure ?? m.p.INFLPRES_KPA;
  const dpi = m.nompres > 0 && p !== undefined && Number.isFinite(p) ? (p - m.nompres) / m.nompres : 0;
  return { c, l, fz0, fz, dfz, dpi };
}

/** Pure longitudinal force Fx0(κ). */
export function tirFx0(m: TirModel, i: TirInputs): { fx: number; mux: number } {
  const { c, l, fz, dfz, dpi } = common(m, i);
  const { mf6 } = coef(m);
  const g = i.gamma;
  const SHx = (c('PHX1') + c('PHX2') * dfz) * l('LHX');
  const SVx = fz * (c('PVX1') + c('PVX2') * dfz) * l('LVX') * l('LMUX');
  const kx = i.kappa + SHx;
  const Cx = c('PCX1') * l('LCX');
  const mux = (c('PDX1') + c('PDX2') * dfz) * (mf6 ? 1 + c('PPX3') * dpi + c('PPX4') * dpi * dpi : 1) * (1 - c('PDX3') * g * g) * l('LMUX');
  const Dx = mux * fz;
  const Kx = fz * (c('PKX1') + c('PKX2') * dfz) * Math.exp(c('PKX3') * dfz) * (mf6 ? 1 + c('PPX1') * dpi + c('PPX2') * dpi * dpi : 1) * l('LKX');
  const Ex = Math.min(1, (c('PEX1') + c('PEX2') * dfz + c('PEX3') * dfz * dfz) * (1 - c('PEX4') * sgn(kx)) * l('LEX'));
  const Bx = Kx / (Cx * Dx + EPS);
  const bk = Bx * kx;
  return { fx: Dx * Math.sin(Cx * Math.atan(bk - Ex * (bk - Math.atan(bk)))) + SVx, mux };
}

/** Pure lateral force Fy0(α). */
export function tirFy0(m: TirModel, i: TirInputs): { fy: number; muy: number; ky: number } {
  const { c, l, fz0, fz, dfz, dpi } = common(m, i);
  const { mf6 } = coef(m);
  const gs = mf6 ? Math.sin(i.gamma) : i.gamma;
  const Cy = c('PCY1') * l('LCY');
  const muy = (c('PDY1') + c('PDY2') * dfz) * (mf6 ? 1 + c('PPY3') * dpi + c('PPY4') * dpi * dpi : 1) * (1 - c('PDY3') * gs * gs) * l('LMUY');
  const Dy = muy * fz;
  let Ky: number, SHy: number, SVy: number, Ey: number;
  if (mf6) {
    const pky4 = m.p.PKY4 ?? 2;
    Ky = c('PKY1') * fz0 * (1 + c('PPY1') * dpi) * (1 - c('PKY3') * Math.abs(gs))
      * Math.sin(pky4 * Math.atan(fz / ((c('PKY2') + c('PKY5') * gs * gs) * (1 + c('PPY2') * dpi) * fz0 || EPS))) * l('LKY');
    const Kyg0 = fz * (c('PKY6') + c('PKY7') * dfz) * (1 + c('PPY5') * dpi) * l('LKYC');
    const SVyg = fz * (c('PVY3') + c('PVY4') * dfz) * gs * l('LKYC') * l('LMUY');
    SVy = fz * (c('PVY1') + c('PVY2') * dfz) * l('LVY') * l('LMUY') + SVyg;
    SHy = (c('PHY1') + c('PHY2') * dfz) * l('LHY') + (Kyg0 * gs - SVyg) / (Ky + (Ky >= 0 ? EPS : -EPS));
    const ay = i.alpha + SHy;
    Ey = (c('PEY1') + c('PEY2') * dfz) * (1 + c('PEY5') * gs * gs - (c('PEY3') + c('PEY4') * gs) * sgn(ay)) * l('LEY');
  } else {
    Ky = c('PKY1') * fz0 * Math.sin(2 * Math.atan(fz / ((c('PKY2') * fz0) || EPS))) * (1 - c('PKY3') * Math.abs(gs)) * l('LKY');
    SHy = (c('PHY1') + c('PHY2') * dfz) * l('LHY') + c('PHY3') * gs;
    SVy = fz * ((c('PVY1') + c('PVY2') * dfz) * l('LVY') + (c('PVY3') + c('PVY4') * dfz) * gs) * l('LMUY');
    const ay = i.alpha + SHy;
    Ey = (c('PEY1') + c('PEY2') * dfz) * (1 - (c('PEY3') + c('PEY4') * gs) * sgn(ay)) * l('LEY');
  }
  Ey = Math.min(1, Ey);
  const ay = i.alpha + SHy;
  const By = Ky / (Cy * Dy + (Cy * Dy >= 0 ? EPS : -EPS));
  const ba = By * ay;
  return { fy: Dy * Math.sin(Cy * Math.atan(ba - Ey * (ba - Math.atan(ba)))) + SVy, muy, ky: Ky };
}

/** Combined slip: Fx = Gxα·Fx0, Fy = Gyκ·Fy0 + SVyκ. */
export function tirForces(m: TirModel, i: TirInputs): { fx: number; fy: number } {
  const { c, l, dfz, fz } = common(m, i);
  const { mf6 } = coef(m);
  const gs = mf6 ? Math.sin(i.gamma) : i.gamma;
  const fx0 = tirFx0(m, i).fx;
  const { fy: fy0, muy } = tirFy0(m, i);
  const g = (B: number, C: number, E: number, x: number) => Math.cos(C * Math.atan(B * x - E * (B * x - Math.atan(B * x))));
  // Longitudinal weighting by slip angle.
  const SHxa = c('RHX1');
  const Bxa = (c('RBX1') + c('RBX3') * gs * gs) * Math.cos(Math.atan(c('RBX2') * i.kappa)) * l('LXAL');
  const Cxa = c('RCX1');
  const Exa = Math.min(1, c('REX1') + c('REX2') * dfz);
  const Gxa0 = g(Bxa, Cxa, Exa, SHxa);
  const Gxa = Gxa0 !== 0 ? g(Bxa, Cxa, Exa, i.alpha + SHxa) / Gxa0 : 1;
  // Lateral weighting by slip ratio, plus the "ply-steer"-like shift SVyκ.
  const DVyk = muy * fz * (c('RVY1') + c('RVY2') * dfz + c('RVY3') * gs) * Math.cos(Math.atan(c('RVY4') * i.alpha));
  const SVyk = DVyk * Math.sin(c('RVY5') * Math.atan(c('RVY6') * i.kappa)) * l('LVYKA');
  const SHyk = c('RHY1') + c('RHY2') * dfz;
  const Byk = (c('RBY1') + c('RBY4') * gs * gs) * Math.cos(Math.atan(c('RBY2') * (i.alpha - c('RBY3')))) * l('LYKA');
  const Cyk = c('RCY1');
  const Eyk = Math.min(1, c('REY1') + c('REY2') * dfz);
  const Gyk0 = g(Byk, Cyk, Eyk, SHyk);
  const Gyk = Gyk0 !== 0 ? g(Byk, Cyk, Eyk, i.kappa + SHyk) / Gyk0 : 1;
  return { fx: Gxa * fx0, fy: Gyk * fy0 + SVyk };
}

// ---------------------------------------------------------------- "toward the force" view used by the car

/**
 * The car only needs a tire's force in the direction it must push, with its lean measured toward that
 * direction (+ = top leaning into the turn). From a fitted file (asymmetric, ISO signs) that is: the
 * force in each direction with the camber that leans toward it, averaged over both directions (left and
 * right tires are mirror images), with the slip angle that pushes that way.
 */
const thrustSign = new WeakMap<TirModel, number>();
function camberThrustSign(m: TirModel): number {
  let s = thrustSign.get(m);
  if (s === undefined) {
    const at = (g: number) => tirFy0(m, { fz: m.fnomin, kappa: 0, alpha: 0, gamma: g }).fy;
    s = Math.sign(at(0.03) - at(-0.03)) || 1;
    thrustSign.set(m, s);
  }
  return s;
}
const kySign = new WeakMap<TirModel, number>();
function corneringSign(m: TirModel): number {
  let s = kySign.get(m);
  if (s === undefined) {
    const at = (a: number) => tirFy0(m, { fz: m.fnomin, kappa: 0, alpha: a, gamma: 0 }).fy;
    s = Math.sign(at(0.01) - at(-0.01)) || 1;
    kySign.set(m, s);
  }
  return s;
}

/** Side force toward the push direction at slip angle α ≥ 0 (toward-frame), lean `gamma` toward it. */
export function tirLateralToward(m: TirModel, alpha: number, fz: number, gamma: number, pressure?: number): number {
  const sa = corneringSign(m), st = camberThrustSign(m);
  let sum = 0;
  for (const d of [1, -1]) {
    sum += d * tirFy0(m, { fz, kappa: 0, alpha: d * sa * alpha, gamma: d * st * gamma, pressure }).fy;
  }
  return sum / 2;
}

/** Braking / drive force magnitude toward the push direction at slip ratio κ ≥ 0 (mean of drive and brake). */
export function tirLongitudinalToward(m: TirModel, kappa: number, fz: number, gamma: number, pressure?: number): number {
  return (tirFx0(m, { fz, kappa, alpha: 0, gamma, pressure }).fx - tirFx0(m, { fz, kappa: -kappa, alpha: 0, gamma, pressure }).fx) / 2;
}
