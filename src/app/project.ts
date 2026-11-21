/**
 * Project files: save / open / import / export a layout.
 *
 * Every file records `formatVersion` (the file layout) and `appVersion` (the app that wrote it).
 * On import, older files are upgraded step by step through MIGRATIONS; unknown or missing values
 * fall back to defaults and are reported as warnings, so files keep opening as variables change.
 *
 * Hardpoints and wheel scalars are keyed by their parameter names (FL_UCA_Fwd, RR_Whl_Camber…), the
 * same names planned for CAD parameters. Each value keeps the text the user typed ("5in") and its
 * base-unit value.
 *
 * Format history
 *   1  single corner (FL)
 *   2  four corners + links + per-corner settings + vehicle inputs (L6)
 *   3  brakes per corner, brake bias, shared components per axle (anti-roll bar, heave spring)
 */
import pkg from '../../package.json';
import { parseValue, type Quantity } from '../core/units/units';
import { CORNER_IDS, type CornerId } from '../core/vehicle/vehicle';
import {
  defaultDesign, mergedCorners, rootOf, POINT_KEYS, POINT_NAMES, SCALAR_KEYS, SCALAR_META, SPRING_KEYS, SPRING_META,
  DAMPER_KEYS, DAMPER_META, STEER_KEYS, STEER_META, TIRE_KEYS, TIRE_META, VEHICLE_KEYS, VEHICLE_META,
  DEFAULT_LINKS, DEFAULT_SETTINGS, SHARED_META, defaultShared,
  type DesignState, type CornerDesign, type Field, type CornerLinks, type CornerSettings, type SharedDesign, type Axle,
} from './store';

export const FILE_FORMAT = 'suspension-calculator-project';
export const FORMAT_VERSION = 3;
export const APP_VERSION: string = pkg.version;

type FieldJson = { text: string; value: number };
type Json = Record<string, unknown>;

/** Parameter name for a corner: FL_UCA_Fwd → RR_UCA_Fwd. */
export const cornerParam = (id: CornerId, flName: string) => flName.replace(/^FL_/, `${id}_`);

export interface CornerJson {
  type: 'doubleWishbone';
  points: Record<string, { x: FieldJson; y: FieldJson; z: FieldJson }>;
  scalars: Record<string, FieldJson>;
  damperArm: 'lca' | 'uca';
  spring: Record<string, FieldJson>;
  damper: { fields: Record<string, FieldJson>; bumpStop: boolean };
  tire: { model: DesignState['tireModel']; volumeChange: boolean; sizeText: string; fields: Record<string, FieldJson> };
}

export interface ProjectFile {
  format: typeof FILE_FORMAT;
  formatVersion: number;
  appVersion: string;
  name: string;
  savedAt: string;
  /** Base units the `value`s are stored in. */
  units: Record<'length' | 'angle' | 'force' | 'pressure' | 'mass' | 'rate', string>;
  corners: Record<CornerId, CornerJson>;
  links: CornerLinks;
  settings: Record<CornerId, CornerSettings>;
  activeCorner: CornerId;
  vehicle: { fields: Record<string, FieldJson>; autoPreload: boolean; cornerLoadMode: 'vehicle' | 'manual' };
  steering: Record<string, FieldJson>;
  motion: { droop: number; bump: number; driver: DesignState['driver'] };
  shared: Record<Axle, {
    antiRollBar: SharedDesign['antiRollBar']; heaveSpring: SharedDesign['heaveSpring'];
    fields: Record<string, FieldJson>; dropLink: { x: FieldJson; y: FieldJson; z: FieldJson };
  }>;
  presetId?: string;
}

const fj = (f: Field): FieldJson => ({ text: f.text, value: f.value });
const mapFields = <K extends string>(keys: readonly K[], rec: Record<K, Field>) =>
  Object.fromEntries(keys.map((k) => [k, fj(rec[k])])) as Record<string, FieldJson>;

