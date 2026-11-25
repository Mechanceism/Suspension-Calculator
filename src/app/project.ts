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
 *   4  drive mount per corner, drive split, locks
 *   5  optimizer setup per corner design (free coordinates + ranges, goals)
 *   6  vehicle optimizer setup, tire grip model, roll load factor (corner optimizer)
 *   7  held dimensions (Measure → set, hold at a travel or permanently)
 *   8  damping rates, ABS and differential per corner, test definitions, road inputs
 *   9  tire grip model = Magic Formula coefficients (the contact-patch model keeps its fields for the
 *      contact-area goal); a format-8 friction coefficient μ ≠ 1 scales the peak μ's
 *  10  ride over time (Phase B): body roll and pitch inertia, tire damping (vehicle inputs)
 *  11  two-stage dampers (mode, high-speed rates, knees), optimizer search settings
 *  12  tire model from a .tir file (its coefficients), when one is loaded
 *  13  rear tires: same as the front, simple, or their own .tir model
 *  14  setup wizard status (which values are the user's and which are estimates)
 *  15  wheel offset (ET: the hub point is the mounting face) and rim width per corner design
 *  16  aerodynamics (on / off, generic values, an imported aero model)
 *  17  handling over time: yaw inertia (vehicle input), "steered by a driver" per test
 *  18  suspension type per corner design (double wishbone, MacPherson, multilink) and the multilink's
 *      rear-link upright ends (FL_UCA_Out2, FL_LCA_Out2)
 *  19  spring layout per design (coilover, or pushrod / pullrod + rocker) and the rocker points
 *      (FL_Rkr_Piv1, FL_Rkr_Piv2, FL_PR_Arm, FL_PR_Rkr); the single-arm suspension type
 *  20  steering mechanism (rack, or steering arm / plate with its pivot FL_Str_Piv1–2) and the variable ratio
 *  21  brake hydraulics (pedal, master cylinders, calipers, pads, rotors; off by default)
 *  22  towing a trailer (static hitch forces; off by default)
 *  23  each steering mechanism keeps its own ratio and limit (the unused one is saved too)
 *  24  solid axle types (4-link, 3-link + Panhard rod: FL_PH_Chs, FL_PH_Axle)
 */
import pkg from '../../package.json';
import { readResults, type SavedResult } from './savedResults';
import { rockerFromCoilover } from '../core/suspension/coilover';
import { SUSPENSION_KINDS, SUSPENSION_LABELS, isOneAxle, type SuspensionKind } from '../core/suspension/doubleWishbone';
import type { CustomLinkage, CustomJoint } from '../core/suspension/customLinkage';
import { parseValue, type Quantity } from '../core/units/units';
import { CORNER_IDS, type CornerId } from '../core/vehicle/vehicle';
import { DIM_MEASURES } from '../core/suspension/dimensions';
import { newSegment, newTestId, newFeature, OFF, defaultChecks, type TestDesign, type TestSegment } from './tests';
import { CHECK_IDS, CHECK_META, laneShare, type CheckProfile } from '../core/tests/checks';
import type { TirModel } from '../core/tire/tir';
import { parseAero, type AeroModel } from '../core/vehicle/aero';
import {
  defaultDesign, mergedCorners, layoutOf, rootOf, POINT_KEYS, POINT_NAMES, SCALAR_KEYS, SCALAR_META, SPRING_KEYS, SPRING_META,
  DAMPER_KEYS, DAMPER_META, STEER_KEYS, STEER_META, MECH_STEER_KEYS, TIRE_KEYS, TIRE_META, VEHICLE_KEYS, VEHICLE_META,
  DEFAULT_LINKS, DEFAULT_SETTINGS, SHARED_META, defaultShared, defaultOptimizerSetup, defaultVehicleOptimizerSetup, defaultGrip, GRIP_KEYS, GRIP_META,
  defaultTireGrip, MF_KEYS, MF_META, RIDE_KEYS, DAMPER_TWO_STAGE_KEYS, SETUP_STEPS, AERO_KEYS, AERO_META, defaultAero, PT_KEYS, PT_META, defaultPowertrain, type PowertrainSettings, BRAKE_KEYS, BRAKE_META, FADE_KEYS, FADE_META, BRAKE_MORE_KEYS, BRAKE_MORE_META, SHIMMY_KEYS, SHIMMY_META, defaultShimmy, defaultBrakes, TOW_KEYS, TOW_META, defaultTow,
  type VehicleOptimizerSetup, type HeldDimension, newDimId,
  type OptimizerSetup,
  type DesignState, type CornerDesign, type Field, type CornerLinks, type CornerSettings, type SharedDesign, type Axle, centerLinkDefaults, type DamperCurveText,
} from './store';

export const FILE_FORMAT = 'suspension-calculator-project';
export const FORMAT_VERSION = 48;
export const APP_VERSION: string = pkg.version;

type FieldJson = { text: string; value: number };
type Json = Record<string, unknown>;

/** Parameter name for a corner: FL_UCA_Fwd → RR_UCA_Fwd. */
export const cornerParam = (id: CornerId, flName: string) => flName.replace(/^FL_/, `${id}_`);

export interface CornerJson {
  type: SuspensionKind;
  points: Record<string, { x: FieldJson; y: FieldJson; z: FieldJson }>;
  scalars: Record<string, FieldJson>;
  damperArm: 'lca' | 'uca' | 'upright';
  springLayout?: 'coilover' | 'rocker';
  pushrodOn?: 'lca' | 'uca' | 'upright';
  steerMechanism?: 'rack' | 'arm' | 'centerLink';
  /** Arm pivot bushings (format 32), N/mm. */
  bushing?: { radial: FieldJson; axial: FieldJson };
  /** Solid axle: steered (format 28). */
  steeredAxle?: boolean;
  /** Custom linkage (format 27; mm). */
  custom?: unknown;
  spring: Record<string, FieldJson>;
  damper: { fields: Record<string, FieldJson>; bumpStop: boolean; mode?: 'linear' | 'twoStage' | 'curve'; curve?: DamperCurveText };
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
  /** The other steering mechanism's own ratio and limit (format 23). */
  steeringSaved?: Record<string, Record<string, FieldJson>>;
  /** Format 30: a measured steering ratio ('steering-wheel °, input' per line). */
  steeringCurve?: string;
  motion: { droop: number; bump: number; driver: DesignState['driver'] };
  shared: Record<Axle, {
    antiRollBar: SharedDesign['antiRollBar']; heaveSpring: SharedDesign['heaveSpring'];
    fields: Record<string, FieldJson>; dropLink: { x: FieldJson; y: FieldJson; z: FieldJson };
    /** Format 29: what the drop link is fixed to. */
    dropLinkOn?: 'lca' | 'uca' | 'upright' | 'rocker';
  }>;
  /** Locked values (keys as in locks.ts). */
  locks: string[];
  /** Format 37: which locks the setup wizard set (lock key → wizard step). */
  wizardLocks?: Record<string, string>;
  /** Optimizer setup per corner design (root corner). */
  optimizer: Partial<Record<CornerId, OptimizerJson>>;
  vehicleOptimizer: {
    ranges: Record<string, { lo: FieldJson; hi: FieldJson }>;
    goals: Record<string, { on: boolean; target: FieldJson; weight: FieldJson }>;
    lateralG: FieldJson; brakingG: FieldJson; accelG: FieldJson; keepClose: FieldJson; caseSource?: string; starts?: number;
    combinedLatG?: FieldJson; combinedBrakeG?: FieldJson; caseWeights?: Record<string, number>;
  };
  /** Contact-patch pressure model (contact-area goal). */
  grip: Record<string, FieldJson>;
  /** Tire grip model: Magic Formula coefficients (format 9). */
  tireGrip?: Record<string, FieldJson>;
  /** Tire model loaded from a .tir file (format 12): its coefficients, by name. */
  tireFile?: { name: string; fittyp: number; version: '6.1' | '5.2'; fnomin: number; nompres: number; p: Record<string, number> } | null;
  /** Aerodynamics (format 16). */
  aero?: { on: boolean; fields: Record<string, FieldJson>; file: AeroModel | null };
  /** Static ride height (format 48): set or not, front / rear (mm). */
  rideHeight?: { on: boolean; front: FieldJson; rear: FieldJson };
  /** Powertrain (format 45): none / electric / gas and its values. */
  powertrain?: { kind: 'none' | 'electric' | 'gas'; fields: Record<string, FieldJson> };
  brakes?: {
    on: boolean; dualMc: boolean; useBias: boolean; fields: Record<string, FieldJson>; fade?: { on: boolean; fields: Record<string, FieldJson> };
    /** Format 39: drums, wheel room, detailed hydraulics, the ladder's reserve and permissions. */
    more?: { drumF: boolean; drumR: boolean; detail: boolean; allowDiscF: boolean; allowDiscR: boolean; fields: Record<string, FieldJson> };
  };
  tow?: { on: boolean; fields: Record<string, FieldJson> };
  /** Format 41: shimmy inputs. */
  shimmy?: { check: boolean; handsOn: boolean; fields: Record<string, FieldJson> };
  /** Setup wizard status per step (format 14). */
  setupStatus?: Record<string, 'entered' | 'estimated'>;
  /** What the car is for (format 47). */
  useCase?: string;
  /** Rear tires (format 13): null = same as the front, 'simple', or their own .tir model. */
  tireFileRear?: { name: string; fittyp: number; version: '6.1' | '5.2'; fnomin: number; nompres: number; p: Record<string, number> } | 'simple' | null;
  /** Tests (chains of segments). */
  tests?: unknown[];
  /** Held dimensions (points named per corner, e.g. FL_UCA_Fwd). */
  dimensions: { root: CornerId; a: string; b: string; measure: string; value: number; travel: number | null }[];
  presetId?: string;
  /** A model-and-tests file: its tests' last results (scores only; savedResults.ts), by test id. */
  results?: Record<string, SavedResult>;
}

interface OptimizerJson {
  ranges: Record<string, { lo: FieldJson; hi: FieldJson }>;
  goals: Record<string, { on: boolean; target: FieldJson; weight: FieldJson }>;
  rollAngle: FieldJson; rackCheck: FieldJson; keepClose: FieldJson; rollLoadFactor: FieldJson; starts?: number;
  lengthRanges?: Record<string, { lo: FieldJson; hi: FieldJson }>;
}

const fj = (f: Field): FieldJson => ({ text: f.text, value: f.value });
const mapFields = <K extends string>(keys: readonly K[], rec: Record<K, Field>) =>
  Object.fromEntries(keys.map((k) => [k, fj(rec[k])])) as Record<string, FieldJson>;

function cornerToJson(id: CornerId, c: CornerDesign): CornerJson {
  return {
    type: c.geom.kind ?? 'doubleWishbone',
    points: Object.fromEntries(POINT_KEYS.map((k) => {
      const [x, y, z] = c.geom.points[k];
      return [cornerParam(id, POINT_NAMES[k]), { x: fj(x), y: fj(y), z: fj(z) }];
    })),
    scalars: Object.fromEntries(SCALAR_KEYS.map((k) => [cornerParam(id, SCALAR_META[k].name), fj(c.geom.scalars[k])])),
    damperArm: c.geom.damperArm,
    springLayout: layoutOf(c.geom), pushrodOn: c.geom.pushrodOn ?? 'lca', steerMechanism: c.geom.steerMechanism ?? 'rack',
    ...(c.geom.steeredAxle ? { steeredAxle: true } : {}),
    ...(c.geom.bushing ? { bushing: { radial: fj(c.geom.bushing.radial), axial: fj(c.geom.bushing.axial) } } : {}),
    ...(c.geom.custom ? { custom: JSON.parse(JSON.stringify(c.geom.custom)) as unknown } : {}),
    spring: mapFields(SPRING_KEYS, c.spring),
    damper: { fields: mapFields(DAMPER_KEYS, c.damper), bumpStop: c.bumpStop, mode: c.damperMode, ...(c.damperCurve ? { curve: c.damperCurve } : {}) },
    tire: { model: c.tireModel, volumeChange: c.volumeChange, sizeText: c.tireSizeText, fields: mapFields(TIRE_KEYS, c.tire) },
  };
}

export function serializeProject(d: DesignState, name: string, include: { tests: boolean; results?: Record<string, SavedResult> } = { tests: true }): ProjectFile {
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
    steeringSaved: Object.fromEntries(Object.entries(d.steerSaved).map(([m, rec]) => [m, mapFields(MECH_STEER_KEYS, rec!)])),
    ...(d.steerCurve ? { steeringCurve: d.steerCurve } : {}),
    motion: { droop: d.droop, bump: d.bump, driver: d.driver },
    shared: Object.fromEntries((['front', 'rear'] as const).map((a) => {
      const sh = d.shared[a];
      return [a, {
        antiRollBar: sh.antiRollBar, heaveSpring: sh.heaveSpring,
        fields: { arbRate: fj(sh.arbRate), barRate: fj(sh.barRate), lever: fj(sh.lever), heaveRate: fj(sh.heaveRate) },
        dropLink: { x: fj(sh.dropLink[0]), y: fj(sh.dropLink[1]), z: fj(sh.dropLink[2]) },
        ...(sh.dropLinkOn && sh.dropLinkOn !== 'lca' ? { dropLinkOn: sh.dropLinkOn } : {}),
      }];
    })) as unknown as ProjectFile['shared'],
    locks: Object.keys(d.locks).sort(),
    wizardLocks: Object.fromEntries(Object.entries(d.wizardLocks).filter(([k]) => d.locks[k]).sort(([a], [b]) => a.localeCompare(b))),
    optimizer: Object.fromEntries(Object.entries(d.optimizer).filter(([, o]) => o).map(([id, o]) => [id, {
      ranges: Object.fromEntries(Object.entries(o!.ranges).map(([k, r]) => [k, { lo: fj(r.lo), hi: fj(r.hi) }])),
      goals: Object.fromEntries(Object.entries(o!.goals).map(([k, g]) => [k, { on: g.on, target: fj(g.target), weight: fj(g.weight) }])),
      rollAngle: fj(o!.rollAngle), rackCheck: fj(o!.rackCheck), keepClose: fj(o!.keepClose), rollLoadFactor: fj(o!.rollLoadFactor),
      ...(o!.starts && o!.starts > 1 ? { starts: o!.starts } : {}),
      ...(o!.lengthRanges ? { lengthRanges: Object.fromEntries(Object.entries(o!.lengthRanges).map(([k, r]) => [k, { lo: fj(r!.lo), hi: fj(r!.hi) }])) } : {}),
    }])),
    vehicleOptimizer: {
      ranges: Object.fromEntries(Object.entries(d.vehicleOptimizer.ranges).map(([k, r]) => [k, { lo: fj(r.lo), hi: fj(r.hi) }])),
      goals: Object.fromEntries(Object.entries(d.vehicleOptimizer.goals).map(([k, g]) => [k, { on: g.on, target: fj(g.target), weight: fj(g.weight) }])),
      lateralG: fj(d.vehicleOptimizer.lateralG), brakingG: fj(d.vehicleOptimizer.brakingG),
      accelG: fj(d.vehicleOptimizer.accelG), keepClose: fj(d.vehicleOptimizer.keepClose),
      ...(d.vehicleOptimizer.caseSource ? { caseSource: d.vehicleOptimizer.caseSource } : {}),
      ...(d.vehicleOptimizer.starts && d.vehicleOptimizer.starts > 1 ? { starts: d.vehicleOptimizer.starts } : {}),
      ...(d.vehicleOptimizer.combinedLatG ? { combinedLatG: fj(d.vehicleOptimizer.combinedLatG) } : {}),
      ...(d.vehicleOptimizer.combinedBrakeG ? { combinedBrakeG: fj(d.vehicleOptimizer.combinedBrakeG) } : {}),
      ...(d.vehicleOptimizer.caseWeights ? { caseWeights: { ...d.vehicleOptimizer.caseWeights } } : {}),
    },
    grip: mapFields(GRIP_KEYS, d.grip),
    tireGrip: mapFields(MF_KEYS, d.tireGrip),
    tireFile: d.tireFile ? tirJson(d.tireFile) : null,
    tireFileRear: d.tireFileRear === 'simple' ? 'simple' : d.tireFileRear ? tirJson(d.tireFileRear) : null,
    setupStatus: { ...d.setupStatus },
    ...(d.useCase ? { useCase: d.useCase } : {}),
    aero: { on: d.aero.on, fields: mapFields(AERO_KEYS, d.aero), file: d.aero.file ? JSON.parse(JSON.stringify(d.aero.file)) as AeroModel : null },
    powertrain: { kind: d.powertrain.kind, fields: mapFields(PT_KEYS, d.powertrain) },
    rideHeight: { on: d.rideHeight.on, front: { ...d.rideHeight.front }, rear: { ...d.rideHeight.rear } },
    brakes: { on: d.brakes.on, dualMc: d.brakes.dualMc, useBias: d.brakes.useBias, fields: mapFields(BRAKE_KEYS, d.brakes), fade: { on: d.brakes.fade, fields: mapFields(FADE_KEYS, d.brakes) },
      more: { drumF: d.brakes.drumF, drumR: d.brakes.drumR, detail: d.brakes.detail, allowDiscF: d.brakes.allowDiscF, allowDiscR: d.brakes.allowDiscR, fields: mapFields(BRAKE_MORE_KEYS, d.brakes) } },
    tow: { on: d.tow.on, fields: mapFields(TOW_KEYS, d.tow) },
    shimmy: { check: d.shimmy.check, handsOn: d.shimmy.handsOn, fields: mapFields(SHIMMY_KEYS, d.shimmy) },
    ...(include.tests ? { tests: JSON.parse(JSON.stringify(d.tests)) as unknown[] } : {}),
    dimensions: d.dimensions.map((x) => ({
      root: x.root, a: cornerParam(x.root, POINT_NAMES[x.a]), b: cornerParam(x.root, POINT_NAMES[x.b]),
      measure: x.measure, value: x.value, travel: x.travel,
    })),
    presetId: d.presetId,
    ...(include.tests && include.results && Object.keys(include.results).length ? { results: include.results } : {}),
  };
}

