/**
 * Aerodynamics (docs/MATH.md § Aero). Forces on the body, never through the tires:
 *   drag  D = ½ρV²·CdA, rearward at the drag height (the tires must drive against it: a braking force
 *             on the car that also moves load rearward)
 *   lift  L_f = ½ρV²·ClA_f at the front axle, L_r = ½ρV²·ClA_r at the rear axle (+ = lift, − = downforce)
 * Coefficients are areas (m²): constants, or an aero map over front and rear ride height (bilinear,
 * held at the edges), so rake and ride height change downforce and balance as the body moves.
 * Ride height = the body reference plane's height above the ground at the axle (as in the Vehicle view),
 * absolute (mm) or as the change from the design ride height.
 *
 * Exchange format (for a separate aero / CFD tool), JSON:
 *   { "format": "suspension-aero", "version": 1, "name": "…",
 *     "CdA": 0.9, "ClAf": -0.6, "ClAr": -0.9, "dragHeight": 450,        constants (m², mm), or
 *     "rideHeightRef": "absolute" | "change",
 *     "map": { "rhFront": [mm…], "rhRear": [mm…], "CdA": [[…]], "ClAf": [[…]], "ClAr": [[…]] } }
 *   map tables are [front index][rear index]. "ClA" with "balance" (front share of the downforce, 0–1)
 *   can stand in for ClAf / ClAr.
 * or CSV with a header row: rhF, rhR, CdA, ClAf, ClAr (one row per ride-height pair, forming a grid).
 */

export interface AeroMap {
  rhFront: number[];
  rhRear: number[];
  /** Tables [front index][rear index], m². */
  CdA: number[][];
  ClAf: number[][];
  ClAr: number[][];
}

export interface AeroModel {
  name: string;
  /** Drag area and lift areas at the front / rear axle, m² (+ lift, − downforce). Used without a map. */
  CdA: number;
  ClAf: number;
  ClAr: number;
  map?: AeroMap;
  /** Map ride heights: absolute (mm above the ground) or the change from the design ride height (mm). */
  rideHeightRef: 'absolute' | 'change';
  /** Height of the drag force above the ground, mm. */
  dragHeight: number;
}

export interface AeroInput {
  model: AeroModel;
  /** Air speed, m/s, and air density, kg/m³. */
  speed: number;
  rho: number;
}

/** Air density from altitude (m) and temperature (°C), kg/m³ (standard atmosphere pressure, dry air). */
export function airDensity(altitude: number, temperature: number): number {
  const p = 101325 * Math.pow(1 - 2.25577e-5 * altitude, 5.25588);
  return p / (287.05 * (temperature + 273.15));
}

function lerpTable(xs: number[], ys: number[], t: number[][], x: number, y: number): number {
  const idx = (a: number[], v: number) => {
    if (a.length < 2) return { i: 0, f: 0 };
    const c = Math.min(Math.max(v, a[0]!), a[a.length - 1]!);
    let i = 0;
    while (i < a.length - 2 && c > a[i + 1]!) i++;
    return { i, f: (c - a[i]!) / ((a[i + 1]! - a[i]!) || 1) };
  };
  const a = idx(xs, x), b = idx(ys, y);
  const v = (i: number, j: number) => t[Math.min(i, xs.length - 1)]?.[Math.min(j, ys.length - 1)] ?? 0;
  return (1 - a.f) * ((1 - b.f) * v(a.i, b.i) + b.f * v(a.i, b.i + 1)) + a.f * ((1 - b.f) * v(a.i + 1, b.i) + b.f * v(a.i + 1, b.i + 1));
}

/** Coefficients at ride heights (mm, in the model's convention). */
export function aeroCoefficients(m: AeroModel, rhF: number, rhR: number): { CdA: number; ClAf: number; ClAr: number } {
  if (!m.map) return { CdA: m.CdA, ClAf: m.ClAf, ClAr: m.ClAr };
  const k = m.map;
  return { CdA: lerpTable(k.rhFront, k.rhRear, k.CdA, rhF, rhR), ClAf: lerpTable(k.rhFront, k.rhRear, k.ClAf, rhF, rhR), ClAr: lerpTable(k.rhFront, k.rhRear, k.ClAr, rhF, rhR) };
}

/**
 * Aero forces, N: drag (rearward), lift at the front and rear axles (+ up). `rh` = absolute ride heights
 * (mm), `rh0` = the design ride heights (for maps in "change").
 */
export function aeroForces(a: AeroInput, rh: { front: number; rear: number }, rh0: { front: number; rear: number }): { drag: number; liftF: number; liftR: number } {
  const q = 0.5 * a.rho * a.speed * a.speed;
  if (!(q > 0)) return { drag: 0, liftF: 0, liftR: 0 };
  const m = a.model;
  const c = m.rideHeightRef === 'change' ? aeroCoefficients(m, rh.front - rh0.front, rh.rear - rh0.rear) : aeroCoefficients(m, rh.front, rh.rear);
  return { drag: q * c.CdA, liftF: q * c.ClAf, liftR: q * c.ClAr };
}

