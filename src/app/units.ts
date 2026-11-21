/**
 * Display units. The math always runs in base units (mm, kg, N, kPa, N/mm, N·m, °C, °, m); this
 * module only changes what is shown and how plain numbers typed into inputs are read.
 *
 *  - Metric / Imperial presets, or Custom (a unit per quantity).
 *  - A value shown in the UI is identified by its base unit string ('mm', 'N/mm', '°/mm', 'kPa'…).
 *    Compound units (a/b) convert both parts, so N/mm becomes lbf/in and °/mm becomes °/in.
 *  - Typed text with an explicit unit ("5in") is kept as typed, as before.
 * The choice is a viewer preference (saved in this browser), not part of the project file.
 */
import { create } from 'zustand';

export type UnitSystem = 'metric' | 'imperial' | 'custom';
export type DisplayQuantity = 'length' | 'mass' | 'force' | 'pressure' | 'torque' | 'temperature' | 'angle' | 'altitude' | 'area';

interface UnitDef { label: string; /** Size of one unit in base units. */ factor: number; offset?: number }

/** Options per quantity (base unit first). */
export const DISPLAY_UNITS: Record<DisplayQuantity, Record<string, UnitDef>> = {
  length: { mm: { label: 'mm', factor: 1 }, cm: { label: 'cm', factor: 10 }, m: { label: 'm', factor: 1000 }, in: { label: 'in', factor: 25.4 }, ft: { label: 'ft', factor: 304.8 }, yd: { label: 'yd', factor: 914.4 } },
  mass: { kg: { label: 'kg', factor: 1 }, g: { label: 'g', factor: 0.001 }, lb: { label: 'lb', factor: 0.45359237 }, oz: { label: 'oz', factor: 0.028349523125 } },
  force: { N: { label: 'N', factor: 1 }, kN: { label: 'kN', factor: 1000 }, lbf: { label: 'lbf', factor: 4.4482216153 }, kgf: { label: 'kgf', factor: 9.80665 } },
  pressure: { kPa: { label: 'kPa', factor: 1 }, bar: { label: 'bar', factor: 100 }, psi: { label: 'psi', factor: 6.894757293 } },
  torque: { 'N·m': { label: 'N·m', factor: 1 }, 'lbf·ft': { label: 'lbf·ft', factor: 1.3558179483 }, 'lbf·in': { label: 'lbf·in', factor: 0.1129848290 } },
  temperature: { '°C': { label: '°C', factor: 1 }, '°F': { label: '°F', factor: 5 / 9, offset: -32 } },
  angle: { '°': { label: '°', factor: 1 }, rad: { label: 'rad', factor: 180 / Math.PI } },
  altitude: { m: { label: 'm', factor: 1 }, ft: { label: 'ft', factor: 0.3048 } },
  area: { 'mm²': { label: 'mm²', factor: 1 }, 'cm²': { label: 'cm²', factor: 100 }, 'in²': { label: 'in²', factor: 645.16 } },
};

export const QUANTITY_LABELS: Record<DisplayQuantity, string> = {
  length: 'Length', mass: 'Mass', force: 'Force', pressure: 'Pressure', torque: 'Torque', temperature: 'Temperature',
  angle: 'Angle', altitude: 'Altitude', area: 'Area',
};

export const PRESETS: Record<'metric' | 'imperial', Record<DisplayQuantity, string>> = {
  metric: { length: 'mm', mass: 'kg', force: 'N', pressure: 'kPa', torque: 'N·m', temperature: '°C', angle: '°', altitude: 'm', area: 'cm²' },
  imperial: { length: 'in', mass: 'lb', force: 'lbf', pressure: 'psi', torque: 'lbf·ft', temperature: '°F', angle: '°', altitude: 'ft', area: 'in²' },
};

/** Base unit strings used in the UI → quantity and size in that quantity's base unit. */
const BASE: Record<string, { q: DisplayQuantity; size: number }> = {
  mm: { q: 'length', size: 1 },
  'mm²': { q: 'area', size: 1 },
  'cm²': { q: 'area', size: 100 },
  kg: { q: 'mass', size: 1 },
  N: { q: 'force', size: 1 },
  kPa: { q: 'pressure', size: 1 },
  'N·m': { q: 'torque', size: 1 },
  '°C': { q: 'temperature', size: 1 },
  '°': { q: 'angle', size: 1 },
  deg: { q: 'angle', size: 1 },
  m: { q: 'altitude', size: 1 },
};
/** Compound units: numerator / denominator (each a BASE unit). Torsion is torque per angle. */
const COMPOUND: Record<string, [string, string]> = {
  'N/mm': ['N', 'mm'], '°/mm': ['°', 'mm'], 'mm/rev': ['mm', ''], 'Nm/deg': ['N·m', '°'], 'N·m/deg': ['N·m', '°'],
};

export interface UnitPrefs { system: UnitSystem; custom: Record<DisplayQuantity, string> }