/** The design part of a file, for "unsaved changes" comparison (no name or timestamp). */
export function designSnapshot(d: DesignState): string {
  const f = serializeProject(d, '');
  return JSON.stringify({ ...f, name: undefined, savedAt: undefined, appVersion: undefined, activeCorner: undefined });
}

/** The model part (everything but the tests), for unsaved-change tracking. */
export function modelSnapshot(d: DesignState): string {
  const f = serializeProject(d, '', { tests: false });
  return JSON.stringify({ ...f, name: undefined, savedAt: undefined, appVersion: undefined, activeCorner: undefined });
}

/** The tests part, for unsaved-change tracking. */
export const testsSnapshot = (d: Pick<DesignState, 'tests'>): string => JSON.stringify(d.tests);

export const TESTS_FORMAT = 'suspension-calculator-tests';

/** A tests-only file. */
export function serializeTests(d: Pick<DesignState, 'tests'>, name: string) {
  return { format: TESTS_FORMAT, formatVersion: FORMAT_VERSION, appVersion: APP_VERSION, name, savedAt: new Date().toISOString(), tests: JSON.parse(JSON.stringify(d.tests)) as unknown[] };
}

/** Tests from a tests-only file or from a project file. */
export function importTests(data: unknown): { tests: TestDesign[]; warnings: string[] } {
  if (!isObj(data) || (data.format !== TESTS_FORMAT && data.format !== FILE_FORMAT)) throw new Error('Not a Suspension Calculator tests or project file');
  const warnings: string[] = [];
  return { tests: readTests(data.tests, warnings), warnings };
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
  // 3 → 4: drive mount (chassis diff), drive split and locks (none). Missing values take defaults.
  3: (f) => ({ ...f, formatVersion: 4 }),
  // 4 → 5: optimizer setups (none).
  4: (f) => ({ ...f, formatVersion: 5 }),
  // 5 → 6: vehicle optimizer (none), default tire grip model, roll load factor default.
  5: (f) => ({ ...f, formatVersion: 6 }),
  // 6 → 7: held dimensions (none).
  6: (f) => ({ ...f, formatVersion: 7 }),
  // 7 → 8: damping rates, ABS (on) and open differentials per corner, tests (none). Defaults apply.
  7: (f) => ({ ...f, formatVersion: 8 }),
  // 8 → 9: the Magic Formula becomes the tire grip model. A friction coefficient μ the user changed in the
  // old contact-patch model scales the generic peak μ's, so grip stays about where it was.
  8: (f) => {
    const g = isObj(f.grip) ? f.grip : {};
    const mu = isObj(g.muRef) && typeof g.muRef.value === 'number' ? g.muRef.value : 1;
    if (isObj(f.tireGrip) || !(mu > 0) || Math.abs(mu - 1) < 1e-9) return { ...f, formatVersion: 9 };
    const d = defaultTireGrip();
    const scaled = (k: 'pDy1' | 'pDx1') => { const v = Number((d[k].value * mu).toFixed(4)); return { text: String(v), value: v }; };
    return { ...f, formatVersion: 9, tireGrip: { pDy1: scaled('pDy1'), pDx1: scaled('pDx1') } };
  },
  // 9 → 10: ride inputs (body inertias, tire damping) take their defaults.
  9: (f) => ({ ...f, formatVersion: 10 }),
  // 10 → 11: linear dampers (two-stage inputs take the generic defaults), local search.
  10: (f) => ({ ...f, formatVersion: 11 }),
  // 11 → 12: no tire file (the simple tire model).
  11: (f) => ({ ...f, formatVersion: 12 }),
  // 12 → 13: rear tires the same as the front.
  12: (f) => ({ ...f, formatVersion: 13 }),
  // 13 → 14: no setup wizard status yet.
  13: (f) => ({ ...f, formatVersion: 14 }),
  // 14 → 15: wheel offset 0 (the hub point is the tire's centerline) and the measuring rim.
  14: (f) => ({ ...f, formatVersion: 15 }),
  // 15 → 16: no aero (negligible), as before.
  15: (f) => ({ ...f, formatVersion: 16 }),
  // 16 → 17: default yaw inertia; tests steered by a driver.
  16: (f) => ({ ...f, formatVersion: 17 }),
  // 17 → 18: every corner was a double wishbone; the multilink points start at the ball joints.
  17: (f) => ({ ...f, formatVersion: 18 }),
  // 18 → 19: every spring was a coilover; rocker points are built from it.
  18: (f) => ({ ...f, formatVersion: 19 }),
  // 19 → 20: every car steered with a rack at a constant ratio.
  19: (f) => ({ ...f, formatVersion: 20 }),
  // 20 → 21: brakes always strong enough (hydraulics off).
  20: (f) => ({ ...f, formatVersion: 21 }),
  // 21 → 22: no trailer.
  21: (f) => ({ ...f, formatVersion: 22 }),
  // 22 → 23: no saved values for the other steering mechanism.
  22: (f) => ({ ...f, formatVersion: 23 }),
  // 23 → 24: no solid axles.
  23: (f) => ({ ...f, formatVersion: 24 }),
  // 24 → 25: no brake fade.
  24: (f) => ({ ...f, formatVersion: 25 }),
  // 25 → 26: a trailer gets the default yaw radius of gyration (for sway).
  25: (f) => ({ ...f, formatVersion: 26, ...(isObj(f.tow) && isObj(f.tow.fields) ? { tow: { ...f.tow, fields: { ...f.tow.fields, trailerYawRadius: { text: '1350', value: 1350 } } } } : {}) }),
  // 26 → 27: no custom linkages (nothing to change).
  26: (f) => ({ ...f, formatVersion: 27 }),
  // 27 → 28: no steered solid axles, no Watt's linkage (nothing to change).
  27: (f) => ({ ...f, formatVersion: 28 }),
  // 28 → 29: drop links on the lower arm (the only choice before).
  28: (f) => ({ ...f, formatVersion: 29 }),
  // 29 → 30: no measured steering ratio.
  29: (f) => ({ ...f, formatVersion: 30 }),
  // 30 → 31: center-link steering points (filled in on read).
  30: (f) => ({ ...f, formatVersion: 31 }),
  // 31 → 32: arm bushings at their typical stiffness (absent = typical).
  31: (f) => ({ ...f, formatVersion: 32 }),
  // 32 → 33: a trailer gets no hitch rating (no limit).
  32: (f) => ({ ...f, formatVersion: 33, ...(isObj(f.tow) && isObj(f.tow.fields) ? { tow: { ...f.tow, fields: { ...f.tow.fields, tongueLimit: { text: '0', value: 0 } } } } : {}) }),
  // 33 → 34: tire relaxation off (0).
  33: (f) => ({ ...f, formatVersion: 34 }),
  // 35 → 36: no damper dyno curves.
  35: (f) => ({ ...f, formatVersion: 36 }),
  // 36 → 37: no locks from the setup wizard (older locks are the user's own).
  36: (f) => ({ ...f, formatVersion: 37 }),
  // 37 → 38: the steering-effort check at 0.5 g (new steering input).
  37: (f) => ({ ...f, formatVersion: 38, ...(isObj(f.steering) ? { steering: { ...f.steering, effortG: { text: '0.5', value: 0.5 } } } : {}) }),
  // 38 → 39: disc brakes, the simple hydraulics (drums, wheel room, detailed hydraulics and the ladder take defaults).
  38: (f) => ({ ...f, formatVersion: 39 }),
  // 39 → 40: no rolling resistance (results stay as they were); segments don't coast.
  // 40 → 41: shimmy inputs take their defaults (on read).
  40: (f) => ({ ...f, formatVersion: 41 }),
  // 41 → 42: tests from before hold their set speeds exactly (speeds as maximums is new; read below).
  41: (f) => ({ ...f, formatVersion: 42 }),
  // 42 → 43: an optional results section (a model-and-tests file's test scores; R9 snapshots).
  42: (f) => ({ ...f, formatVersion: 43 }),
  // 43 → 44: a test's speeds can be grip only (with an optional top speed); wheel lift is noted, not scored.
  43: (f) => ({ ...f, formatVersion: 44 }),
  // 44 → 45: a powertrain (none in older files: only the tires limit the drive, as before).
  44: (f) => ({ ...f, formatVersion: 45 }),
  // 45 → 46: the off-the-line limit is a lane as a share of the car's width (was metres; read as such below 30).
  45: (f) => ({ ...f, formatVersion: 46 }),
  // 46 → 47: what the car is for (none in older files: the tests and goals as they are).
  46: (f) => ({ ...f, formatVersion: 47 }),
  // 47 → 48: a set static ride height (off in older files: the car rests at the design position).
  47: (f) => ({ ...f, formatVersion: 48 }),
  39: (f) => ({ ...f, formatVersion: 40, ...(isObj(f.vehicle) && isObj(f.vehicle.fields) ? { vehicle: { ...f.vehicle, fields: { ...f.vehicle.fields, rollingResistance: { text: '0', value: 0 } } } } : {}) }),
  // 34 → 35: aero side force, roll sensitivity and balance shift off.
  34: (f) => ({ ...f, formatVersion: 35, ...(isObj(f.aero) && isObj(f.aero.fields) ? { aero: { ...f.aero, fields: { ...f.aero.fields, CsA: { text: '0', value: 0 }, sideCp: { text: '900', value: 900 }, rollSensF: { text: '0', value: 0 }, rollSensR: { text: '0', value: 0 }, yawBalance: { text: '0', value: 0 } } } } : {}) }),
};

