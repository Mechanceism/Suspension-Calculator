/**
 * F29 (round 5): the setup's character — each axle's characteristics and adjustments set against the ranges that
 * are typical for each kind of driving, and how well the car as a whole matches each. A car optimized on rally and
 * autocross tests should land between those two.
 *
 * The reference ranges are typical published / workshop values, rounded and wide (a car of one kind can sit outside
 * one of its ranges and still be a good car of that kind); they are only a guide, and editable in the app.
 */

export type Style = 'track' | 'road' | 'offroad' | 'drift' | 'drag' | 'towing';
export const STYLES: Style[] = ['track', 'road', 'offroad', 'drift', 'drag', 'towing'];
export const STYLE_LABEL: Record<Style, string> = {
  track: 'Autocross / track', road: 'Road car', offroad: 'Rally / off-road', drift: 'Drift', drag: 'Drag', towing: 'Towing / utility',
};

/** A characteristic: per axle (front / rear) or for the car. */
export type CharKey =
  | 'staticCamber' | 'staticToe' | 'caster' | 'kpi' | 'camberGain' | 'rollCenter' | 'rideHeight' | 'rideFrequency'
  | 'rollShare' | 'antiDive' | 'antiSquat';
export type Where = 'front' | 'rear' | 'car';
export interface CharMeta { label: string; unit: string; digits: number; where: Where[]; hint: string }
export const CHAR_META: Record<CharKey, CharMeta> = {
  staticCamber: { label: 'Static camber', unit: '°', digits: 2, where: ['front', 'rear'], hint: 'At ride height (− = top in).' },
  staticToe: { label: 'Static toe', unit: '°', digits: 2, where: ['front', 'rear'], hint: 'Per wheel (+ = toe-in).' },
  caster: { label: 'Caster', unit: '°', digits: 1, where: ['front'], hint: 'Steered axle.' },
  kpi: { label: 'KPI', unit: '°', digits: 1, where: ['front'], hint: 'Kingpin inclination, steered axle.' },
  camberGain: { label: 'Camber gain', unit: '°/100 mm', digits: 2, where: ['front', 'rear'], hint: 'Camber change per 100 mm of bump (− = top in).' },
  rollCenter: { label: 'Roll center height', unit: 'mm', digits: 0, where: ['front', 'rear'], hint: 'Static, above the ground.' },
  rideHeight: { label: 'Ride height', unit: 'mm', digits: 0, where: ['front', 'rear'], hint: 'Ground clearance under the body at rest (the axle\'s static ride height).' },
  rideFrequency: { label: 'Ride frequency', unit: 'Hz', digits: 2, where: ['front', 'rear'], hint: 'The axle\'s natural heave frequency: √(wheel rate with the tire ÷ sprung mass on the wheel) / 2π. Soft road cars ≈ 1–1.5 Hz, race cars 2–4 Hz.' },
  rollShare: { label: 'Front roll stiffness share', unit: '%', digits: 0, where: ['car'], hint: 'Above ~50 % the car tends to understeer.' },
  antiDive: { label: 'Anti-dive', unit: '%', digits: 0, where: ['car'], hint: 'Front, braking.' },
  antiSquat: { label: 'Anti-squat', unit: '%', digits: 0, where: ['car'], hint: 'Rear, accelerating.' },
};
export const CHAR_KEYS = Object.keys(CHAR_META) as CharKey[];

/** A row: a characteristic at one place (`front.caster`, `car.antiSquat`). */
export type RowKey = `${Where}.${CharKey}`;
export const ROW_KEYS: RowKey[] = CHAR_KEYS.flatMap((k) => CHAR_META[k].where.map((w) => `${w}.${k}` as RowKey));
export type Range = [number, number];
export type References = Record<Style, Partial<Record<RowKey, Range>>>;

/**
 * Typical ranges (rounded; sources: suspension / chassis setup handbooks — Milliken RCVD, Staniforth, Smith's
 * *Tune to Win*, FSAE design reports, manufacturer alignment tables and rally / drift / drag setup guides).
 */
