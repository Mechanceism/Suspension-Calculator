/**
 * Unit-aware value entry (GOALS.md § Units).
 *
 * A value with no unit uses the default unit for its quantity (`1` → 1 mm). A value with a unit
 * suffix is converted to base units (`5in` → 127 mm). Simple sums are allowed: `5in + 3mm`,
 * `1ft 2in`, `-12.5`. The original text is kept for display; only the base value is used in math.
 */

export type Quantity = 'length' | 'angle';

/** Factors to base units: length → mm, angle → degrees. */
export const UNITS: Record<Quantity, Record<string, number>> = {
  length: { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8, "'": 304.8 },
  angle: { deg: 1, '°': 1, rad: 180 / Math.PI },
};

export const DEFAULT_UNIT: Record<Quantity, string> = { length: 'mm', angle: 'deg' };

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

const TERM = /([+-]?)\s*(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?\s*([a-zA-Z°"']*)/y;

/** Parse text like `5in + 3mm` into base units for `quantity`. */
export function parseValue(text: string, quantity: Quantity, defaultUnit = DEFAULT_UNIT[quantity]): ParseResult {
  const units = UNITS[quantity];
  const src = text.trim();
  if (!src) return { ok: false, error: 'Empty value' };
  if (!(defaultUnit in units)) return { ok: false, error: `Unknown default unit "${defaultUnit}"` };
  let pos = 0;
  let total = 0;
  let terms = 0;
  while (pos < src.length) {
    while (src[pos] === ' ') pos++;
    if (pos >= src.length) break;
    TERM.lastIndex = pos;
    const m = TERM.exec(src);
    if (!m || m[0].trim() === '') return { ok: false, error: `Cannot read "${src.slice(pos)}"` };
    // After the first term, a sign or whitespace must separate terms (handled by the regex).
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