function cornerToJson(id: CornerId, c: CornerDesign): CornerJson {
  return {
    type: 'doubleWishbone',
    points: Object.fromEntries(POINT_KEYS.map((k) => {
      const [x, y, z] = c.geom.points[k];
      return [cornerParam(id, POINT_NAMES[k]), { x: fj(x), y: fj(y), z: fj(z) }];
    })),
    scalars: Object.fromEntries(SCALAR_KEYS.map((k) => [cornerParam(id, SCALAR_META[k].name), fj(c.geom.scalars[k])])),
    damperArm: c.geom.damperArm,
    spring: mapFields(SPRING_KEYS, c.spring),
    damper: { fields: mapFields(DAMPER_KEYS, c.damper), bumpStop: c.bumpStop },
    tire: { model: c.tireModel, volumeChange: c.volumeChange, sizeText: c.tireSizeText, fields: mapFields(TIRE_KEYS, c.tire) },
  };
}

export function serializeProject(d: DesignState, name: string): ProjectFile {
  const corners = mergedCorners(d);
  return {
    format: FILE_FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: APP_VERSION,
    name,
    savedAt: new Date().toISOString(),
    units: { length: 'mm', angle: 'deg', force: 'N', pressure: 'kPa', mass: 'kg', rate: 'N/mm' },
    corners: Object.fromEntries(CORNER_IDS.map((id) => [id, cornerToJson(id, corners[id])])) as Record<CornerId, CornerJson>,
    links: { ...d.links },
    settings: structuredClone(d.settings),
    activeCorner: d.activeCorner,
    vehicle: { fields: mapFields(VEHICLE_KEYS, d.vehicle), autoPreload: d.autoPreload, cornerLoadMode: d.cornerLoadMode },
    steering: mapFields(STEER_KEYS, d.steer),
    motion: { droop: d.droop, bump: d.bump, driver: d.driver },
    shared: Object.fromEntries((['front', 'rear'] as const).map((a) => {
      const sh = d.shared[a];
      return [a, {
        antiRollBar: sh.antiRollBar, heaveSpring: sh.heaveSpring,
        fields: { arbRate: fj(sh.arbRate), barRate: fj(sh.barRate), lever: fj(sh.lever), heaveRate: fj(sh.heaveRate) },
        dropLink: { x: fj(sh.dropLink[0]), y: fj(sh.dropLink[1]), z: fj(sh.dropLink[2]) },
      }];
    })) as unknown as ProjectFile['shared'],
    presetId: d.presetId,
  };
}

/** The design part of a file, for "unsaved changes" comparison (no name or timestamp). */
export function designSnapshot(d: DesignState): string {
  const f = serializeProject(d, '');
  return JSON.stringify({ ...f, name: undefined, savedAt: undefined, appVersion: undefined, activeCorner: undefined });
}

/**
 * Upgrades from formatVersion N to N + 1. Add one entry whenever the file layout changes.
 */
const MIGRATIONS: Record<number, (f: Json) => Json> = {
  // 1 → 2: the single corner becomes all four corners (linked, as before), plus default
  // per-corner settings and vehicle inputs.
  1: (f) => {
    const corner = isObj(f.corner) ? f.corner : {};
    const cornerFor = (id: CornerId) => {
      const rename = (rec: unknown) => Object.fromEntries(Object.entries(isObj(rec) ? rec : {}).map(([k, v]) => [cornerParam(id, k), v]));
      const damper = isObj(f.damper) ? f.damper : {};
      return {
        type: 'doubleWishbone',
        points: rename(corner.points),
        scalars: rename(corner.scalars),
        damperArm: corner.damperArm,
        spring: f.spring,
        damper: { fields: damper.fields, bumpStop: damper.bumpStop },
        tire: f.tire,
      };
    };
    return {
      ...f,
      formatVersion: 2,
      corners: Object.fromEntries(CORNER_IDS.map((id) => [id, cornerFor(id)])),
      links: { ...DEFAULT_LINKS },
      settings: structuredClone(DEFAULT_SETTINGS),
      activeCorner: 'FL',
    };
  },
  // 2 → 3: brakes (outboard on every corner), no shared components. Missing values take defaults on read.
  2: (f) => ({ ...f, formatVersion: 3 }),
};