export const DEFAULT_REFERENCES: References = {
  track: {
    'front.staticCamber': [-3.5, -1.5], 'rear.staticCamber': [-2.5, -1], 'front.staticToe': [-0.15, 0], 'rear.staticToe': [0, 0.15],
    'front.caster': [5, 9], 'front.kpi': [3, 10], 'front.camberGain': [-6, -2.5], 'rear.camberGain': [-5, -2],
    'front.rollCenter': [0, 70], 'rear.rollCenter': [10, 90], 'front.rideHeight': [30, 110], 'rear.rideHeight': [30, 120],
    'front.rideFrequency': [2, 3.5], 'rear.rideFrequency': [2, 3.6], 'car.rollShare': [45, 58], 'car.antiDive': [0, 30], 'car.antiSquat': [10, 50],
  },
  road: {
    'front.staticCamber': [-1, 0.2], 'rear.staticCamber': [-1.5, 0], 'front.staticToe': [0, 0.15], 'rear.staticToe': [0.05, 0.25],
    'front.caster': [3, 7.5], 'front.kpi': [8, 15], 'front.camberGain': [-3, -0.5], 'rear.camberGain': [-3, -0.5],
    'front.rollCenter': [20, 110], 'rear.rollCenter': [50, 160], 'front.rideHeight': [110, 170], 'rear.rideHeight': [110, 180],
    'front.rideFrequency': [1, 1.5], 'rear.rideFrequency': [1.1, 1.7], 'car.rollShare': [55, 72], 'car.antiDive': [10, 40], 'car.antiSquat': [15, 60],
  },
  offroad: {
    'front.staticCamber': [-1.5, 0.5], 'rear.staticCamber': [-1, 0.5], 'front.staticToe': [-0.1, 0.15], 'rear.staticToe': [0, 0.2],
    'front.caster': [4, 9], 'front.kpi': [6, 14], 'front.camberGain': [-3, 0], 'rear.camberGain': [-2.5, 0],
    'front.rollCenter': [60, 300], 'rear.rollCenter': [80, 400], 'front.rideHeight': [150, 380], 'rear.rideHeight': [150, 400],
    'front.rideFrequency': [0.8, 1.6], 'rear.rideFrequency': [0.9, 1.7], 'car.rollShare': [48, 62], 'car.antiDive': [5, 40], 'car.antiSquat': [20, 70],
  },
  drift: {
    'front.staticCamber': [-5, -2], 'rear.staticCamber': [-1.5, 0], 'front.staticToe': [-0.3, 0], 'rear.staticToe': [-0.05, 0.15],
    'front.caster': [6.5, 12], 'front.kpi': [4, 12], 'front.camberGain': [-5, -1.5], 'rear.camberGain': [-3, -0.5],
    'front.rollCenter': [0, 80], 'rear.rollCenter': [20, 120], 'front.rideHeight': [70, 130], 'rear.rideHeight': [70, 140],
    'front.rideFrequency': [1.6, 3], 'rear.rideFrequency': [1.4, 2.8], 'car.rollShare': [38, 52], 'car.antiDive': [0, 30], 'car.antiSquat': [20, 70],
  },
  drag: {
    'front.staticCamber': [-0.5, 0.5], 'rear.staticCamber': [-0.25, 0.25], 'front.staticToe': [0, 0.1], 'rear.staticToe': [-0.05, 0.05],
    'front.caster': [4, 10], 'front.kpi': [6, 14], 'front.camberGain': [-2, 0], 'rear.camberGain': [-1, 0],
    'front.rollCenter': [40, 160], 'rear.rollCenter': [60, 250], 'front.rideHeight': [90, 160], 'rear.rideHeight': [90, 160],
    'front.rideFrequency': [1, 1.8], 'rear.rideFrequency': [1, 1.8], 'car.rollShare': [40, 65], 'car.antiDive': [0, 30], 'car.antiSquat': [80, 140],
  },
  towing: {
    'front.staticCamber': [-0.75, 0.5], 'rear.staticCamber': [-0.5, 0.5], 'front.staticToe': [0, 0.15], 'rear.staticToe': [0, 0.15],
    'front.caster': [3.5, 7], 'front.kpi': [8, 15], 'front.camberGain': [-2.5, 0], 'rear.camberGain': [-1.5, 0],
    'front.rollCenter': [40, 160], 'rear.rollCenter': [80, 350], 'front.rideHeight': [150, 260], 'rear.rideHeight': [150, 280],
    'front.rideFrequency': [1.1, 1.6], 'rear.rideFrequency': [1.3, 2], 'car.rollShare': [55, 70], 'car.antiDive': [10, 40], 'car.antiSquat': [20, 70],
  },
};

/** How far a value is outside a range, in range-widths: 0 inside, 1 a whole width outside. */
export function outside(v: number, [lo, hi]: Range): number {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  const span = Math.max(b - a, 1e-9);
  return v < a ? (a - v) / span : v > b ? (v - b) / span : 0;
}
/**
 * A row's match: 100 % at the middle of the range, 50 % at its ends, 0 a whole range-width from the middle.
 * (Scored from the middle, not just inside / outside: the kinds' ranges overlap — a track car sits inside most
 * of the drift ranges too — so 100 % anywhere inside couldn't tell them apart.)
 */
export function rowMatch(v: number, [lo, hi]: Range): number {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  return Math.max(0, 1 - Math.abs(v - (a + b) / 2) / Math.max(b - a, 1e-9));
}

export interface StyleMatch { style: Style; front: number | null; rear: number | null; car: number | null; overall: number | null; rows: number }

/**
 * Per style: the mean match of the front rows, the rear rows, the car rows, and overall (all rows); null where
 * there is nothing to compare. Values missing (not steered, no model) leave their rows out.
 */
export function styleMatches(values: Partial<Record<RowKey, number | null>>, refs: References = DEFAULT_REFERENCES): StyleMatch[] {
  return STYLES.map((style) => {
    const parts: Record<Where, number[]> = { front: [], rear: [], car: [] };
    for (const k of ROW_KEYS) {
      const v = values[k], r = refs[style][k];
      if (v === null || v === undefined || !Number.isFinite(v) || !r) continue;
      parts[k.split('.')[0] as Where].push(rowMatch(v, r));
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const all = [...parts.front, ...parts.rear, ...parts.car];
    return { style, front: mean(parts.front), rear: mean(parts.rear), car: mean(parts.car), overall: mean(all), rows: all.length };
  });
}

/** A sentence: the closest style, and whether the car sits between two (both within 10 points of the best). */
export function characterSummary(m: StyleMatch[]): string {
  const ranked = m.filter((x) => x.overall !== null).sort((a, b) => b.overall! - a.overall!);
  if (!ranked.length) return 'Nothing to compare.';
  const [a, b] = ranked;
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  if (b && a.overall! - b.overall! <= 0.1) return `Between ${STYLE_LABEL[a.style].toLowerCase()} (${pct(a.overall!)}) and ${STYLE_LABEL[b.style].toLowerCase()} (${pct(b.overall!)}).`;
  return `Closest to ${STYLE_LABEL[a.style].toLowerCase()} (${pct(a.overall!)})${b ? `; next ${STYLE_LABEL[b.style].toLowerCase()} (${pct(b.overall!)})` : ''}.`;
}
