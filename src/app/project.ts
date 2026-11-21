/**
 * Project files: save / open / import / export a layout.
 *
 * Every file records `formatVersion` (the file layout) and `appVersion` (the app that wrote it).
 * On import, older files are upgraded step by step through MIGRATIONS; unknown or missing values
 * fall back to defaults and are reported as warnings, so files keep opening as variables change.
 *
 * Hardpoints and wheel scalars are keyed by their parameter names (FL_UCA_Fwd, FL_Whl_Camber…), the
 * same names planned for CAD parameters. Each value keeps the text the user typed ("5in") and its
 * base-unit value.
 */
import pkg from '../../package.json';
import { parseValue, type Quantity } from '../core/units/units';
import {
  defaultDesign, POINT_KEYS, POINT_NAMES, SCALAR_KEYS, SCALAR_META, SPRING_KEYS, SPRING_META,
  DAMPER_KEYS, DAMPER_META, STEER_KEYS, STEER_META, TIRE_KEYS, TIRE_META,
  type DesignState, type Field, type TireModelKind,
} from './store';

export const FILE_FORMAT = 'suspension-calculator-project';
export const FORMAT_VERSION = 1;
export const APP_VERSION: string = pkg.version;

type FieldJson = { text: string; value: number };

export interface ProjectFile {
  format: typeof FILE_FORMAT;
  formatVersion: number;
  appVersion: string;
  name: string;
  savedAt: string;
  /** Base units the `value`s are stored in. */
  units: Record<'length' | 'angle' | 'force' | 'pressure' | 'mass' | 'rate', string>;
  corner: {
    id: 'FL';
    type: 'doubleWishbone';
    points: Record<string, { x: FieldJson; y: FieldJson; z: FieldJson }>;
    scalars: Record<string, FieldJson>;
    damperArm: 'lca' | 'uca';
  };
  spring: Record<string, FieldJson>;
  damper: { fields: Record<string, FieldJson>; bumpStop: boolean };
  steering: Record<string, FieldJson>;
  tire: { model: TireModelKind; volumeChange: boolean; sizeText: string; fields: Record<string, FieldJson> };
  motion: { droop: number; bump: number; driver: DesignState['driver'] };
  presetId?: string;
}

const fj = (f: Field): FieldJson => ({ text: f.text, value: f.value });
const mapFields = <K extends string>(keys: readonly K[], rec: Record<K, Field>) =>
  Object.fromEntries(keys.map((k) => [k, fj(rec[k])])) as Record<string, FieldJson>;

export function serializeProject(d: DesignState, name: string): ProjectFile {
  return {
    format: FILE_FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: APP_VERSION,
    name,
    savedAt: new Date().toISOString(),
    units: { length: 'mm', angle: 'deg', force: 'N', pressure: 'kPa', mass: 'kg', rate: 'N/mm' },
    corner: {
      id: 'FL',
      type: 'doubleWishbone',
      points: Object.fromEntries(POINT_KEYS.map((k) => {
        const [x, y, z] = d.geom.points[k];
        return [POINT_NAMES[k], { x: fj(x), y: fj(y), z: fj(z) }];
      })),
      scalars: Object.fromEntries(SCALAR_KEYS.map((k) => [SCALAR_META[k].name, fj(d.geom.scalars[k])])),
      damperArm: d.geom.damperArm,
    },
    spring: mapFields(SPRING_KEYS, d.spring),
    damper: { fields: mapFields(DAMPER_KEYS, d.damper), bumpStop: d.bumpStop },
    steering: mapFields(STEER_KEYS, d.steer),
    tire: { model: d.tireModel, volumeChange: d.volumeChange, sizeText: d.tireSizeText, fields: mapFields(TIRE_KEYS, d.tire) },
    motion: { droop: d.droop, bump: d.bump, driver: d.driver },
    presetId: d.presetId,
  };
}

/** The design part of a file, for "unsaved changes" comparison (no name or timestamp). */
export function designSnapshot(d: DesignState): string {
  const f = serializeProject(d, '');
  return JSON.stringify({ ...f, name: undefined, savedAt: undefined, appVersion: undefined });
}

/**
 * Upgrades from formatVersion N to N + 1. Add one entry whenever the file layout changes, e.g.
 *   1: (f) => ({ ...f, formatVersion: 2, corner: { ...f.corner, newThing: default } }),
 */
const MIGRATIONS: Record<number, (f: Record<string, unknown>) => Record<string, unknown>> = {};