export interface ImportResult {
  design: DesignState;
  name: string;
  warnings: string[];
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read one saved value: keep the full-precision stored value if the text still agrees, else re-parse the text. */
function readField(raw: unknown, quantity: Quantity, fallback: Field, where: string, warnings: string[]): Field {
  if (!isObj(raw)) {
    warnings.push(`${where}: missing, using default ${fallback.text}`);
    return fallback;
  }
  const text = typeof raw.text === 'string' ? raw.text : undefined;
  const stored = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : undefined;
  if (text !== undefined) {
    const r = parseValue(text, quantity);
    // The text is rounded for display; keep the stored value unless the text was edited to mean something else.
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

function readCorner(raw: unknown, id: CornerId, def: CornerDesign, warnings: string[]): CornerDesign {
  const c = isObj(raw) ? raw : {};
  if (!isObj(raw)) warnings.push(`${id}: missing, using the default corner`);
  const w = isObj(raw) ? warnings : [];
  const pts = isObj(c.points) ? c.points : {};
  const points = { ...def.geom.points };
  for (const k of POINT_KEYS) {
    const name = cornerParam(id, POINT_NAMES[k]);
    const p = pts[name];
    const obj = isObj(p) ? p : {};
    if (!isObj(p)) w.push(`${name}: missing, using default`);
    points[k] = (['x', 'y', 'z'] as const).map((ax, i) =>
      readField(obj[ax], 'length', def.geom.points[k][i]!, `${name}.${ax}`, isObj(p) ? w : [])) as [Field, Field, Field];
  }
  const sc = isObj(c.scalars) ? c.scalars : {};
  const scalars = Object.fromEntries(SCALAR_KEYS.map((k) => {
    const name = cornerParam(id, SCALAR_META[k].name);
    return [k, readField(sc[name], SCALAR_META[k].quantity, def.geom.scalars[k], name, w)];
  })) as CornerDesign['geom']['scalars'];
  const damperRaw = isObj(c.damper) ? c.damper : {};
  const tireRaw = isObj(c.tire) ? c.tire : {};
  const model = tireRaw.model === 'rigid' || tireRaw.model === 'stiffness' || tireRaw.model === 'gas' ? tireRaw.model : def.tireModel;
  return {
    geom: { points, scalars, damperArm: c.damperArm === 'uca' ? 'uca' : 'lca' },
    spring: readRecord(c.spring, SPRING_KEYS, (k) => SPRING_META[k].quantity, def.spring, `${id}.spring`, w),
    damper: readRecord(damperRaw.fields, DAMPER_KEYS, (k) => DAMPER_META[k].quantity, def.damper, `${id}.damper`, w),
    bumpStop: typeof damperRaw.bumpStop === 'boolean' ? damperRaw.bumpStop : def.bumpStop,
    tireModel: model,
    tire: readRecord(tireRaw.fields, TIRE_KEYS, (k) => TIRE_META[k].quantity, def.tire, `${id}.tire`, w),
    volumeChange: typeof tireRaw.volumeChange === 'boolean' ? tireRaw.volumeChange : def.volumeChange,
    tireSizeText: typeof tireRaw.sizeText === 'string' ? tireRaw.sizeText : '',
  };
}

function readShared(raw: unknown, axle: Axle, warnings: string[]): SharedDesign {
  const def = defaultShared();
  const all = isObj(raw) ? raw : {};
  const a = isObj(all[axle]) ? all[axle] as Json : {};
  const fields = isObj(a.fields) ? a.fields : {};
  const dl = isObj(a.dropLink) ? a.dropLink : {};
  const arb = a.antiRollBar === 'wheelRate' || a.antiRollBar === 'torsionBar' ? a.antiRollBar : 'none';
  return {
    antiRollBar: arb,
    heaveSpring: a.heaveSpring === 'wheelRate' ? 'wheelRate' : 'none',
    arbRate: readField(fields.arbRate, SHARED_META.arbRate.quantity, def.arbRate, `shared.${axle}.arbRate`, warnings),
    barRate: readField(fields.barRate, SHARED_META.barRate.quantity, def.barRate, `shared.${axle}.barRate`, warnings),
    lever: readField(fields.lever, SHARED_META.lever.quantity, def.lever, `shared.${axle}.lever`, warnings),
    heaveRate: readField(fields.heaveRate, SHARED_META.heaveRate.quantity, def.heaveRate, `shared.${axle}.heaveRate`, warnings),
    dropLink: (['x', 'y', 'z'] as const).map((k, i) => readField(dl[k], 'length', def.dropLink[i]!, `shared.${axle}.dropLink.${k}`, warnings)) as [Field, Field, Field],
  };
}

export function importProject(data: unknown): ImportResult {
  if (!isObj(data) || data.format !== FILE_FORMAT) throw new Error('Not a Suspension Calculator project file');
  const warnings: string[] = [];
  let f: Json = data;
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
  const defCorner: CornerDesign = def.corners.FL;
  // Values that didn't exist in the file's original format take defaults quietly.
  const original = typeof data.formatVersion === 'number' ? data.formatVersion : 1;
  const older = original < 3;
  const cornersRaw = isObj(f.corners) ? f.corners : {};
  const corners = Object.fromEntries(CORNER_IDS.map((id) => [id, readCorner(cornersRaw[id], id, defCorner, warnings)])) as Record<CornerId, CornerDesign>;
  const linksRaw = isObj(f.links) ? f.links : {};
  const links: CornerLinks = {
    frontPair: typeof linksRaw.frontPair === 'boolean' ? linksRaw.frontPair : DEFAULT_LINKS.frontPair,
    rearPair: typeof linksRaw.rearPair === 'boolean' ? linksRaw.rearPair : DEFAULT_LINKS.rearPair,
    rearFromFront: typeof linksRaw.rearFromFront === 'boolean' ? linksRaw.rearFromFront : DEFAULT_LINKS.rearFromFront,
  };
  const settingsRaw = isObj(f.settings) ? f.settings : {};
  const settings = Object.fromEntries(CORNER_IDS.map((id) => {
    const r = isObj(settingsRaw[id]) ? settingsRaw[id] as Json : {};
    return [id, {
      steered: typeof r.steered === 'boolean' ? r.steered : DEFAULT_SETTINGS[id].steered,
      powered: typeof r.powered === 'boolean' ? r.powered : DEFAULT_SETTINGS[id].powered,
      brake: r.brake === 'none' || r.brake === 'inboard' || r.brake === 'outboard' ? r.brake : DEFAULT_SETTINGS[id].brake,
    }];
  })) as Record<CornerId, CornerSettings>;
  const activeCorner = (CORNER_IDS as string[]).includes(String(f.activeCorner)) ? f.activeCorner as CornerId : 'FL';
  const vehicleRaw = isObj(f.vehicle) ? f.vehicle : {};
  const motion = isObj(f.motion) ? f.motion : {};
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d);

  const design: DesignState = {
    presetId: typeof f.presetId === 'string' ? f.presetId : 'custom',
    ...corners.FL, // replaced with the active corner's root below
    steer: readRecord(f.steering, STEER_KEYS, (k) => STEER_META[k].quantity, def.steer, 'steering', warnings),
    droop: num(motion.droop, def.droop),
    bump: num(motion.bump, def.bump),
    driver: motion.driver === 'contactPatch' ? 'contactPatch' : 'wheelCenter',
    corners, links, settings, activeCorner,
    // Files upgraded from format 1 had no vehicle inputs: use the defaults quietly.
    vehicle: readRecord(vehicleRaw.fields, VEHICLE_KEYS, (k) => VEHICLE_META[k].quantity, def.vehicle, 'vehicle', older ? [] : warnings),
    autoPreload: typeof vehicleRaw.autoPreload === 'boolean' ? vehicleRaw.autoPreload : def.autoPreload,
    cornerLoadMode: vehicleRaw.cornerLoadMode === 'manual' ? 'manual' : 'vehicle',
    shared: { front: readShared(f.shared, 'front', older ? [] : warnings), rear: readShared(f.shared, 'rear', older ? [] : warnings) },
  };
  Object.assign(design, corners[rootOf(activeCorner, links)]);
  return { design, name: typeof f.name === 'string' && f.name ? f.name : 'Imported layout', warnings };
}