export interface AeroParse { model: AeroModel | null; warnings: string[]; errors: string[] }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) for (const key of Object.keys(o)) if (key.toLowerCase() === k.toLowerCase()) return o[key];
  return undefined;
};

/** Read aero characteristics (JSON constants / map, or a CSV grid). */
export function parseAero(text: string, name = 'aero'): AeroParse {
  const warnings: string[] = [];
  const errors: string[] = [];
  const t = text.trim();
  if (t.startsWith('{')) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(t) as Record<string, unknown>; } catch (e) { return { model: null, warnings, errors: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] }; }
    const split = (cla: number | undefined, bal: number | undefined): [number, number] | null => (cla !== undefined ? [cla * (bal ?? 0.45), cla * (1 - (bal ?? 0.45))] : null);
    const cla = num(pick(o, 'ClA')), bal = num(pick(o, 'balance'));
    const sp = split(cla, bal);
    const model: AeroModel = {
      name: typeof o.name === 'string' ? o.name : name,
      CdA: num(pick(o, 'CdA')) ?? 0,
      ClAf: num(pick(o, 'ClAf', 'ClA_front', 'ClAfront')) ?? sp?.[0] ?? 0,
      ClAr: num(pick(o, 'ClAr', 'ClA_rear', 'ClArear')) ?? sp?.[1] ?? 0,
      rideHeightRef: pick(o, 'rideHeightRef') === 'change' ? 'change' : 'absolute',
      dragHeight: num(pick(o, 'dragHeight')) ?? 400,
    };
    if (cla !== undefined && bal === undefined && num(pick(o, 'ClAf')) === undefined) warnings.push('ClA without a balance: 45 % of the downforce put on the front axle.');
    const mapRaw = pick(o, 'map');
    if (mapRaw && typeof mapRaw === 'object') {
      const mo = mapRaw as Record<string, unknown>;
      const arr = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : null);
      const tab = (v: unknown) => (Array.isArray(v) && v.every((r) => Array.isArray(r) && r.every((x) => typeof x === 'number')) ? (v as number[][]) : null);
      const rf = arr(pick(mo, 'rhFront')), rr = arr(pick(mo, 'rhRear'));
      const cd = tab(pick(mo, 'CdA')), cf = tab(pick(mo, 'ClAf')), cr = tab(pick(mo, 'ClAr'));
      if (!rf || !rr || !cd || !cf || !cr) errors.push('The map needs rhFront, rhRear (mm) and the CdA, ClAf, ClAr tables.');
      else if ([cd, cf, cr].some((tb) => tb.length !== rf.length || tb.some((row) => row.length !== rr.length))) errors.push(`Map tables must be ${rf.length} rows (front ride heights) × ${rr.length} columns (rear ride heights).`);
      else model.map = { rhFront: rf, rhRear: rr, CdA: cd, ClAf: cf, ClAr: cr };
    }
    if (!model.map && model.CdA === 0 && model.ClAf === 0 && model.ClAr === 0) errors.push('No aero values found (CdA, ClAf, ClAr or a map).');
    return { model: errors.length ? null : model, warnings, errors };
  }
  // CSV grid.
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const cells = (l: string) => l.split(/[,;\t]/).map((c) => c.trim());
  const head = cells(lines[0] ?? '').map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iF = col('rhf', 'rh_front', 'rhfront'), iR = col('rhr', 'rh_rear', 'rhrear'), iD = col('cda'), iLf = col('claf', 'cla_front'), iLr = col('clar', 'cla_rear');
  if ([iF, iR, iD, iLf, iLr].some((i) => i < 0)) return { model: null, warnings, errors: ['CSV needs the columns rhF, rhR, CdA, ClAf, ClAr.'] };
  const rows = lines.slice(1).map((l) => cells(l).map(Number)).filter((r) => [iF, iR, iD, iLf, iLr].every((i) => Number.isFinite(r[i])));
  const rf = [...new Set(rows.map((r) => r[iF]!))].sort((a, b) => a - b), rr = [...new Set(rows.map((r) => r[iR]!))].sort((a, b) => a - b);
  const grid = (i: number) => rf.map((f) => rr.map((r) => rows.find((x) => x[iF] === f && x[iR] === r)?.[i] ?? NaN));
  const map: AeroMap = { rhFront: rf, rhRear: rr, CdA: grid(iD), ClAf: grid(iLf), ClAr: grid(iLr) };
  if ([map.CdA, map.ClAf, map.ClAr].some((tb) => tb.some((row) => row.some((v) => !Number.isFinite(v))))) return { model: null, warnings, errors: [`The rows don't fill a ${rf.length} × ${rr.length} grid of front × rear ride heights.`] };
  warnings.push('CSV ride heights read as absolute (mm above the ground at the axle); drag height 400 mm.');
  return { model: { name, CdA: map.CdA[0]![0]!, ClAf: map.ClAf[0]![0]!, ClAr: map.ClAr[0]![0]!, map, rideHeightRef: 'absolute', dragHeight: 400 }, warnings, errors };
}