/** Read a check table; unknown checks are ignored, missing ones take the defaults. */
function readChecks(raw: Json): CheckProfile {
  const out = defaultChecks();
  for (const id of CHECK_IDS) {
    const c = raw[id];
    if (!isObj(c)) continue;
    const sev = c.severity === 'pass' || c.severity === 'warn' || c.severity === 'fail' ? c.severity : out[id].severity;
    out[id] = {
      severity: CHECK_META[id].fixed ? out[id].severity : sev,
      ...(typeof c.threshold === 'number' ? { threshold: id === 'pathError' ? Math.round(laneShare(c.threshold) * 100) : c.threshold } : out[id].threshold !== undefined ? { threshold: out[id].threshold } : {}),
      ...(typeof c.threshold2 === 'number' ? { threshold2: c.threshold2 } : out[id].threshold2 !== undefined ? { threshold2: out[id].threshold2 } : {}),
    };
  }
  return out;
}

/** Read tests; anything malformed is dropped (with a warning) or takes defaults. */
function readTests(raw: unknown, warnings: string[]): TestDesign[] {
  if (!Array.isArray(raw)) return [];
  const out: TestDesign[] = [];
  const fieldOr = (x: unknown, q: Quantity, d: Field, where: string): Field =>
    (isObj(x) && typeof x.text === 'string' && x.text.trim() === '' ? { text: '', value: NaN } : readField(x, q, d, where, warnings));
  // Older files had priority % per test and a weight per segment: they become ranks (largest = 1).
  const valueOf = (x: unknown) => (isObj(x) && typeof x.value === 'number' ? x.value : null);
  const rankOf = (explicit: unknown, legacy: (number | null)[], i: number) => {
    if (typeof explicit === 'number' && explicit >= 1) return Math.round(explicit);
    const v = legacy[i];
    if (v === null || v === undefined) return 1;
    const uniq = [...new Set(legacy.filter((x): x is number => x !== null))].sort((a, b) => b - a);
    return uniq.indexOf(v) + 1;
  };
  const testLegacy = raw.map((t) => (isObj(t) ? valueOf(t.priority) : null));
  for (const [ti, t] of raw.entries()) {
    if (!isObj(t) || !Array.isArray(t.segments)) { warnings.push('a test could not be read, dropped'); continue; }
    const name = typeof t.name === 'string' ? t.name : 'Test';
    const segRaw = t.segments.filter(isObj);
    const segLegacy = segRaw.map((sr) => valueOf(sr.weight));
    const segments = segRaw.map((sr, si) => {
      const d = newSegment();
      const where = (k: string) => `test "${name}" ${k}`;
      const bumpsRaw = isObj(sr.bumps) ? sr.bumps : {};
      return {
        ...d,
        name: typeof sr.name === 'string' ? sr.name : d.name,
        distance: fieldOr(sr.distance, 'distance', d.distance, where('distance')),
        speedStart: fieldOr(sr.speedStart, 'speed', d.speedStart, where('start speed')),
        speedEnd: fieldOr(sr.speedEnd, 'speed', d.speedEnd, where('end speed')),
        path: sr.path === 'left' || sr.path === 'right' ? sr.path : 'straight',
        radius: fieldOr(sr.radius, 'distance', d.radius, where('radius')),
        ...(isObj(sr.width) ? { width: fieldOr(sr.width, 'distance', { text: '', value: 0 }, where('track width')) } : {}),
        latG: fieldOr(sr.latG, 'ratio', OFF, where('lateral g')),
        longG: fieldOr(sr.longG, 'ratio', OFF, where('longitudinal g')),
        grade: fieldOr(sr.grade, 'percent', d.grade, where('grade')),
        bank: fieldOr(sr.bank, 'angle', d.bank, where('bank')),
        bumps: Object.fromEntries(CORNER_IDS.map((id) => [id, fieldOr(bumpsRaw[id], 'length', d.bumps[id], where(`bump ${id}`))])) as TestSegment['bumps'],
        lumpy: sr.lumpy === true,
        ...(sr.coast === true ? { coast: true } : {}),
        rough: (() => {
          const r = isObj(sr.rough) ? sr.rough : null;
          // Format 8 "lumpy" becomes a rough surface.
          if (!r) return { ...d.rough, on: sr.lumpy === true };
          return {
            on: r.on === true, seed: typeof r.seed === 'number' ? r.seed : d.rough.seed,
            maxHeight: fieldOr(r.maxHeight, 'length', d.rough.maxHeight, where('rough height')),
            scale: fieldOr(r.scale, 'distance', d.rough.scale, where('rough scale')),
            coverage: fieldOr(r.coverage, 'percent', d.rough.coverage, where('rough coverage')),
          };
        })(),
        features: (Array.isArray(sr.features) ? sr.features : []).filter(isObj).map((fr) => {
          const kind = fr.kind === 'pothole' ? 'pothole' : 'bump';
          const df = newFeature(kind);
          return {
            id: typeof fr.id === 'string' ? fr.id : df.id, kind,
            at: fieldOr(fr.at, 'distance', df.at, where('feature position')),
            length: fieldOr(fr.length, 'distance', df.length, where('feature length')),
            height: fieldOr(fr.height, 'length', df.height, where('feature height')),
            side: fr.side === 'left' || fr.side === 'right' ? fr.side : 'both',
          } as TestSegment['features'][number];
        }),
        rank: rankOf(sr.rank, segLegacy, si),
        checks: isObj(sr.checks) ? readChecks(sr.checks) : null,
        profile: typeof sr.profile === 'string' ? sr.profile : null,
      } as TestSegment;
    });
    const checks = isObj(t.checks) ? readChecks(t.checks) : defaultChecks();
    // Format 8 tests had a single grip reserve: it becomes the near-limit check's reserve.
    if (!isObj(t.checks) && isObj(t.margin) && typeof t.margin.value === 'number') checks.nearLimit = { ...checks.nearLimit, threshold: t.margin.value };
    out.push({
      id: typeof t.id === 'string' ? t.id : newTestId('test'), name, segments, checks,
      profile: typeof t.profile === 'string' ? t.profile : isObj(t.checks) ? 'custom' : 'default',
      rank: rankOf(t.rank, testLegacy, ti),
      onFail: t.onFail === 'lift' ? 'lift' : 'report',
      enabled: t.enabled !== false,
      ride: t.ride !== false,
      handling: t.handling !== false,
      ...(t.driverSpeed === true ? { driverSpeed: true } : {}),
      ...(t.racingLine === true ? { racingLine: true } : {}),
      speedMode: t.speedMode === 'max' || t.speedMode === 'grip' ? t.speedMode : 'hold',
      ...(t.speedMode === 'grip' && isObj(t.topSpeed) && typeof t.topSpeed.value === 'number' && t.topSpeed.value > 0
        ? { topSpeed: { text: typeof t.topSpeed.text === 'string' ? t.topSpeed.text : String(t.topSpeed.value), value: t.topSpeed.value } } : {}),
      ...(t.speedMode === 'max' || t.speedMode === 'grip' ? { gripTarget: typeof t.gripTarget === 'number' && t.gripTarget > 0.2 && t.gripTarget <= 1 ? t.gripTarget : 0.95 } : {}),
    });
  }
  return out;
}