export interface ImportResult {
  design: DesignState;
  name: string;
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read one saved value: re-parse its text (keeps "5in" exact), else use the stored number, else the default. */
function readField(raw: unknown, quantity: Quantity, fallback: Field, where: string, warnings: string[]): Field {
  if (!isObj(raw)) {
    warnings.push(`${where}: missing, using default ${fallback.text}`);
    return fallback;
  }
  const text = typeof raw.text === 'string' ? raw.text : undefined;
  const stored = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : undefined;
  if (text !== undefined) {
    const r = parseValue(text, quantity);
    // The text is rounded for display; keep the full-precision stored value unless the text was
    // edited to mean something else (e.g. a hand-edited file).
    if (r.ok) return { text, value: stored !== undefined && Math.abs(r.value - stored) <= 1e-3 + 1e-4 * Math.abs(stored) ? stored : r.value };
  }
  if (stored !== undefined) return { text: text ?? String(stored), value: stored };
  warnings.push(`${where}: unreadable, using default ${fallback.text}`);
  return fallback;
}

function readRecord<K extends string>(
  raw: unknown, keys: readonly K[], quantity: (k: K) => Quantity, defaults: Record<K, Field>, section: string, warnings: string[],
): Record<K, Field> {
  const obj = isObj(raw) ? raw : {};
  const known = new Set<string>(keys);
  for (const k of Object.keys(obj)) if (!known.has(k)) warnings.push(`${section}.${k}: not used by this version, ignored`);
  return Object.fromEntries(keys.map((k) => [k, readField(obj[k], quantity(k), defaults[k], `${section}.${k}`, warnings)])) as Record<K, Field>;
}

export function importProject(data: unknown): ImportResult {
  if (!isObj(data) || data.format !== FILE_FORMAT) throw new Error('Not a Suspension Calculator project file');
  const warnings: string[] = [];
  let f: Record<string, unknown> = data;
  let v = typeof f.formatVersion === 'number' ? f.formatVersion : 1;
  if (v > FORMAT_VERSION) {
    warnings.push(`Saved by a newer version (file format ${v}, app ${String(f.appVersion ?? '?')}); values this version doesn't know are ignored.`);
  }
  while (v < FORMAT_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`Can't upgrade file format ${v}`);
    f = step(f);
    v += 1;
    warnings.push(`Upgraded from file format ${v - 1} to ${v}.`);
  }

  const def = defaultDesign();
  const corner = isObj(f.corner) ? f.corner : {};
  const pts = isObj(corner.points) ? corner.points : {};
  const points = { ...def.geom.points };
  for (const k of POINT_KEYS) {
    const p = pts[POINT_NAMES[k]];
    const obj = isObj(p) ? p : {};
    if (!isObj(p)) warnings.push(`${POINT_NAMES[k]}: missing, using default`);
    points[k] = (['x', 'y', 'z'] as const).map((ax, i) =>
      readField(obj[ax], 'length', def.geom.points[k][i]!, `${POINT_NAMES[k]}.${ax}`, isObj(p) ? warnings : [])) as [Field, Field, Field];
  }
  const sc = isObj(corner.scalars) ? corner.scalars : {};
  const scalars = Object.fromEntries(SCALAR_KEYS.map((k) =>
    [k, readField(sc[SCALAR_META[k].name], SCALAR_META[k].quantity, def.geom.scalars[k], SCALAR_META[k].name, warnings)])) as DesignState['geom']['scalars'];
  const damperArm = corner.damperArm === 'uca' ? 'uca' : 'lca';

  const damperRaw = isObj(f.damper) ? f.damper : {};
  const tireRaw = isObj(f.tire) ? f.tire : {};
  const motion = isObj(f.motion) ? f.motion : {};
  const model = tireRaw.model === 'rigid' || tireRaw.model === 'stiffness' || tireRaw.model === 'gas' ? tireRaw.model : def.tireModel;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d);

  const design: DesignState = {
    presetId: typeof f.presetId === 'string' ? f.presetId : 'custom',
    geom: { points, scalars, damperArm },
    spring: readRecord(f.spring, SPRING_KEYS, (k) => SPRING_META[k].quantity, def.spring, 'spring', warnings),
    damper: readRecord(damperRaw.fields, DAMPER_KEYS, (k) => DAMPER_META[k].quantity, def.damper, 'damper', warnings),
    bumpStop: typeof damperRaw.bumpStop === 'boolean' ? damperRaw.bumpStop : def.bumpStop,
    steer: readRecord(f.steering, STEER_KEYS, (k) => STEER_META[k].quantity, def.steer, 'steering', warnings),
    tireModel: model,
    tire: readRecord(tireRaw.fields, TIRE_KEYS, (k) => TIRE_META[k].quantity, def.tire, 'tire', warnings),
    volumeChange: typeof tireRaw.volumeChange === 'boolean' ? tireRaw.volumeChange : def.volumeChange,
    tireSizeText: typeof tireRaw.sizeText === 'string' ? tireRaw.sizeText : '',
    droop: num(motion.droop, def.droop),
    bump: num(motion.bump, def.bump),
    driver: motion.driver === 'contactPatch' ? 'contactPatch' : 'wheelCenter',
  };
  return { design, name: typeof f.name === 'string' && f.name ? f.name : 'Imported layout', warnings };
}