const STORAGE_KEY = 'suspension-calculator.units';
function loadPrefs(): UnitPrefs {
  const fallback: UnitPrefs = { system: 'metric', custom: { ...PRESETS.metric } };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<UnitPrefs>;
    const custom = { ...PRESETS.metric };
    for (const q of Object.keys(custom) as DisplayQuantity[]) {
      const u = p.custom?.[q];
      if (u && DISPLAY_UNITS[q][u]) custom[q] = u;
    }
    return { system: p.system === 'imperial' || p.system === 'custom' ? p.system : 'metric', custom };
  } catch { return fallback; }
}

export const useUnits = create<UnitPrefs & { setSystem(s: UnitSystem): void; setCustom(q: DisplayQuantity, u: string): void }>((set, get) => ({
  ...loadPrefs(),
  setSystem: (system) => { set({ system }); save(get()); },
  setCustom: (q, u) => { set({ system: 'custom', custom: { ...get().custom, [q]: u } }); save(get()); },
}));
function save(p: UnitPrefs) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ system: p.system, custom: p.custom })); } catch { /* private mode etc. */ }
}

export const activeUnits = (p: UnitPrefs): Record<DisplayQuantity, string> => (p.system === 'custom' ? p.custom : PRESETS[p.system]);

/** A conversion from a base unit string to the display unit: v_display = (v + pre)·scale + post. */
export interface Conversion { unit: string; scale: number; offset: number; identity: boolean }

const IDENTITY = (unit: string): Conversion => ({ unit, scale: 1, offset: 0, identity: true });

export function conversionFor(baseUnit: string, units: Record<DisplayQuantity, string>): Conversion {
  const simple = BASE[baseUnit];
  if (simple) {
    const target = units[simple.q];
    const def = DISPLAY_UNITS[simple.q][target]!;
    if (simple.q === 'temperature') {
      // °F = °C·9/5 + 32
      return def.offset ? { unit: def.label, scale: 1 / def.factor, offset: -def.offset, identity: false } : IDENTITY(baseUnit);
    }
    const scale = simple.size / def.factor;
    return scale === 1 && def.label === baseUnit ? IDENTITY(baseUnit) : { unit: def.label, scale, offset: 0, identity: false };
  }
  const c = COMPOUND[baseUnit];
  if (c) {
    const [num, den] = c;
    const n = conversionFor(num, units);
    if (!den) return n.identity ? IDENTITY(baseUnit) : { unit: `${n.unit}/rev`, scale: n.scale, offset: 0, identity: false };
    const d = conversionFor(den, units);
    if (n.identity && d.identity) return IDENTITY(baseUnit);
    // value per base denominator → per display denominator: divide by d.scale.
    return { unit: `${n.unit}/${d.unit}`, scale: n.scale / d.scale, offset: 0, identity: false };
  }
  return IDENTITY(baseUnit);
}

/** Decimal places shown after a conversion, starting from `digits` in base units. */
export const digitsFor = (digits: number, c: Conversion) =>
  (c.identity ? digits : Math.max(0, Math.min(6, digits + Math.round(-Math.log10(Math.abs(c.scale) || 1)))));

export const toDisplay = (v: number, c: Conversion) => v * c.scale + c.offset;
export const fromDisplay = (v: number, c: Conversion) => (v - c.offset) / c.scale;

/** Re-express a formatted base-unit number ("12.50") in display units, keeping comparable precision. */
export function convertText(text: string, c: Conversion): string {
  if (c.identity) return text;
  const t = text.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return text; // —, ∞, ranges etc. pass through
  const decimals = t.includes('.') ? t.split('.')[1]!.length : 0;
  const s = toDisplay(Number(t), c).toFixed(digitsFor(decimals, c));
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** Is this typed text just numbers (no unit)? Then it is read in the display unit. */
export const isPlainNumber = (text: string) => /^[\s\d.+\-eE]+$/.test(text) && /\d/.test(text);

/** Hook: the conversion for a base unit string with the current preferences. */
export function useConversion(baseUnit: string): Conversion {
  const units = useUnits((s) => activeUnits(s));
  return conversionFor(baseUnit, units);
}

/** Hook returning a converter for many units (readouts, labels). */
export function useDisplay() {
  const system = useUnits((s) => s.system);
  const custom = useUnits((s) => s.custom);
  const units = system === 'custom' ? custom : PRESETS[system];
  return {
    units,
    conv: (baseUnit: string) => conversionFor(baseUnit, units),
    /** "12.50" + "mm" → { text: "0.492", unit: "in" } */
    text: (text: string, baseUnit: string) => { const c = conversionFor(baseUnit, units); return { text: convertText(text, c), unit: c.unit }; },
    /** Number → "0.492 in" */
    format: (v: number, baseUnit: string, digits = 2) => {
      const c = conversionFor(baseUnit, units);
      if (!Number.isFinite(v)) return `${Number.isNaN(v) ? '—' : '∞'} ${c.unit}`;
      return `${toDisplay(v, c).toFixed(digitsFor(digits, c))} ${c.unit}`;
    },
  };
}