const tirJson = (m: TirModel) => ({ name: m.name, fittyp: m.fittyp, version: m.version, fnomin: m.fnomin, nompres: m.nompres, p: { ...m.p } });

/** Read a saved .tir tire model; anything malformed is dropped with a warning (the simple model is used). */
function readTireFile(raw: unknown, warnings: string[]): TirModel | null {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw) || !isObj(raw.p) || typeof raw.fnomin !== 'number' || !(raw.fnomin > 0)) { warnings.push('tire file: unreadable, using the simple tire model'); return null; }
  const p = Object.fromEntries(Object.entries(raw.p).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>;
  return {
    kind: 'tir', name: typeof raw.name === 'string' ? raw.name : 'tire.tir', fittyp: typeof raw.fittyp === 'number' ? raw.fittyp : 61,
    version: raw.version === '5.2' ? '5.2' : '6.1', fnomin: raw.fnomin, nompres: typeof raw.nompres === 'number' ? raw.nompres : 0, p,
  };
}

/** Read held dimensions; unknown points or measures are dropped with a warning. */
function readDimensions(raw: unknown, warnings: string[]): HeldDimension[] {
  if (!Array.isArray(raw)) return [];
  const out: HeldDimension[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const root = r.root as CornerId;
    const pk = (name: unknown) => POINT_KEYS.find((k) => cornerParam(root, POINT_NAMES[k]) === name);
    const a = pk(r.a), b = pk(r.b);
    if (!(CORNER_IDS as string[]).includes(String(root)) || !a || !b || !(DIM_MEASURES as string[]).includes(String(r.measure))
      || typeof r.value !== 'number' || !Number.isFinite(r.value)) {
      warnings.push(`held dimension ${String(r.a)} → ${String(r.b)}: not understood, dropped`);
      continue;
    }
    out.push({ id: newDimId(), root, a, b, measure: r.measure as HeldDimension['measure'], value: r.value, travel: typeof r.travel === 'number' ? r.travel : null });
  }
  return out;
}

