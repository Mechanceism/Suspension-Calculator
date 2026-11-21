/**
 * Unit-aware value entry (GOALS.md § Units).
 *
 * A value with no unit uses the default unit for its quantity (`1` → 1 mm). A value with a unit
 * suffix is converted to base units (`5in` → 127 mm). Simple sums are allowed: `5in + 3mm`,
 * `1ft 2in`, `-12.5`. The original text is kept for display; only the base value is used in math.
 */

export type Quantity = 'length' | 'angle' | 'pressure' | 'force' | 'rate' | 'altitude' | 'ratio' | 'temperature';

/**
 * Factors to base units: length → mm, angle → deg, pressure → kPa, force → N, rate → N/mm,
 * altitude → m, ratio → plain number. Temperature (→ °C) has offsets and is handled separately.
 */
export const UNITS: Record<Quantity, Record<string, number>> = {
  length: { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8, "'": 304.8 },
  angle: { deg: 1, '°': 1, rad: 180 / Math.PI },
  pressure: { kPa: 1, psi: 6.894757, bar: 100, Pa: 0.001, MPa: 1000 },
  force: { N: 1, kN: 1000, lbf: 4.4482216, kgf: 9.80665 },
  rate: { 'N/mm': 1, 'kN/m': 1, 'lbf/in': 0.17512684 },
  altitude: { m: 1, km: 1000, ft: 0.3048 },
  ratio: { x: 1, '%': 0.01 },
  temperature: { C: 1 },
};

export const DEFAULT_UNIT: Record<Quantity, string> = {
  length: 'mm', angle: 'deg', pressure: 'kPa', force: 'N', rate: 'N/mm', altitude: 'm', ratio: 'x', temperature: 'C',
};

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

const TERM = /([+-]?)\s*(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?\s*([a-zA-Z°"'/%]*)/y;
const TEMPERATURE = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(°?[CFK])?\s*$/i;

function parseTemperature(src: string): ParseResult {
  const m = TEMPERATURE.exec(src);
  if (!m) return { ok: false, error: 'Use a temperature like 20, 68F or 293K' };
  const v = Number(m[1]);
  const u = (m[2] ?? 'C').replace('°', '').toUpperCase();
  return { ok: true, value: u === 'F' ? ((v - 32) * 5) / 9 : u === 'K' ? v - 273.15 : v };
}

/** Parse text like `5in + 3mm` into base units for `quantity`. */
export function parseValue(text: string, quantity: Quantity, defaultUnit = DEFAULT_UNIT[quantity]): ParseResult {
  const units = UNITS[quantity];
  const src = text.trim();
  if (!src) return { ok: false, error: 'Empty value' };
  if (quantity === 'temperature') return parseTemperature(src);
  if (!(defaultUnit in units)) return { ok: false, error: `Unknown default unit "${defaultUnit}"` };
  let pos = 0;
  let total = 0;
  let terms = 0;
  let prevHadUnit = false;
  while (pos < src.length) {
    while (src[pos] === ' ') pos++;
    if (pos >= src.length) break;
    TERM.lastIndex = pos;
    const m = TERM.exec(src);
    if (!m || m[0].trim() === '') return { ok: false, error: `Cannot read "${src.slice(pos)}"` };
    // A term without + / − is only allowed as a compound unit, e.g. "1ft 2in" (both have units).
    if (terms > 0 && !m[1] && !(prevHadUnit && m[4])) {
      return { ok: false, error: `Use + or − between values ("${src.slice(pos)}")` };
    }
    prevHadUnit = Boolean(m[4]);
    const sign = m[1] === '-' ? -1 : 1;
    const num = parseFloat(m[2]! + (m[3] ? `e${m[3]}` : ''));
    const unit = m[4] || defaultUnit;
    const factor = units[unit];
    if (factor === undefined) return { ok: false, error: `Unknown ${quantity} unit "${unit}"` };
    total += sign * num * factor;
    terms++;
    pos = TERM.lastIndex;
  }
  return terms > 0 ? { ok: true, value: total } : { ok: false, error: 'No value' };
}

/** Format a base-unit value in `unit` for display. */
export function formatValue(value: number, quantity: Quantity, unit = DEFAULT_UNIT[quantity], digits = 3): string {
  const factor = UNITS[quantity][unit] ?? 1;
  const v = value / factor;
  return `${Number(v.toFixed(digits))}${unit === DEFAULT_UNIT[quantity] ? '' : unit}`;
}