/** Ranges and goals shared by both optimizer setups. */
function readRangesGoals<G extends Record<string, { on: boolean; target: Field; weight: Field }>>(
  o: Json, goals: G, validKey: (k: string) => boolean, rf: (x: unknown, q: Quantity, fb: Field, where: string) => Field,
): { ranges: Record<string, { lo: Field; hi: Field }>; goals: G } {
  const ranges: Record<string, { lo: Field; hi: Field }> = {};
  for (const [k, r] of Object.entries(isObj(o.ranges) ? o.ranges : {})) {
    if (!validKey(k) || !isObj(r)) continue;
    ranges[k] = { lo: rf(r.lo, 'length', { text: '0', value: 0 }, `${k} min`), hi: rf(r.hi, 'length', { text: '0', value: 0 }, `${k} max`) };
  }
  const gRaw = isObj(o.goals) ? o.goals : {};
  for (const k of Object.keys(goals) as (keyof G & string)[]) {
    const g = gRaw[k];
    if (!isObj(g)) continue;
    const d = goals[k]!;
    (goals as Record<string, unknown>)[k] = { on: g.on === true, target: rf(g.target, 'ratio', d.target, `${k} target`), weight: rf(g.weight, 'ratio', d.weight, `${k} weight`) };
  }
  return { ranges, goals };
}

function readVehicleOptimizer(raw: unknown, warnings: string[]): VehicleOptimizerSetup {
  const d = defaultVehicleOptimizerSetup();
  if (!isObj(raw)) return d;
  const rf = (x: unknown, q: Quantity, fb: Field, where: string) => readField(x, q, fb, `vehicle optimizer ${where}`, warnings);
  const valid = (k: string) => {
    const [root, pk, ax] = k.split('.');
    return (CORNER_IDS as string[]).includes(root!) && (POINT_KEYS as readonly string[]).includes(pk!) && AXIS_KEYS.includes(ax!);
  };
  const { ranges, goals } = readRangesGoals(raw, d.goals, valid, rf);
  const opt = (k: 'lateralG' | 'brakingG' | 'accelG' | 'keepClose') => (raw[k] ? rf(raw[k], 'ratio', d[k], k) : d[k]);
  const zero = { text: '0', value: 0 };
  const cw = isObj(raw.caseWeights) ? Object.fromEntries((['lateral', 'braking', 'accel', 'combined'] as const)
    .filter((k) => typeof (raw.caseWeights as Json)[k] === 'number' && Number.isFinite((raw.caseWeights as Json)[k]))
    .map((k) => [k, Math.max(0, (raw.caseWeights as Json)[k] as number)])) : null;
  return {
    ranges, goals, lateralG: opt('lateralG'), brakingG: opt('brakingG'), accelG: opt('accelG'), keepClose: opt('keepClose'),
    ...(typeof raw.caseSource === 'string' ? { caseSource: raw.caseSource } : {}),
    ...(typeof raw.starts === 'number' && raw.starts > 1 ? { starts: Math.min(16, Math.round(raw.starts)) } : {}),
    ...(raw.combinedLatG ? { combinedLatG: rf(raw.combinedLatG, 'ratio', zero, 'braking-in-a-turn lateral g') } : {}),
    ...(raw.combinedBrakeG ? { combinedBrakeG: rf(raw.combinedBrakeG, 'ratio', zero, 'braking-in-a-turn braking g') } : {}),
    ...(cw && Object.keys(cw).length ? { caseWeights: cw } : {}),
  };
}

const AXIS_KEYS = ['x', 'y', 'z'];

/** Read the optimizer setups; anything unknown is dropped quietly (it's a setup, not the design). */
function readOptimizer(raw: unknown, warnings: string[]): Partial<Record<CornerId, OptimizerSetup>> {
  if (!isObj(raw)) return {};
  const out: Partial<Record<CornerId, OptimizerSetup>> = {};
  for (const id of CORNER_IDS) {
    const o = raw[id];
    if (!isObj(o)) continue;
    const d = defaultOptimizerSetup();
    const rf = (x: unknown, q: Quantity, fb: Field, where: string) => readField(x, q, fb, `optimizer ${id} ${where}`, warnings);
    const ranges: OptimizerSetup['ranges'] = {};
    for (const [k, r] of Object.entries(isObj(o.ranges) ? o.ranges : {})) {
      const [pk, ax] = k.split('.');
      // Point coordinates, setup values (scalar.…) and custom linkage points (custom.…).
      const ok = ((POINT_KEYS as readonly string[]).includes(pk!) && AXIS_KEYS.includes(ax!)) || /^scalar\.(staticCamber|staticToe|tirePressure)$/.test(k) || /^custom\..+\.(p|q)\.[xyz]$/.test(k);
      if (!ok || !isObj(r)) continue;
      ranges[k] = { lo: rf(r.lo, 'length', { text: '0', value: 0 }, `${k} min`), hi: rf(r.hi, 'length', { text: '0', value: 0 }, `${k} max`) };
    }
    const goals = d.goals;
    const gRaw = isObj(o.goals) ? o.goals : {};
    for (const k of Object.keys(goals) as (keyof typeof goals)[]) {
      const g = gRaw[k];
      if (!isObj(g)) continue;
      goals[k] = { on: g.on === true, target: rf(g.target, 'ratio', goals[k].target, `${k} target`), weight: rf(g.weight, 'ratio', goals[k].weight, `${k} weight`) };
    }
    out[id] = {
      ranges, goals,
      rollAngle: o.rollAngle ? rf(o.rollAngle, 'angle', d.rollAngle, 'roll angle') : d.rollAngle,
      rackCheck: o.rackCheck ? rf(o.rackCheck, 'length', d.rackCheck, 'rack check') : d.rackCheck,
      keepClose: o.keepClose ? rf(o.keepClose, 'ratio', d.keepClose, 'keep close') : d.keepClose,
      rollLoadFactor: o.rollLoadFactor ? rf(o.rollLoadFactor, 'ratio', d.rollLoadFactor, 'roll load factor') : d.rollLoadFactor,
      ...(typeof o.starts === 'number' && o.starts > 1 ? { starts: Math.min(16, Math.round(o.starts)) } : {}),
      ...(isObj(o.lengthRanges) ? { lengthRanges: Object.fromEntries((['uca', 'lca', 'tieRod'] as const).filter((k) => isObj((o.lengthRanges as Json)[k])).map((k) => {
        const r = (o.lengthRanges as Json)[k] as Json;
        return [k, { lo: rf(r.lo, 'length', { text: '0', value: 0 }, `${k} length min`), hi: rf(r.hi, 'length', { text: '0', value: 0 }, `${k} length max`) }];
      })) } : {}),
    };
  }
  return out;
}

export interface ImportResult {
  design: DesignState;
  name: string;
  warnings: string[];
  /** The file's saved test results (scores), by test id; empty when it has none. */
  results: Record<string, SavedResult>;
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

/** A custom linkage from a file: bodies, joints with numeric points (anything malformed is dropped with a warning). */
function readCustom(raw: unknown, where: string, w: string[]): CustomLinkage | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) { w.push(`${where}: not a linkage, ignored`); return undefined; }
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
  const vec = (v: unknown) => (isObj(v) ? { x: num(v.x), y: num(v.y), z: num(v.z) } : null);
  const ok = (v: { x: number; y: number; z: number } | null): v is { x: number; y: number; z: number } => !!v && [v.x, v.y, v.z].every(Number.isFinite);
  const bodies = (Array.isArray(raw.bodies) ? raw.bodies : []).filter(isObj)
    .filter((b) => typeof b.id === 'string' && typeof b.name === 'string').map((b) => ({ id: b.id as string, name: b.name as string }));
  const joints: CustomJoint[] = [];
  for (const j of Array.isArray(raw.joints) ? raw.joints : []) {
    if (!isObj(j)) continue;
    const kind = j.kind === 'ball' || j.kind === 'hinge' || j.kind === 'rod' || j.kind === 'cylinder' || j.kind === 'slider' ? j.kind : null;
    const p = vec(j.p), q = vec(j.q);
    if (!kind || typeof j.id !== 'string' || typeof j.a !== 'string' || typeof j.b !== 'string' || !ok(p) || (kind !== 'ball' && !ok(q))) {
      w.push(`${where}: a joint couldn't be read, dropped`);
      continue;
    }
    joints.push({ id: j.id, kind, name: typeof j.name === 'string' ? j.name : j.id, a: j.a, b: j.b, p, ...(kind !== 'ball' && ok(q) ? { q } : {}) });
  }
  return { bodies, joints, ...(typeof raw.damperBody === 'string' ? { damperBody: raw.damperBody } : {}) };
}

/** Steering-arm pivot 120 mm ahead of the inner tie-rod joint (for files from before format 20). */
function withPivotDefaults(points: CornerDesign['geom']['points'], missing: boolean): CornerDesign['geom']['points'] {
  if (!missing) return points;
  const v = (k: keyof typeof points, i: number) => points[k][i]!.value;
  const f = (x: number, y: number, z: number) => [x, y, z].map((n) => ({ text: String(Number(n.toFixed(3))), value: n })) as [Field, Field, Field];
  const [x, y, z] = [v('trInner', 0), v('trInner', 1), v('trInner', 2)];
  return { ...points, strPiv1: f(x, y - 60, z + 120), strPiv2: f(x, y + 90, z + 120) };
}

/** Center-link points around the inner tie-rod joint (for files from before format 31). */
function withLinkDefaults(points: CornerDesign['geom']['points'], missing: boolean): CornerDesign['geom']['points'] {
  if (!missing) return points;
  const i = { x: points.trInner[0].value, y: points.trInner[1].value, z: points.trInner[2].value };
  return { ...points, ...(centerLinkDefaults(i) as Record<'pitEnd' | 'idlPiv1' | 'idlPiv2' | 'idlEnd', [Field, Field, Field]>) };
}

/** Rocker points built from the coilover (for files from before format 19). */
function withRockerDefaults(points: CornerDesign['geom']['points']): CornerDesign['geom']['points'] {
  const v = (k: keyof typeof points) => ({ x: points[k][0].value, y: points[k][1].value, z: points[k][2].value });
  const lay = rockerFromCoilover(v('dmpChassis'), v('dmpArm'), 'lca').rocker;
  const f = (q: { x: number; y: number; z: number }) => [q.x, q.y, q.z].map((n) => ({ text: String(Number(n.toFixed(3))), value: n })) as [Field, Field, Field];
  return { ...points, rkrPiv1: f(lay.pivot1), rkrPiv2: f(lay.pivot2), prArm: f(lay.pushrodLower), prRkr: f(lay.pushrodUpper) };
}

function readCorner(raw: unknown, id: CornerId, def: CornerDesign, warnings: string[], original = FORMAT_VERSION): CornerDesign {
  const c = isObj(raw) ? raw : {};
  if (!isObj(raw)) warnings.push(`${id}: missing, using the default corner`);
  const w = isObj(raw) ? warnings : [];
  const pts = isObj(c.points) ? c.points : {};
  const points = { ...def.geom.points };
  let rockerMissing = false, pivotMissing = false, linkMissing = false;
  for (const k of POINT_KEYS) {
    const name = cornerParam(id, POINT_NAMES[k]);
    const p = pts[name];
    const obj = isObj(p) ? p : {};
    // Format 18 added the multilink's rear-link ends: older files start them at the joints quietly.
    if (!isObj(p) && (k === 'ucaOut2' || k === 'lcaOut2')) { points[k] = points[k === 'ucaOut2' ? 'ucaOut' : 'lcaOut']; continue; }
    // Format 19 added the rocker points: older files get a working rocker from their coilover, quietly.
    if (!isObj(p) && (k === 'rkrPiv1' || k === 'rkrPiv2' || k === 'prArm' || k === 'prRkr')) { rockerMissing = true; continue; }
    // Format 20 added the steering-arm pivot: older files get one ahead of the inner tie-rod joint, quietly.
    if (!isObj(p) && (k === 'strPiv1' || k === 'strPiv2')) { pivotMissing = true; continue; }
    // Format 24 added the Panhard rod (solid axle, 3-link): older files take the default, quietly.
    if (!isObj(p) && (k === 'phChs' || k === 'phAxle')) continue;
    // Format 31 added the center-link steering points: older files get them around the inner tie-rod joint, quietly.
    if (!isObj(p) && (k === 'pitEnd' || k === 'idlPiv1' || k === 'idlPiv2' || k === 'idlEnd')) { linkMissing = true; continue; }
    if (!isObj(p)) w.push(`${name}: missing, using default`);
    points[k] = (['x', 'y', 'z'] as const).map((ax, i) =>
      readField(obj[ax], 'length', def.geom.points[k][i]!, `${name}.${ax}`, isObj(p) ? w : [])) as [Field, Field, Field];
  }
  const sc = isObj(c.scalars) ? c.scalars : {};
  const scalars = Object.fromEntries(SCALAR_KEYS.map((k) => {
    const name = cornerParam(id, SCALAR_META[k].name);
    // Wheel offset and rim width came with format 15; a blank rim width = the tire's measuring rim.
    const raw = sc[name];
    if (k === 'rimWidth' && (raw === undefined || (isObj(raw) && (raw.text === '' || raw.value === null)))) return [k, { text: '', value: NaN }];
    if (k === 'wheelOffset' && raw === undefined) return [k, def.geom.scalars.wheelOffset];
    return [k, readField(raw, SCALAR_META[k].quantity, def.geom.scalars[k], name, w)];
  })) as CornerDesign['geom']['scalars'];
  const damperRaw = isObj(c.damper) ? c.damper : {};
  const tireRaw = isObj(c.tire) ? c.tire : {};
  const model = tireRaw.model === 'rigid' || tireRaw.model === 'stiffness' || tireRaw.model === 'gas' ? tireRaw.model : def.tireModel;
  return {
    geom: {
      points: withLinkDefaults(withPivotDefaults(rockerMissing ? withRockerDefaults(points) : points, pivotMissing), linkMissing), scalars,
      steerMechanism: c.steerMechanism === 'arm' || c.steerMechanism === 'centerLink' ? c.steerMechanism : 'rack',
      ...(c.steeredAxle === true ? { steeredAxle: true } : {}),
      ...(isObj(c.bushing) ? { bushing: { radial: readField(c.bushing.radial, 'rate', { text: '5000', value: 5000 }, `${id}.bushing.radial`, w), axial: readField(c.bushing.axial, 'rate', { text: '1500', value: 1500 }, `${id}.bushing.axial`, w) } } : {}),
      springLayout: c.springLayout === 'rocker' ? 'rocker' : 'coilover',
      pushrodOn: c.pushrodOn === 'uca' || c.pushrodOn === 'upright' ? c.pushrodOn : 'lca',
      damperArm: c.damperArm === 'uca' || c.damperArm === 'upright' ? c.damperArm : 'lca', kind: (SUSPENSION_KINDS as string[]).includes(c.type as string) ? c.type as SuspensionKind : 'doubleWishbone',
      ...(() => { const cl = readCustom(c.custom, `${id}.custom`, w); return cl ? { custom: cl } : {}; })() },
    spring: readRecord(c.spring, SPRING_KEYS, (k) => SPRING_META[k].quantity, def.spring, `${id}.spring`, w),
    // Damping rates are new in format 8: older files take the defaults quietly.
    damper: (() => {
      // Format 11 added the two-stage damper inputs: older files take the defaults quietly.
      const dw: string[] = [];
      const r = readRecord(damperRaw.fields, DAMPER_KEYS, (k) => DAMPER_META[k].quantity, def.damper, `${id}.damper`, dw);
      if (original >= 8) w.push(...dw.filter((x) => original >= 11 || !DAMPER_TWO_STAGE_KEYS.some((k) => x.startsWith(`${id}.damper.${k}`))));
      return r;
    })(),
    bumpStop: typeof damperRaw.bumpStop === 'boolean' ? damperRaw.bumpStop : def.bumpStop,
    damperMode: damperRaw.mode === 'twoStage' || damperRaw.mode === 'curve' ? damperRaw.mode : 'linear',
    // Format 36: dyno curves and a clicker (older files: none, quietly).
    ...(isObj(damperRaw.curve) ? { damperCurve: {
      softBump: String(damperRaw.curve.softBump ?? ''), softRebound: String(damperRaw.curve.softRebound ?? ''),
      firmBump: String(damperRaw.curve.firmBump ?? ''), firmRebound: String(damperRaw.curve.firmRebound ?? ''),
      clicks: Math.max(0, Math.round(Number(damperRaw.curve.clicks) || 0)), click: Math.max(0, Math.round(Number(damperRaw.curve.click) || 0)),
    } } : {}),
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
    ...(a.dropLinkOn === 'uca' || a.dropLinkOn === 'upright' || a.dropLinkOn === 'rocker' ? { dropLinkOn: a.dropLinkOn } : {}),
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
  const olderThan4 = original < 4;
  const cornersRaw = isObj(f.corners) ? f.corners : {};
  const corners = Object.fromEntries(CORNER_IDS.map((id) => [id, readCorner(cornersRaw[id], id, defCorner, warnings, original)])) as Record<CornerId, CornerDesign>;
  const linksRaw = isObj(f.links) ? f.links : {};
  const links: CornerLinks = {
    frontPair: typeof linksRaw.frontPair === 'boolean' ? linksRaw.frontPair : DEFAULT_LINKS.frontPair,
    rearPair: typeof linksRaw.rearPair === 'boolean' ? linksRaw.rearPair : DEFAULT_LINKS.rearPair,
    rearFromFront: typeof linksRaw.rearFromFront === 'boolean' ? linksRaw.rearFromFront : DEFAULT_LINKS.rearFromFront,
  };
  // A solid axle or twist beam is one part under both wheels, so its left and right corners share one design
  // (a file could have them apart): link them, keeping the axle's design (the left one's when both are axles).
  for (const [pair, l, r, name] of [['frontPair', 'FL', 'FR', 'front'], ['rearPair', 'RL', 'RR', 'rear']] as const) {
    if (links[pair] || (pair === 'rearPair' && links.rearFromFront)) continue;
    const kl = corners[l].geom.kind, kr = corners[r].geom.kind;
    if (!isOneAxle(kl) && !isOneAxle(kr)) continue;
    const from = isOneAxle(kl) ? 'left' : 'right';
    if (from === 'right') corners[l] = corners[r];
    links[pair] = true;
    warnings.push(`The ${name} ${SUSPENSION_LABELS[(from === 'left' ? kl : kr)!].toLowerCase()} is one axle under both wheels: its left and right corners now share the ${from} corner's design.`);
  }
  const settingsRaw = isObj(f.settings) ? f.settings : {};
  const settings = Object.fromEntries(CORNER_IDS.map((id) => {
    const r = isObj(settingsRaw[id]) ? settingsRaw[id] as Json : {};
    return [id, {
      steered: typeof r.steered === 'boolean' ? r.steered : DEFAULT_SETTINGS[id].steered,
      powered: typeof r.powered === 'boolean' ? r.powered : DEFAULT_SETTINGS[id].powered,
      brake: r.brake === 'none' || r.brake === 'inboard' || r.brake === 'outboard' ? r.brake : DEFAULT_SETTINGS[id].brake,
      drive: r.drive === 'hub' ? 'hub' : 'chassis',
      abs: typeof r.abs === 'boolean' ? r.abs : true,
      diff: r.diff === 'locked' || r.diff === 'lsd' ? r.diff : 'open',
    }];
  })) as Record<CornerId, CornerSettings>;
  const activeCorner = (CORNER_IDS as string[]).includes(String(f.activeCorner)) ? f.activeCorner as CornerId : 'FL';
  const vehicleRaw = isObj(f.vehicle) ? f.vehicle : {};
  const motion = isObj(f.motion) ? f.motion : {};
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d);

  const design: DesignState = {
    presetId: typeof f.presetId === 'string' ? f.presetId : 'custom',
    ...corners.FL, // replaced with the active corner's root below
    // The variable ratio came with format 20: older files keep a constant ratio quietly.
    // Format 23: the other mechanism's own steering values (older files: none, quietly).
    // Format 30: a measured steering ratio (older files: none, quietly).
    ...(typeof f.steeringCurve === 'string' && f.steeringCurve.trim() ? { steerCurve: f.steeringCurve } : {}),
    steerSaved: Object.fromEntries(Object.entries(isObj(f.steeringSaved) ? f.steeringSaved : {})
      .filter(([m, rec]) => (m === 'rack' || m === 'arm' || m === 'centerLink') && isObj(rec))
      .map(([m, rec]) => [m, readRecord(rec, MECH_STEER_KEYS, (k) => STEER_META[k].quantity, def.steer, `steering (${m})`, warnings)])) as DesignState['steerSaved'],
    steer: (() => {
      const w: string[] = [];
      const r = readRecord(f.steering, STEER_KEYS, (k) => STEER_META[k].quantity, def.steer, 'steering', w);
      const older = isObj(f.steering) && !('cFactorLock' in f.steering);
      warnings.push(...w.filter((x) => !(older && x.startsWith('steering.cFactorLock'))));
      return r;
    })(),
    droop: num(motion.droop, def.droop),
    bump: num(motion.bump, def.bump),
    driver: motion.driver === 'contactPatch' ? 'contactPatch' : 'wheelCenter',
    corners, links, settings, activeCorner,
    // Files upgraded from format 1 had no vehicle inputs: use the defaults quietly.
    vehicle: (() => {
      // Files before format 10 have no ride inputs: they take the defaults quietly.
      const w: string[] = [];
      const r = readRecord(vehicleRaw.fields, VEHICLE_KEYS, (k) => VEHICLE_META[k].quantity, def.vehicle, 'vehicle', w);
      if (!olderThan4) warnings.push(...w.filter((x) => (original >= 10 || !RIDE_KEYS.some((k) => x.startsWith(`vehicle.${k}`))) && (original >= 17 || !x.startsWith('vehicle.yawInertia')) && (original >= 34 || !x.startsWith('vehicle.relaxation'))));
      return r;
    })(),
    autoPreload: typeof vehicleRaw.autoPreload === 'boolean' ? vehicleRaw.autoPreload : def.autoPreload,
    cornerLoadMode: vehicleRaw.cornerLoadMode === 'manual' ? 'manual' : 'vehicle',
    shared: { front: readShared(f.shared, 'front', older ? [] : warnings), rear: readShared(f.shared, 'rear', older ? [] : warnings) },
    locks: Object.fromEntries((Array.isArray(f.locks) ? f.locks : []).filter((k): k is string => typeof k === 'string').map((k) => [k, true as const])),
    wizardLocks: Object.fromEntries(Object.entries(isObj(f.wizardLocks) ? f.wizardLocks : {})
      .filter(([k, v]) => Array.isArray(f.locks) && f.locks.includes(k) && (v === 'profile' || (SETUP_STEPS as readonly string[]).includes(v as string)))) as DesignState['wizardLocks'],
    optimizer: readOptimizer(f.optimizer, warnings),
    vehicleOptimizer: readVehicleOptimizer(f.vehicleOptimizer, warnings),
    grip: isObj(f.grip) ? readRecord(f.grip, GRIP_KEYS, (k) => GRIP_META[k].quantity, defaultGrip(), 'grip', warnings) : defaultGrip(),
    // Missing coefficients take the generic defaults quietly (a migrated file carries only the ones it changed).
    tireGrip: isObj(f.tireGrip) ? readRecord(f.tireGrip, MF_KEYS, (k) => MF_META[k].quantity, defaultTireGrip(), 'tire grip', []) : defaultTireGrip(),
    tireFile: readTireFile(f.tireFile, warnings),
    tireFileRear: f.tireFileRear === 'simple' ? 'simple' : readTireFile(f.tireFileRear, warnings),
    aero: (() => {
      const a = isObj(f.aero) ? f.aero : {};
      const fields = readRecord(a.fields, AERO_KEYS, (k) => AERO_META[k].quantity, defaultAero(), 'aero', isObj(f.aero) ? warnings : []);
      // A saved aero file goes through the importer again (checks it).
      const file = isObj(a.file) ? parseAero(JSON.stringify(a.file), typeof a.file.name === 'string' ? a.file.name : 'aero').model : null;
      return { ...fields, on: a.on === true, file };
    })(),
    // A set ride height came with format 48: older files rest at the design position.
    rideHeight: (() => {
      const r = isObj(f.rideHeight) ? f.rideHeight : {};
      const num = (x: unknown, dflt: number) => (isObj(x) && typeof x.value === 'number' && Number.isFinite(x.value) ? { text: typeof x.text === 'string' ? x.text : String(x.value), value: x.value } : { text: String(dflt), value: dflt });
      return { on: r.on === true, front: num(r.front, 100), rear: num(r.rear, 100) };
    })(),
    // The powertrain came with format 45: older files have none (only the tires limit the drive), quietly.
    powertrain: (() => {
      const a = isObj(f.powertrain) ? f.powertrain : {};
      const fields = readRecord(a.fields, PT_KEYS, (k) => PT_META[k].quantity, defaultPowertrain(), 'powertrain', isObj(f.powertrain) ? warnings : []);
      return { ...fields, kind: a.kind === 'electric' || a.kind === 'gas' ? a.kind : 'none' } as PowertrainSettings;
    })(),
    // Brake hydraulics came with format 21: older files have them off, quietly.
    brakes: (() => {
      const b = isObj(f.brakes) ? f.brakes : {};
      const fields = readRecord(b.fields, BRAKE_KEYS, (k) => BRAKE_META[k].quantity, defaultBrakes(), 'brakes', isObj(f.brakes) ? warnings : []);
      // Brake fade came with format 25: older files have it off, quietly.
      const fd = isObj(b.fade) ? b.fade : {};
      const fade = readRecord(fd.fields, FADE_KEYS, (k) => FADE_META[k].quantity, defaultBrakes(), 'brakes.fade', isObj(b.fade) ? warnings : []);
      // Drums, wheel room, detailed hydraulics and the ladder came with format 39: older files get discs, the simple model, quietly.
      const mo = isObj(b.more) ? b.more : {};
      const more = readRecord(mo.fields, BRAKE_MORE_KEYS, (k) => BRAKE_MORE_META[k].quantity, defaultBrakes(), 'brakes.more', isObj(b.more) ? warnings : []);
      return {
        ...fields, ...fade, ...more, on: b.on === true, fade: fd.on === true, dualMc: b.dualMc === true, useBias: b.useBias === true,
        drumF: mo.drumF === true, drumR: mo.drumR === true, detail: mo.detail === true, allowDiscF: mo.allowDiscF === true, allowDiscR: mo.allowDiscR === true,
      };
    })(),
    // Shimmy came with format 41: older files get the defaults, quietly.
    shimmy: (() => {
      const m = isObj(f.shimmy) ? f.shimmy : {};
      return { ...readRecord(m.fields, SHIMMY_KEYS, (k) => SHIMMY_META[k].quantity, defaultShimmy(), 'shimmy', isObj(f.shimmy) ? warnings : []), check: m.check !== false, handsOn: m.handsOn !== false };
    })(),
    // Towing came with format 22: older files have no trailer, quietly.
    tow: (() => {
      const t = isObj(f.tow) ? f.tow : {};
      return { ...readRecord(t.fields, TOW_KEYS, (k) => TOW_META[k].quantity, defaultTow(), 'tow', isObj(f.tow) ? warnings : []), on: t.on === true };
    })(),
    ...(['track', 'road', 'offroad', 'drift', 'towing', 'drag'].includes(f.useCase as string) ? { useCase: f.useCase as DesignState['useCase'] } : {}),
    setupStatus: Object.fromEntries(Object.entries(isObj(f.setupStatus) ? f.setupStatus : {})
      .filter(([k, v]) => (SETUP_STEPS as readonly string[]).includes(k) && (v === 'entered' || v === 'estimated'))) as DesignState['setupStatus'],
    dimensions: readDimensions(f.dimensions, warnings),
    tests: readTests(f.tests, warnings),
  };
  Object.assign(design, corners[rootOf(activeCorner, links)]);
  return { design, name: typeof f.name === 'string' && f.name ? f.name : 'Imported layout', warnings, results: readResults(f.results) };
}
