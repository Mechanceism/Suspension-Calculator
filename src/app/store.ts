/**
 * UI state. Geometry fields keep the text the user typed (e.g. "5in") alongside the parsed
 * base-unit value (mm / deg), per GOALS.md § Units.
 */
import { create } from 'zustand';
import { parseValue, formatValue, type Quantity } from '../core/units/units';
import { vec3, type Vec3 } from '../core/math/vec3';
import { customFromWishbone, type CustomLinkage } from '../core/suspension/customLinkage';
import { parseSteerCurve } from '../core/tests/steer';
import { DoubleWishbone, spinAxisFromCamberToe, SUSPENSION_LABELS, virtualPivot, isBeam, isOneAxle, type DoubleWishboneGeometry, type TravelDriver, type SuspensionKind } from '../core/suspension/doubleWishbone';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING, PRESET_LAYOUTS } from '../examples/sampleLayouts';
import { fitFreeLength } from '../core/suspension/spring';
import { rockerFromCoilover } from '../core/suspension/coilover';
import { CORNER_IDS, staticCornerLoads, type CornerId, type BrakeMount, type ChassisPose } from '../core/vehicle/vehicle';
import { setArmLength, setPivotInclination, setPivotPlanAngle, setArmFrontViewAngle, transferArmPoint } from '../core/suspension/armGeometry';
import { add, sub } from '../core/math/vec3';
import type { TireProfile } from '../core/tire/geometry';
import type { TireForceModel } from '../core/tire/model';
import { parseTireSize } from '../core/tire/size';
import { GOAL_KINDS, GOAL_META, type GoalKind } from '../core/optimize/corner';
import { VEHICLE_GOAL_KINDS, VEHICLE_GOAL_META, type VehicleGoalKind, type FixedCaseKind } from '../core/optimize/vehicle';
import { DEFAULT_GRIP } from '../core/tire/grip';
import { DEFAULT_MF, type MFCoeffs } from '../core/tire/magicFormula';
import type { TirModel } from '../core/tire/tir';
import type { AeroModel } from '../core/vehicle/aero';
import type { DimMeasure } from '../core/suspension/dimensions';
import type { TestDesign } from './tests';

export interface Field {
  text: string;
  /** Base units (mm or deg). */
  value: number;
  error?: string;
}

/** Hardpoints of every suspension type (each type uses some of them: activePointKeys). */
export const POINT_KEYS = ['ucaFwd', 'ucaAft', 'ucaOut', 'lcaFwd', 'lcaAft', 'lcaOut', 'trInner', 'trOuter', 'wheelCenter', 'dmpChassis', 'dmpArm', 'ucaOut2', 'lcaOut2', 'rkrPiv1', 'rkrPiv2', 'prArm', 'prRkr', 'strPiv1', 'strPiv2', 'phChs', 'phAxle', 'pitEnd', 'idlPiv1', 'idlPiv2', 'idlEnd'] as const;
/**
 * Steering mechanism: a rack (input = rack travel, mm), a steering arm / plate on a pivot (input = its angle, °),
 * or a pitman arm, idler arm and center link (input = the pitman's angle, °; the inner tie-rod joint is on the link).
 */
export type SteerMechanism = 'rack' | 'arm' | 'centerLink';
/** The steering input is an angle (°), not rack travel (mm). */
export const angleInput = (m: SteerMechanism | undefined) => m === 'arm' || m === 'centerLink';
const CENTER_LINK_KEYS = ['pitEnd', 'idlPiv1', 'idlPiv2', 'idlEnd'] as const;
/** Spring layout: a coilover between the frame and an arm / the knuckle, or a pushrod / pullrod and rocker. */
export type SpringLayout = 'coilover' | 'rocker';
const ROCKER_KEYS = ['rkrPiv1', 'rkrPiv2', 'prArm', 'prRkr'] as const;
export type PointKey = (typeof POINT_KEYS)[number];

/** Parameter names follow GOALS.md § Parameter Naming. */
export const POINT_NAMES: Record<PointKey, string> = {
  ucaFwd: 'FL_UCA_Fwd', ucaAft: 'FL_UCA_Aft', ucaOut: 'FL_UCA_Out',
  lcaFwd: 'FL_LCA_Fwd', lcaAft: 'FL_LCA_Aft', lcaOut: 'FL_LCA_Out',
  trInner: 'FL_TR_In', trOuter: 'FL_TR_Out', wheelCenter: 'FL_Hub_Ctr',
  dmpChassis: 'FL_Dmp_Chs', dmpArm: 'FL_Dmp_Arm',
  ucaOut2: 'FL_UCA_Out2', lcaOut2: 'FL_LCA_Out2',
  rkrPiv1: 'FL_Rkr_Piv1', rkrPiv2: 'FL_Rkr_Piv2', prArm: 'FL_PR_Arm', prRkr: 'FL_PR_Rkr',
  strPiv1: 'FL_Str_Piv1', strPiv2: 'FL_Str_Piv2',
  pitEnd: 'FL_Pitman_End', idlPiv1: 'FL_Idler_Piv1', idlPiv2: 'FL_Idler_Piv2', idlEnd: 'FL_Idler_End',
  phChs: 'FL_PH_Chs', phAxle: 'FL_PH_Axle',
};

/** Parameter name of a hardpoint or scalar for a corner (FL_UCA_Fwd → RR_UCA_Fwd). */
export const forCorner = (corner: string, flName: string) => flName.replace(/^FL_/, `${corner}_`);
/** Hook-free helper for components: the active corner's parameter name. */
export const activeParam = (flName: string) => forCorner(useApp.getState().activeCorner, flName);

export const SCALAR_KEYS = ['staticCamber', 'staticToe', 'tireDiameter', 'tireWidth', 'rimDiameter', 'shoulderRadius', 'wheelOffset', 'rimWidth'] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];
export const SCALAR_META: Record<ScalarKey, { name: string; quantity: Quantity; label: string }> = {
  staticCamber: { name: 'FL_Whl_Camber', quantity: 'angle', label: 'Static camber' },
  staticToe: { name: 'FL_Whl_Toe', quantity: 'angle', label: 'Static toe (+ in)' },
  tireDiameter: { name: 'FL_Tire_Dia', quantity: 'length', label: 'Outer diameter' },
  tireWidth: { name: 'FL_Tire_Wid', quantity: 'length', label: 'Section width' },
  rimDiameter: { name: 'FL_Rim_Dia', quantity: 'length', label: 'Rim diameter' },
  shoulderRadius: { name: 'FL_Tire_Shldr', quantity: 'length', label: 'Shoulder radius' },
  wheelOffset: { name: 'FL_Whl_Offset', quantity: 'length', label: 'Wheel offset (ET)' },
  rimWidth: { name: 'FL_Rim_Wid', quantity: 'length', label: 'Rim width (blank = the tire\'s measuring rim)' },
};

/** Measuring rim the tire's section width refers to, mm (≈ 0.8 × section width, to the nearest ½"). */
export const measuringRim = (sectionWidth: number) => Math.round((0.8 * sectionWidth) / 12.7) * 12.7;

/**
 * Tire section width on the rim it is mounted on, mm: about 5 mm wider per ½" (12.7 mm) of rim width over
 * the measuring rim (and narrower under it). A blank rim width = the measuring rim.
 */
export function mountedTireWidth(s: Record<ScalarKey, Field>): number {
  const w = s.tireWidth.value;
  const rim = s.rimWidth.value;
  return Number.isFinite(rim) && rim > 0 ? Math.max(0.5 * w, w + 0.4 * (rim - measuringRim(w))) : w;
}

/** Tire load / force-model inputs (docs/MATH.md § L4). */
export const TIRE_KEYS = ['rate', 'pressure', 'setAltitude', 'setTemperature', 'opAltitude', 'opTemperature', 'volumeFactor'] as const;
export type TireKey = (typeof TIRE_KEYS)[number];
export const TIRE_META: Record<TireKey, { label: string; quantity: Quantity; unit: string; initial: number; models: TireModelKind[] }> = {
  rate: { label: 'Vertical stiffness', quantity: 'rate', unit: 'N/mm', initial: 120, models: ['stiffness'] },
  pressure: { label: 'Set pressure (gauge)', quantity: 'pressure', unit: 'kPa', initial: 82.737, models: ['gas'] },
  setAltitude: { label: 'Set at altitude', quantity: 'altitude', unit: 'm', initial: 0, models: ['gas'] },
  setTemperature: { label: 'Set at temperature', quantity: 'temperature', unit: '°C', initial: 20, models: ['gas'] },
  opAltitude: { label: 'Driving altitude', quantity: 'altitude', unit: 'm', initial: 0, models: ['gas'] },
  opTemperature: { label: 'Driving temperature', quantity: 'temperature', unit: '°C', initial: 20, models: ['gas'] },
  volumeFactor: { label: 'Volume-loss factor', quantity: 'ratio', unit: '×', initial: 1, models: ['gas'] },
};
export type TireModelKind = 'rigid' | 'stiffness' | 'gas';

/** Spring and corner load inputs (docs/MATH.md § L5). */
export const SPRING_KEYS = ['cornerLoad', 'unsprungMass', 'springRate', 'freeLength'] as const;
export type SpringKey = (typeof SPRING_KEYS)[number];
export const SPRING_META: Record<SpringKey, { label: string; name: string; quantity: Quantity; unit: string }> = {
  cornerLoad: { label: 'Corner load (static, at tire)', name: 'FL_Load', quantity: 'force', unit: 'N' },
  unsprungMass: { label: 'Unsprung mass', name: 'FL_Mass_Unsprung', quantity: 'mass', unit: 'kg' },
  springRate: { label: 'Spring rate', name: 'FL_Sprg_Rate', quantity: 'rate', unit: 'N/mm' },
  freeLength: { label: 'Spring free length', name: 'FL_Sprg_FreeLen', quantity: 'length', unit: 'mm' },
};
/** Where a double wishbone's coilover lower mount is: an arm or the upright (knuckle). */
export type ArmChoice = 'lca' | 'uca' | 'upright';
export type CornerMode = 'kinematic' | 'loaded';
const G = 9.80665;
/** Load the spring carries: (corner load − unsprung weight) × load factor. */
export const sprungLoad = (f: Record<SpringKey, Field>, loadFactor: number) =>
  Math.max(0, (f.cornerLoad.value - f.unsprungMass.value * G) * loadFactor);

/** Damper stroke and bump stop (docs/MATH.md § L5). */
export const DAMPER_KEYS = ['maxLength', 'minLength', 'bumpStopLength', 'bumpStopRate', 'bumpDamping', 'reboundDamping', 'bumpDampingHigh', 'reboundDampingHigh', 'bumpKnee', 'reboundKnee'] as const;
/** Damper inputs only the two-stage damper uses. */
export const DAMPER_TWO_STAGE_KEYS = ['bumpDampingHigh', 'reboundDampingHigh', 'bumpKnee', 'reboundKnee'] as const;
/** Damper force curve: one rate per direction (linear), or two-stage (low-speed rate up to a knee, then a high-speed rate). */
export type DamperMode = 'linear' | 'twoStage' | 'curve';
/** Dyno curves ('shaft speed mm/s, force N' per line): full soft, and optionally full firm with a clicker between. */
export interface DamperCurveText { softBump: string; softRebound: string; firmBump: string; firmRebound: string; clicks: number; click: number }
export const DEFAULT_DAMPER_CURVE: DamperCurveText = {
  softBump: '25, 120\n50, 220\n100, 330\n200, 450\n400, 640', softRebound: '25, 200\n50, 380\n100, 560\n200, 760\n400, 1050',
  firmBump: '', firmRebound: '', clicks: 0, click: 0,
};
export type DamperKey = (typeof DAMPER_KEYS)[number];
export const DAMPER_META: Record<DamperKey, { label: string; quantity: Quantity; unit: string }> = {
  maxLength: { label: 'Damper fully extended', quantity: 'length', unit: 'mm' },
  minLength: { label: 'Damper fully compressed', quantity: 'length', unit: 'mm' },
  bumpStopLength: { label: 'Bump stop engages at', quantity: 'length', unit: 'mm' },
  bumpStopRate: { label: 'Bump stop rate', quantity: 'rate', unit: 'N/mm' },
  bumpDamping: { label: 'Damping, bump (compression)', quantity: 'damping', unit: 'N·s/m' },
  reboundDamping: { label: 'Damping, rebound (extension)', quantity: 'damping', unit: 'N·s/m' },
  bumpDampingHigh: { label: 'Bump, high speed (past the knee)', quantity: 'damping', unit: 'N·s/m' },
  reboundDampingHigh: { label: 'Rebound, high speed (past the knee)', quantity: 'damping', unit: 'N·s/m' },
  bumpKnee: { label: 'Bump knee (shaft speed)', quantity: 'ratio', unit: 'm/s' },
  reboundKnee: { label: 'Rebound knee (shaft speed)', quantity: 'ratio', unit: 'm/s' },
};

/** Steering system and tire-force inputs (docs/MATH.md § Steering). */
export const STEER_KEYS = ['cFactor', 'cFactorLock', 'rackLimit', 'lateral', 'longitudinal', 'pneumaticTrail', 'mu', 'effortG'] as const;
/** Steering values that belong to a mechanism (their units change with it): each mechanism keeps its own. */
export const MECH_STEER_KEYS = ['cFactor', 'cFactorLock', 'rackLimit'] as const;
export type MechSteerKey = (typeof MECH_STEER_KEYS)[number];
export type SteerKey = (typeof STEER_KEYS)[number];
export const STEER_META: Record<SteerKey, { label: string; quantity: Quantity; unit: string; initial: number; hint?: string }> = {
  cFactor: { label: 'Rack travel per steering-wheel rev', quantity: 'length', unit: 'mm/rev', initial: 75 },
  cFactorLock: { label: 'Same at full lock (variable ratio; 0 = constant)', quantity: 'length', unit: 'mm/rev', initial: 0, hint: 'A variable-ratio rack or geared cam: the steering gets quicker (larger) or slower toward lock; in between it changes linearly with the travel.' },
  rackLimit: { label: 'Rack travel limit (±)', quantity: 'length', unit: 'mm', initial: 30 },
  lateral: { label: 'Lateral tire force (+ outboard)', quantity: 'force', unit: 'N', initial: 0 },
  longitudinal: { label: 'Longitudinal tire force (+ drive, − brake)', quantity: 'force', unit: 'N', initial: 0 },
  pneumaticTrail: { label: 'Pneumatic trail', quantity: 'length', unit: 'mm', initial: 0 },
  mu: { label: 'Tire friction μ (parking)', quantity: 'ratio', unit: '×', initial: 1 },
  effortG: { label: 'Effort check at (lateral g)', quantity: 'ratio', unit: 'g', initial: 0.5, hint: 'The steering-effort-at-speed goal holds the front wheels at this lateral acceleration (side force = g × tire load on each wheel).' },
};

export const ARM_DERIVED = ['length', 'inclination', 'planAngle', 'frontViewAngle'] as const;
export type ArmDerived = (typeof ARM_DERIVED)[number];

export type ComponentId = 'chassis' | 'uca' | 'lca' | 'upright' | 'tieRod' | 'rack' | 'spring' | 'wheel';
export type Selection =
  | { kind: 'component'; id: ComponentId }
  | { kind: 'point'; id: PointKey }
  | { kind: 'points'; ids: PointKey[] }
  | null;

/** Hardpoints covered by a selection (for moving / highlighting). */
export const selectedPoints = (sel: Selection, partPoints: (id: ComponentId) => PointKey[]): PointKey[] =>
  !sel ? [] : sel.kind === 'point' ? [sel.id] : sel.kind === 'points' ? sel.ids : partPoints(sel.id);
/** Where the first measure pick was (to refuse picking the same place again). */
let firstMeasurePos: Vec3 | null = null;

/** Anything the measure tool can snap to: a hardpoint or a derived point. */
export type AnchorId = PointKey | 'contact' | 'patchCentroid' | 'axisGround' | 'rollCenter' | 'frontViewIC';

export interface EditableGeometry {
  points: Record<PointKey, [Field, Field, Field]>;
  /** Suspension type (default double wishbone). */
  kind: SuspensionKind;
  /** Coilover, or pushrod / pullrod + rocker (then dmpArm is the spring's end on the rocker). */
  springLayout?: SpringLayout;
  /** Rocker layout: what the pushrod's lower end is on. */
  pushrodOn?: ArmChoice;
  /** Steering mechanism (the same for every design: the input's units are shared). */
  steerMechanism?: SteerMechanism;
  scalars: Record<ScalarKey, Field>;
  /** Which arm the coilover's lower mount is attached to. */
  damperArm: ArmChoice;
  /** Arm pivot bushings (compliance steer / camber), radial and axial N/mm; absent = typical rubber (5000 / 1500). */
  bushing?: { radial: Field; axial: Field };
  /** Solid axle: steered (kingpins UCA_Out2 / LCA_Out2 on the axle, knuckle arm TR_Out, drag link from TR_In). */
  steeredAxle?: boolean;
  /** Custom linkage: its bodies and joints (mm; kept when switching to another type and back). */
  custom?: CustomLinkage;
}

export const VIS_KEYS = [
  'chassis', 'uca', 'lca', 'upright', 'tieRod', 'wheel',
  'spring', 'patch', 'steeringAxis', 'icConstruction', 'rollCenter', 'ground', 'datum', 'labels', 'dimensions', 'ackermann',
  'cg', 'arb', 'markerLabels',
] as const;
export type VisKey = (typeof VIS_KEYS)[number];

export type ViewName = 'front' | 'rear' | 'outboard' | 'inboard' | 'top' | 'bottom' | 'iso';
export type FocusKey = ComponentId | 'corner' | 'contact';

const field = (value: number, quantity: Quantity = 'length'): Field => ({ text: formatValue(value, quantity), value });
const fields = (v: Vec3): [Field, Field, Field] => [field(v.x), field(v.y), field(v.z)];

export function editableFromLayout(id: string): EditableGeometry {
  return editableFromGeometry((PRESET_LAYOUTS.find((l) => l.id === id) ?? SAMPLE_LAYOUTS[0]!).geometry);
}

/** Editable fields for a geometry (static camber / toe 0, a 13 in rim: set the scalars after if needed). */
export function editableFromGeometry(g: DoubleWishboneGeometry): EditableGeometry {
  return {
    points: {
      ucaFwd: fields(g.uca.fwd), ucaAft: fields(g.uca.aft), ucaOut: fields(g.uca.out),
      lcaFwd: fields(g.lca.fwd), lcaAft: fields(g.lca.aft), lcaOut: fields(g.lca.out),
      trInner: fields(g.tieRod.inner), trOuter: fields(g.tieRod.outer),
      wheelCenter: fields(g.wheel.center),
      dmpChassis: fields(g.damper?.chassis ?? vec3(300, 380, 30)),
      dmpArm: fields(g.damper?.armPoint ?? vec3(480, 45, 30)),
      ucaOut2: fields(g.uca.out2 ?? g.uca.out),
      lcaOut2: fields(g.lca.out2 ?? g.lca.out),
      ...rockerDefaults(g.damper?.chassis ?? vec3(300, 380, 30), g.damper?.armPoint ?? vec3(480, 45, 30), g.rocker),
      ...steerArmDefaults(g),
      ...centerLinkDefaults(g.tieRod.inner, g.steering?.kind === 'centerLink' ? g.steering : undefined),
      phChs: fields(g.panhard?.chassis ?? vec3(-(g.wheel.center.x - 250), g.wheel.center.y + 60, g.wheel.center.z - 80)),
      phAxle: fields(g.panhard?.axle ?? vec3(g.wheel.center.x - 200, g.wheel.center.y + 60, g.wheel.center.z - 80)),
    },
    steerMechanism: g.steering?.kind === 'arm' ? 'arm' : g.steering?.kind === 'centerLink' ? 'centerLink' : 'rack',
    springLayout: g.rocker ? 'rocker' : 'coilover',
    pushrodOn: g.rocker?.pushrodBody === 'uca' || g.rocker?.pushrodBody === 'upright' ? g.rocker.pushrodBody : 'lca',
    kind: g.kind ?? 'doubleWishbone',
    ...(g.steeredAxle ? { steeredAxle: true } : {}),
    damperArm: g.damper?.arm === 'uca' || g.damper?.arm === 'upright' ? g.damper.arm : 'lca',
    scalars: {
      staticCamber: field(0, 'angle'),
      staticToe: field(0, 'angle'),
      tireDiameter: field(2 * g.wheel.radius),
      tireWidth: field(g.wheel.width ?? 200),
      rimDiameter: { text: '13in', value: 13 * 25.4 },
      shoulderRadius: field(25),
      wheelOffset: field(0),
      rimWidth: { text: '', value: NaN },
    },
  };
}

/** Rocker points: the given rocker, or a working one built from the coilover (rockerFromCoilover). */
function rockerDefaults(chassis: Vec3, lower: Vec3, r?: DoubleWishboneGeometry['rocker']): Record<(typeof ROCKER_KEYS)[number], [Field, Field, Field]> {
  const lay = r ?? rockerFromCoilover(chassis, lower, 'lca').rocker;
  return { rkrPiv1: fields(lay.pivot1), rkrPiv2: fields(lay.pivot2), prArm: fields(lay.pushrodLower), prRkr: fields(lay.pushrodUpper) };
}

/**
 * Steering-arm pivot: given, or an upright axis 120 mm ahead of the inner tie-rod joint (the arm points back
 * from it, so the joint swings across the car much like on a rack).
 */
export function steerArmDefaults(g: DoubleWishboneGeometry): Record<'strPiv1' | 'strPiv2', [Field, Field, Field]> {
  if (g.steering?.kind === 'arm') return { strPiv1: fields(g.steering.pivot1), strPiv2: fields(g.steering.pivot2) };
  const i = g.tieRod.inner;
  return { strPiv1: fields(vec3(i.x, i.y - 60, i.z + 120)), strPiv2: fields(vec3(i.x, i.y + 90, i.z + 120)) };
}

/**
 * Center-link steering points: given, or a parallelogram around the inner tie-rod joint: the pitman's ball end
 * 60 mm inboard of it on the center link, the pitman 150 mm long pointing back from an upright pivot axis
 * ahead; the idler arm the mirror image on the other side, so the link slides across the car as the pitman turns.
 */
export function centerLinkDefaults(i: Vec3, given?: { pivot1: Vec3; pivot2: Vec3; pitmanEnd: Vec3; idlerPivot1: Vec3; idlerPivot2: Vec3; idlerEnd: Vec3 }): Record<'strPiv1' | 'strPiv2' | 'pitEnd' | 'idlPiv1' | 'idlPiv2' | 'idlEnd', [Field, Field, Field]> | Record<'pitEnd' | 'idlPiv1' | 'idlPiv2' | 'idlEnd', [Field, Field, Field]> {
  if (given) return { strPiv1: fields(given.pivot1), strPiv2: fields(given.pivot2), pitEnd: fields(given.pitmanEnd), idlPiv1: fields(given.idlerPivot1), idlPiv2: fields(given.idlerPivot2), idlEnd: fields(given.idlerEnd) };
  const ax = i.x - 60;
  return {
    pitEnd: fields(vec3(ax, i.y, i.z)),
    idlEnd: fields(vec3(-ax, i.y, i.z)), idlPiv1: fields(vec3(-ax, i.y - 60, i.z + 150)), idlPiv2: fields(vec3(-ax, i.y + 90, i.z + 150)),
  };
}

/** Rocker layouts are for types with an arm or knuckle to push from. */
export const rockerAllowed = (kind: SuspensionKind) => kind !== 'macpherson' && kind !== 'rigid' && !isBeam(kind);
export const layoutOf = (e: Pick<EditableGeometry, 'kind' | 'springLayout'>): SpringLayout => (e.springLayout === 'rocker' && rockerAllowed(e.kind ?? 'doubleWishbone') ? 'rocker' : 'coilover');

export function toGeometry(e: EditableGeometry): DoubleWishboneGeometry {
  const p = (k: PointKey) => vec3(e.points[k][0].value, e.points[k][1].value, e.points[k][2].value);
  const s = e.scalars;
  const spinAxis = spinAxisFromCamberToe((s.staticCamber.value * Math.PI) / 180, (s.staticToe.value * Math.PI) / 180);
  // The stored point is the hub's mounting face; the tire's centerline sits the wheel offset (ET) inboard of it.
  const et = Number.isFinite(s.wheelOffset.value) ? s.wheelOffset.value : 0;
  const hub = p('wheelCenter');
  const kind = e.kind ?? 'doubleWishbone';
  // Second upright points: the multilink's rear links, or a steered solid axle's kingpin (top / bottom).
  const ml = kind === 'multilink' || (isBeam(kind) && !!e.steeredAxle);
  return {
    kind,
    uca: { fwd: p('ucaFwd'), aft: p('ucaAft'), out: p('ucaOut'), ...(ml ? { out2: p('ucaOut2') } : {}) },
    lca: { fwd: p('lcaFwd'), aft: p('lcaAft'), out: p('lcaOut'), ...(ml ? { out2: p('lcaOut2') } : {}) },
    tieRod: { inner: p('trInner'), outer: p('trOuter') },
    ...(e.steerMechanism === 'arm' ? { steering: { kind: 'arm' as const, pivot1: p('strPiv1'), pivot2: p('strPiv2') } } : {}),
    ...(e.steerMechanism === 'centerLink' ? { steering: { kind: 'centerLink' as const, pivot1: p('strPiv1'), pivot2: p('strPiv2'), pitmanEnd: p('pitEnd'), idlerPivot1: p('idlPiv1'), idlerPivot2: p('idlPiv2'), idlerEnd: p('idlEnd') } } : {}),
    ...(kind === 'beam3' || kind === 'beamWatts' ? { panhard: { chassis: p('phChs'), axle: p('phAxle') } } : {}),
    ...(isBeam(kind) && e.steeredAxle ? { steeredAxle: true } : {}),
    ...(kind === 'custom' && e.custom ? { custom: e.custom } : {}),
    wheel: {
      center: vec3(hub.x - et * spinAxis.x, hub.y - et * spinAxis.y, hub.z - et * spinAxis.z),
      spinAxis,
      radius: s.tireDiameter.value / 2,
      width: mountedTireWidth(s),
    },
    // MacPherson: the damper is the strut (its lower point is on the upright); multilink: on the upright;
    // no suspension: no spring or damper.
    // Single arm: on the arm (lca) or the knuckle.
    ...(kind === 'rigid' ? {} : layoutOf(e) === 'rocker'
      ? {
        damper: { chassis: p('dmpChassis'), arm: 'rocker' as const, armPoint: p('dmpArm') },
        rocker: { pivot1: p('rkrPiv1'), pivot2: p('rkrPiv2'), pushrodBody: e.pushrodOn ?? 'lca', pushrodLower: p('prArm'), pushrodUpper: p('prRkr') },
      }
      : { damper: { chassis: p('dmpChassis'), arm: kind === 'doubleWishbone' ? e.damperArm : kind === 'singleArm' ? (e.damperArm === 'upright' ? 'upright' : 'lca') : 'upright', armPoint: p('dmpArm') } }),
  };
}

/** Is the rack (tie-rod inner joint) ahead of the axle (wheel center)? */
export const rackAhead = (e: EditableGeometry) => e.points.trInner[2].value > e.points.wheelCenter[2].value;

/**
 * The steering rack moved to the other side of the axle. The steering arm (steering axis → tie-rod outer
 * joint) is reflected through the steering axis in top view, so it lies on the same line: the classic
 * Ackermann lines keep pointing where they did. The tie rod keeps its length and direction (the inner
 * joint moves with the outer one).
 */
export function flipRackSide(e: EditableGeometry): EditableGeometry {
  const s = new DoubleWishbone(toGeometry(e)).design();
  const p = (k: PointKey) => vec3(e.points[k][0].value, e.points[k][1].value, e.points[k][2].value);
  const out = p('trOuter'), inn = p('trInner');
  const lo = s.points.steerLower, up = s.points.steerUpper;
  const t = Math.abs(up.y - lo.y) > 1e-9 ? (out.y - lo.y) / (up.y - lo.y) : 0;
  const K = vec3(lo.x + t * (up.x - lo.x), out.y, lo.z + t * (up.z - lo.z));
  const out2 = vec3(2 * K.x - out.x, out.y, 2 * K.z - out.z);
  const in2 = vec3(out2.x - (out.x - inn.x), inn.y, out2.z - (out.z - inn.z));
  return { ...e, points: { ...e.points, trOuter: fields(out2), trInner: fields(in2) } };
}

/** Hardpoints a suspension type (and spring layout) uses, in table order. */
/**
 * Default points for a steered solid axle around the hub: the kingpin 125 mm inboard with ~7° of KPI and
 * 4° of caster; the knuckle arm 150 mm behind it, angled in toward the rear axle's center (Ackermann);
 * the drag link's steering end near the centerline at the arm's height.
 */
export function steeredAxlePoints(e: EditableGeometry, wheelbase: number): Partial<EditableGeometry['points']> {
  const v = (k: PointKey) => vec3(e.points[k][0].value, e.points[k][1].value, e.points[k][2].value);
  const c = v('wheelCenter');
  const kx = c.x - 125, lo = vec3(kx + 15, c.y - 120, c.z + 8), up = vec3(kx - 15, c.y + 120, c.z - 8);
  const armZ = c.z - 150, armX = kx - (kx * 150) / Math.max(wheelbase, 500);
  return {
    lcaOut2: fields(lo), ucaOut2: fields(up),
    trOuter: fields(vec3(armX, c.y - 20, armZ)),
    trInner: fields(vec3(60, c.y + 10, armZ)),
  };
}

/** The steering ratio as the core reads it: c-factors, the limit, and the measured curve when there is one. */
export function ratioSpecOf(s: Pick<DesignState, 'steer' | 'steerCurve'>) {
  const parsed = s.steerCurve ? parseSteerCurve(s.steerCurve) : null;
  return {
    cFactor: s.steer.cFactor.value, cFactorLock: s.steer.cFactorLock.value, rackLimit: s.steer.rackLimit.value,
    ...(parsed?.ok ? { curve: parsed.curve } : {}),
  };
}

export function activePointKeys(kind: SuspensionKind, layout: SpringLayout = 'coilover', steer: SteerMechanism = 'rack', steeredAxle = false): PointKey[] {
  // A steered solid axle: its kingpins (UCA_Out2 top, LCA_Out2 bottom), knuckle arm and drag link.
  const base = isBeam(kind) && steeredAxle ? [...kindPointKeys(kind), 'ucaOut2', 'lcaOut2', 'trInner', 'trOuter'] as PointKey[] : kindPointKeys(kind);
  const withRocker = layout === 'rocker' && rockerAllowed(kind) ? [...base, ...ROCKER_KEYS] : base;
  return steer === 'arm' ? [...withRocker, 'strPiv1', 'strPiv2'] : steer === 'centerLink' ? [...withRocker, 'strPiv1', 'strPiv2', ...CENTER_LINK_KEYS] : withRocker;
}
function kindPointKeys(kind: SuspensionKind): PointKey[] {
  if (kind === 'macpherson') return ['lcaFwd', 'lcaAft', 'lcaOut', 'dmpChassis', 'dmpArm', 'trInner', 'trOuter', 'wheelCenter'];
  if (kind === 'rigid') return ['ucaOut', 'lcaOut', 'trInner', 'trOuter', 'wheelCenter'];
  if (kind === 'beam4') return ['lcaFwd', 'lcaOut', 'ucaFwd', 'ucaOut', 'wheelCenter', 'dmpChassis', 'dmpArm'];
  if (kind === 'beamLeaf') return ['lcaFwd', 'lcaOut', 'lcaAft', 'wheelCenter'];
  if (kind === 'custom') return ['wheelCenter', 'dmpChassis', 'dmpArm'];
  if (kind === 'twistBeam') return ['lcaFwd', 'lcaAft', 'lcaOut', 'wheelCenter', 'dmpChassis', 'dmpArm'];
  if (kind === 'beam3' || kind === 'beamWatts') return ['lcaFwd', 'lcaOut', 'ucaFwd', 'ucaOut', 'phChs', 'phAxle', 'wheelCenter', 'dmpChassis', 'dmpArm'];
  if (kind === 'singleArm') return ['lcaFwd', 'lcaAft', 'lcaOut', 'ucaOut', 'trInner', 'trOuter', 'wheelCenter', 'dmpChassis', 'dmpArm'];
  if (kind === 'multilink') return ['ucaFwd', 'ucaOut', 'ucaAft', 'ucaOut2', 'lcaFwd', 'lcaOut', 'lcaAft', 'lcaOut2', 'trInner', 'trOuter', 'wheelCenter', 'dmpChassis', 'dmpArm'];
  return ['ucaFwd', 'ucaAft', 'ucaOut', 'lcaFwd', 'lcaAft', 'lcaOut', 'trInner', 'trOuter', 'wheelCenter', 'dmpChassis', 'dmpArm'];
}

/**
 * The same corner as another suspension type, keeping what carries over: the lower arm, tie rod, hub and
 * tire always; a MacPherson strut is placed from the upright (lower point inboard of the tire, top mount
 * above the upper ball joint); a multilink starts as the double wishbone with each link's upright end slid
 * 35 mm inboard along the link (same virtual pivots: the same motion at ride height, close through travel); back to a double wishbone the links rejoin and a strut becomes a coilover on the lower arm.
 */
export function convertGeometry(e: EditableGeometry, kind: SuspensionKind): EditableGeometry {
  const from = e.kind ?? 'doubleWishbone';
  if (from === kind) return e;
  const p = (k: PointKey) => vec3(e.points[k][0].value, e.points[k][1].value, e.points[k][2].value);
  const pts = { ...e.points };
  const put = (k: PointKey, v: Vec3) => { pts[k] = fields(v); };
  const ubj = p('ucaOut'), lbj = p('lcaOut'), hub = p('wheelCenter');
  // New coilovers keep the old one's installed length (so its damper stroke and bump stop still fit).
  const coil = sub(p('dmpChassis'), p('dmpArm'));
  const coilLen = Math.hypot(coil.x, coil.y, coil.z) || 350;
  if (kind === 'custom') {
    // Start from the linkage kept from before, or one that moves like the current arms (a double wishbone
    // through the ball joints, the tie rod from the rack), with the coilover on the same body.
    const c = e.custom ?? customFromWishbone(toGeometry({ ...e, kind: 'doubleWishbone', springLayout: 'coilover' }));
    const damperBody = e.damperArm === 'uca' || e.damperArm === 'lca' ? e.damperArm : 'upright';
    return { ...e, kind, points: pts, springLayout: 'coilover', custom: e.custom ? c : { ...c, damperBody } };
  }
  if (kind === 'twistBeam') {
    // Trailing arms from a bushing ahead of the wheel, joined by a beam whose shear center sits on the
    // centerline a little behind the bushings (roll camber / roll steer come from where it is).
    const c = hub;
    put('lcaFwd', vec3(c.x - 120, c.y - 40, c.z + 450)); put('lcaOut', vec3(c.x - 120, c.y - 40, c.z));
    put('lcaAft', vec3(0, c.y - 40, c.z + 300));
    put('dmpArm', vec3(c.x - 170, c.y - 40, c.z - 60)); put('dmpChassis', vec3(c.x - 170, c.y - 40 + coilLen, c.z - 80));
    return { ...e, kind, points: pts, springLayout: 'coilover', damperArm: 'upright' };
  }
  if (kind === 'beamLeaf') {
    // Leaf springs on a solid axle: spring seat on top of the axle, front eye and rear shackle 650 mm away.
    const c = hub;
    put('lcaOut', vec3(c.x - 150, c.y + 40, c.z)); put('lcaFwd', vec3(c.x - 150, c.y + 90, c.z + 650)); put('lcaAft', vec3(c.x - 150, c.y + 120, c.z - 650));
    return { ...e, kind, points: pts, springLayout: 'coilover', damperArm: 'upright' };
  }
  if (isBeam(kind)) {
    // A solid axle from the hub: lower trailing links ahead of the axle, upper links (4-link: angled in;
    // 3-link: one in the middle) and, for the 3-link, a Panhard rod; coilovers on the axle.
    const c = hub;
    put('lcaOut', vec3(c.x - 150, c.y - 120, c.z)); put('lcaFwd', vec3(c.x - 150, c.y - 100, c.z + 550));
    if (kind === 'beam4') { put('ucaOut', vec3(c.x - 350, c.y + 120, c.z + 20)); put('ucaFwd', vec3(120, c.y + 150, c.z + 420)); }
    else { put('ucaOut', vec3(0, c.y + 130, c.z)); put('ucaFwd', vec3(0, c.y + 170, c.z + 400)); }
    if (kind === 'beamWatts') {
      // Watt's linkage: the bar's pivot on the axle's center behind it, the top link to the frame on the left.
      put('phAxle', vec3(0, c.y + 40, c.z - 120)); put('phChs', vec3(c.x - 250, c.y + 130, c.z - 120));
    } else { put('phAxle', vec3(c.x - 200, c.y + 60, c.z - 80)); put('phChs', vec3(-(c.x - 250), c.y + 60, c.z - 80)); }
    put('dmpArm', vec3(c.x - 200, c.y + 30, c.z - 30)); put('dmpChassis', vec3(c.x - 200, c.y + 30 + coilLen, c.z - 30));
    put('ucaAft', p('ucaFwd')); put('lcaAft', p('lcaFwd'));
    return { ...e, kind, points: pts, springLayout: 'coilover', damperArm: 'upright' };
  }
  if (isBeam(from) || from === 'twistBeam') {
    // Back to a corner type: arms from the sample layout's proportions around the hub.
    const c = hub;
    put('lcaOut', vec3(c.x - 40, c.y - 120, c.z)); put('ucaOut', vec3(c.x - 70, c.y + 160, c.z));
    put('lcaFwd', vec3(c.x - 400, c.y - 115, c.z + 150)); put('lcaAft', vec3(c.x - 400, c.y - 115, c.z - 150));
    put('ucaFwd', vec3(c.x - 350, c.y + 123, c.z + 150)); put('ucaAft', vec3(c.x - 350, c.y + 123, c.z - 150));
    put('dmpArm', vec3(c.x - 112, c.y - 117, c.z + 30));
    const up = vec3(-188, 337, 0), ul = Math.hypot(up.x, up.y);
    put('dmpChassis', vec3(c.x - 112 + (up.x / ul) * coilLen, c.y - 117 + (up.y / ul) * coilLen, c.z + 30));
  }
  if (kind === 'macpherson') {
    const w = mountedTireWidth(e.scalars);
    const lowerX = Math.min(ubj.x, hub.x - (Number.isFinite(w) ? w : 200) / 2 - 25);
    put('dmpArm', vec3(lowerX, (lbj.y + ubj.y) / 2 + 60, (lbj.z + ubj.z) / 2));
    put('dmpChassis', vec3(ubj.x - 60, ubj.y + 330, ubj.z - 20));
  } else if (kind === 'multilink') {
    // Each link's upright end slides 35 mm inboard along its own line: both links of a pair still pass
    // through the old ball joint (their virtual pivot), so the motion starts out the same.
    const along = (bj: Vec3, piv: Vec3) => {
      const d = vec3(bj.x - piv.x, bj.y - piv.y, bj.z - piv.z);
      const t = Math.min(0.4, 35 / Math.max(Math.hypot(d.x, d.y, d.z), 1e-9));
      return vec3(bj.x - t * d.x, bj.y - t * d.y, bj.z - t * d.z);
    };
    const a = p('ucaOut'), b = p('lcaOut');
    put('ucaOut', along(a, p('ucaFwd'))); put('ucaOut2', along(a, p('ucaAft')));
    put('lcaOut', along(b, p('lcaFwd'))); put('lcaOut2', along(b, p('lcaAft')));
    if (from === 'macpherson') { put('dmpArm', vec3(lbj.x - 70, lbj.y + 25, lbj.z)); put('dmpChassis', vec3(lbj.x - 250, lbj.y + 350, lbj.z)); }
  } else {
    if (from === 'multilink') {
      // The links rejoin at their virtual pivot (where each pair passes closest).
      put('ucaOut', virtualPivot(p('ucaFwd'), p('ucaOut'), p('ucaAft'), p('ucaOut2')));
      put('lcaOut', virtualPivot(p('lcaFwd'), p('lcaOut'), p('lcaAft'), p('lcaOut2')));
    }
    if (from === 'macpherson' || from === 'multilink') {
      // A coilover on the lower arm, 80 % of the way out, its top inboard and up.
      const fwd = p('lcaFwd'), aft = p('lcaAft'), out = p('lcaOut');
      const piv = vec3((fwd.x + aft.x) / 2, (fwd.y + aft.y) / 2, (fwd.z + aft.z) / 2);
      const arm = vec3(piv.x + 0.8 * (out.x - piv.x), piv.y + 0.8 * (out.y - piv.y) + 5, piv.z + 0.8 * (out.z - piv.z) + 30);
      put('dmpArm', arm); put('dmpChassis', vec3(arm.x - 180, arm.y + 335, arm.z));
    }
  }
  if (kind === 'singleArm' && from === 'doubleWishbone' && e.damperArm === 'uca') {
    // The upper arm goes away: its coilover moves to the same spot on the lower arm (with its top).
    const g = toGeometry(e);
    const moved = transferArmPoint(g.damper!.armPoint, g.uca, g.lca);
    const d = sub(moved, g.damper!.armPoint);
    put('dmpArm', moved); put('dmpChassis', add(g.damper!.chassis, d));
  }
  return { ...e, kind, points: pts, damperArm: kind === 'doubleWishbone' ? e.damperArm : kind === 'singleArm' ? (e.damperArm === 'upright' ? 'upright' : 'lca') : 'lca' };
}

export function toProfile(e: EditableGeometry): TireProfile {
  const s = e.scalars;
  return {
    radius: s.tireDiameter.value / 2,
    width: mountedTireWidth(s),
    shoulderRadius: s.shoulderRadius.value,
    rimRadius: s.rimDiameter.value / 2,
  };
}

export function toForceModel(kind: TireModelKind, f: Record<TireKey, Field>, volumeChange: boolean): TireForceModel | null {
  if (kind === 'stiffness') return { kind: 'stiffness', rate: f.rate.value };
  if (kind === 'gas') {
    return {
      kind: 'gas', volumeChange, volumeFactor: f.volumeFactor.value,
      conditions: {
        setPressure: f.pressure.value, setAltitude: f.setAltitude.value, setTemperature: f.setTemperature.value,
        operatingAltitude: f.opAltitude.value, operatingTemperature: f.opTemperature.value,
      },
    };
  }
  return null;
}

function parseField(text: string, quantity: Quantity, prev: Field): Field {
  const r = parseValue(text, quantity);
  return r.ok ? { text, value: r.value } : { text, value: prev.value, error: r.error };
}

export interface AppState extends DesignState {
  presetId: string;
  geom: EditableGeometry;
  travel: number;
  rack: number;
  driver: Extract<TravelDriver, 'wheelCenter' | 'contactPatch'>;
  droop: number;
  bump: number;
  playing: boolean;
  playingSteer: boolean;
  trails: boolean;
  /** Draw the tire as a plain cylinder (the math still uses the shoulder radius). */
  simpleTire: boolean;
  ghosts: boolean;
  visibility: Record<VisKey, boolean>;
  projection: 'orthographic' | 'perspective';
  focus: FocusKey;
  followFocus: boolean;
  /** Incremented to ask the camera to move; `view` null = refocus only. */
  cameraRequest: { view: ViewName | null; nonce: number };

  tireModel: TireModelKind;
  tire: Record<TireKey, Field>;
  volumeChange: boolean;
  tireSizeText: string;
  tireSizeError: string | null;

  mode: CornerMode;
  /** Multiplier on the static corner load in loaded mode (1 = static, >1 = bump / load transfer). */
  loadFactor: number;
  spring: Record<SpringKey, Field>;
  damper: Record<DamperKey, Field>;
  bumpStop: boolean;
  /** Damper force curve (linear, two-stage, or dyno curves). */
  damperMode: DamperMode;
  /** Dyno curves and clicker (damperMode 'curve'). */
  damperCurve?: DamperCurveText;
  steer: Record<SteerKey, Field>;

  selection: Selection;
  leftTab: 'inspector' | 'browser' | 'table' | 'locks' | 'optimize';
  /** Vehicle workspace sidebar tab. */
  vehicleTab: 'inputs' | 'locks' | 'optimize';
  /** Road under the Vehicle view: grade (%, + uphill), bank (deg, + left side lower), bumps per wheel (mm). */
  roadGrade: number;
  /** Tests workspace: the test being edited, and the selected result state (segment, sample). */
  activeTestId: string | null;
  testView: { segment: number; sample: number } | null;
  /** The car posed from the ride over time (playback): body pose and travels, no equilibrium solve. */
  rideView: { pose: ChassisPose; travel: Record<CornerId, number> } | null;
  /** Vehicle view: the car's speed, m/s (for aero). */
  vehicleSpeed: number;
  updateTests(fn: (t: TestDesign[]) => TestDesign[]): void;
  roadBank: number;
  wheelBumps: Record<CornerId, number>;
  nudgeStep: number;
  /** Round dragged joint coordinates to the grid. */
  snapToGrid: boolean;
  gridSize: number;
  /** A joint is being dragged: heavy sweeps pause until release. */
  interacting: boolean;
  measureMode: boolean;
  /** Point editor: move this joint along the line toward another one (also drives an extra drag arrow). */
  lineMove: { id: PointKey; toward: PointKey } | null;
  measure: AnchorId[];
  /** Vehicle view measure: two picks like 'FL.wheelCenter', 'RR.contact', 'cg', 'rcF', 'rcR'. */
  vehicleMeasure: string[];
  addVehicleMeasure(a: string): void;

  /** Name of the open layout in the in-app library (null = untitled). */
  fileName: string | null;
  /** Snapshot of the design when it was last saved/opened, for the unsaved-changes marker. */
  /** Snapshots of the model and tests parts at the last save / export (unsaved-change tracking). */
  savedSnapshot: string | null;
  savedTests: string | null;
  /** A short message; `action` adds a button to it (e.g. "Add steering back"). */
  notice: { text: string; kind: 'info' | 'warn' | 'error'; action?: NoticeAction } | null;
  /** Corners whose steering was turned off because their type can't steer (offered back when it can again). */
  steerRemoved: CornerId[];
  /** Save-as dialog open. */
  saveAsOpen: boolean;

  workspace: Workspace;
  forceVis: Record<ForceKey, boolean>;
  /** Arrow length per newton, mm/N. */
  forceScale: number;
  forceValues: boolean;
  /** Briefly hides 3D labels while the 3D view is swapped (see SafeHtml). */
  suspendHtml: boolean;
  /** Vehicle lateral acceleration, g (+ = left turn). */
  lateralG: number;
  playingLateral: boolean;
  /** Vehicle longitudinal acceleration, g: negative = braking, positive = accelerating (powered corners). */
  longitudinalG: number;
  playingLongitudinal: boolean;

  setActiveCorner(id: CornerId): void;
  setLink(key: keyof CornerLinks, value: boolean): void;
  setCornerSetting<K extends keyof CornerSettings>(id: CornerId, key: K, value: CornerSettings[K]): void;
  setShared(axle: Axle, patch: Partial<Pick<SharedDesign, 'antiRollBar' | 'heaveSpring' | 'dropLinkOn'>>): void;
  setSharedField(axle: Axle, key: SharedFieldKey, text: string): void;
  setDropLink(axle: Axle, axis: 0 | 1 | 2, text: string): void;
  setVehicleField(key: VehicleKey, text: string): void;
  toggleLock(key: string): void;
  /** Lock or unlock several keys at once (e.g. all three coordinates of a point). */
  setLocks(keys: string[], locked: boolean): void;
  clearLocks(): void;
  /**
   * Lock values the setup wizard's step wrote (the user's own values), tagged with the step so "Use an
   * estimate" on that step frees them again. Keys the user had already locked stay plain locks.
   */
  lockFromWizard(step: SetupStep, keys: string[]): void;
  /** Change the optimizer setup of the active corner's design. */
  updateOptimizer(fn: (o: OptimizerSetup) => OptimizerSetup): void;
  /** Write optimized coordinates into the design, keeping the previous geometry for Undo. */
  applyOptimized(updates: { key: PointKey; axis: 0 | 1 | 2; value: number }[]): void;
  undoOptimized(): void;
  updateVehicleOptimizer(fn: (o: VehicleOptimizerSetup) => VehicleOptimizerSetup): void;
  setGripField(key: GripKey, text: string): void;
  setTireGripField(key: MFKey, text: string): void;
  /** Use a tire model from a `.tir` file (null = the simple coefficients) on both axles, the front or the rear. */
  setTireFile(m: TirModel | null, axle?: TireAxle): void;
  /** Rear tires the same as the front again. */
  setRearTireSame(): void;
  /** Change every design used on an axle ('both' = every design). One undo step. */
  updateDesigns(axle: TireAxle, fn: (d: CornerDesign) => CornerDesign): void;
  setSetupStatus(step: SetupStep, status: 'entered' | 'estimated' | null): void;
  setAeroField(key: AeroKey, text: string): void;
  setAero(patch: Partial<Pick<AeroSettings, 'on' | 'file'>>): void;
  setBrakeField(key: BrakeKey, text: string): void;
  setBrakes(patch: Partial<BrakeSettings>): void;
  setFadeField(key: FadeKey, text: string): void;
  setBrakeMoreField(key: BrakeMoreKey, text: string): void;
  setShimmyField(key: ShimmyKey, text: string): void;
  setShimmy(patch: Partial<ShimmySettings>): void;
  setTowField(key: TowKey, text: string): void;
  setTow(patch: Partial<Pick<TowSettings, 'on'>>): void;
  /** Grip scale of a loaded file (λμ): side (LMUY) or braking / drive (LMUX). */
  setTireScale(key: 'LMUY' | 'LMUX', value: number, axle?: 'front' | 'rear'): void;
  /** Set the tire size (mm) of the designs used on an axle (both = every design). */
  applyTireDims(axle: TireAxle, dims: { outerDiameter?: number; width?: number; rimDiameter?: number }): void;
  resetTireGrip(): void;
  /** Write vehicle-optimized coordinates into each corner design (Undo keeps the previous geometry). */
  applyVehicleOptimized(updates: { root: CornerId; key: PointKey; axis: 0 | 1 | 2; value: number }[]): void;
  /** Set spring / damper rates of designs and anti-roll bar rates of axles (rate tuning). One undo step. */
  applyRateValues(updates: RateUpdate[]): void;
  undoVehicleOptimized(): void;
  vehOptUndo: Partial<Record<CornerId, EditableGeometry>> | null;
  /** Hold a dimension (replaces one with the same points and measure). */
  holdDimension(d: Omit<HeldDimension, 'id'>): void;
  removeDimension(id: string): void;
  /** Held dimensions that couldn't be met after the last edit (ids). */
  dimViolations: string[];
  /** Geometry before the last applied optimization (for Undo), with the corner it belongs to. */
  optUndo: { root: CornerId; geom: EditableGeometry } | null;

  /** Replace the whole design (File → New / Open / Import). */
  applyDesign(design: DesignState, fileName: string | null, savedModel: string | null, savedTests?: string | null): void;
  /** Mark parts saved (undefined = leave that part as it is). */
  markSaved(fileName: string | null, model?: string, tests?: string): void;
  notify(text: string, kind?: 'info' | 'warn' | 'error', action?: NoticeAction): void;
  /** Change the type of the design a corner uses (as the Inspector does for the corner being edited). */
  setSuspensionKindFor(id: CornerId, kind: SuspensionKind): void;
  loadPreset(id: string): void;
  select(sel: Selection): void;
  /** Optimizer result shown as a ghost in the Corner view before applying (not saved). */
  previewGeometry: DoubleWishboneGeometry | null;
  /** Custom linkage: the joint point picked in the view (moved with the arrows), or null. */
  customPick: { joint: string; which: 'p' | 'q' } | null;
  movePoint(key: PointKey, delta: Vec3): void;
  /** Move several hardpoints by the same amount. */
  movePoints(keys: PointKey[], delta: Vec3): void;
  /** Set one coordinate of several hardpoints at once (used by dragging). */
  setPointsAxis(updates: { key: PointKey; axis: 0 | 1 | 2; value: number }[]): void;
  /** Shift/Ctrl-click: add or remove points from a multi-selection. */
  toggleSelectPoints(keys: PointKey[]): void;
  /** Set one coordinate of a hardpoint to a base-unit value (used by dragging). */
  setPointAxis(key: PointKey, axis: 0 | 1 | 2, value: number): void;
  setArmDerived(arm: 'uca' | 'lca', which: ArmDerived, text: string): void;
  setDamperField(key: DamperKey, text: string): void;
  setSteerField(key: SteerKey, text: string): void;
  toggleMeasure(): void;
  /** Open the measure tool with these points already picked. */
  startMeasure(ids: AnchorId[]): void;
  /** Add a point to the measurement (`at` = where it is, to refuse a second pick at the first one's place). */
  addMeasureAnchor(a: AnchorId, at?: Vec3): void;
  setSpringField(key: SpringKey, text: string): void;
  setDamperArm(arm: ArmChoice): void;
  /** Rack or steering arm / plate, for every design (units of the steering input change with it). */
  setSteerMechanism(m: SteerMechanism): void;
  /** Put the steering rack ahead of or behind the axle (flipRackSide). */
  setRackSide(ahead: boolean): void;
  /** Coilover or pushrod / pullrod + rocker for the active design. */
  setSpringLayout(layout: SpringLayout): void;
  /** Rocker layout: move the pushrod's lower end to an arm or the knuckle. */
  setPushrodOn(on: ArmChoice): void;
  /** Set a point of any corner's design (the active one or another), mm in that corner's own frame. */
  setCornerPoint(id: CornerId, key: PointKey, v: Vec3): void;
  /** Arm pivot bushing stiffness (N/mm). */
  setBushing(which: 'radial' | 'axial', text: string): void;
  /** Solid axle: steered or not (turning it on places kingpins, a knuckle arm and a drag link from the hub). */
  setSteeredAxle(on: boolean): void;
  /** Custom linkage: replace its bodies and joints (one undo step). */
  setCustom(c: CustomLinkage): void;
  /** Change the active design's suspension type (convertGeometry). */
  setSuspensionKind(kind: SuspensionKind): void;
  /** Set the free length so the static corner load sits at the design position (travel 0). */
  fitSpring(): void;
  setTireField(key: TireKey, text: string): void;
  applyTireSize(text: string): void;
  setPoint(key: PointKey, axis: 0 | 1 | 2, text: string): void;
  setScalar(key: ScalarKey, text: string): void;
  set<K extends keyof AppState>(key: K, value: AppState[K]): void;
  toggleVisibility(key: VisKey): void;
  requestView(view: ViewName | null): void;
  focusOn(key: FocusKey): void;
}

/** Spring fields with the free length fitted so the static load sits at travel 0 (if solvable). */
export function fittedSpring(geom: EditableGeometry, f: Record<SpringKey, Field>, cornerLoad?: number): Record<SpringKey, Field> {
  try {
    const corner = new DoubleWishbone(toGeometry(geom));
    const load = cornerLoad === undefined ? sprungLoad(f, 1) : Math.max(0, cornerLoad - f.unsprungMass.value * G);
    const fl = fitFreeLength(corner, f.springRate.value, load);
    if (!Number.isFinite(fl)) return f;
    return { ...f, freeLength: field(Math.round(fl * 10) / 10) };
  } catch {
    return f;
  }
}

/** Everything a saved layout holds (docs: project files). */
/** Everything that defines one corner (shared between linked corners). */
export interface CornerDesign {
  geom: EditableGeometry;
  spring: Record<SpringKey, Field>;
  damper: Record<DamperKey, Field>;
  bumpStop: boolean;
  /** Damper force curve (linear, two-stage, or dyno curves). */
  damperMode: DamperMode;
  /** Dyno curves and clicker (damperMode 'curve'). */
  damperCurve?: DamperCurveText;
  tireModel: TireModelKind;
  tire: Record<TireKey, Field>;
  volumeChange: boolean;
  tireSizeText: string;
}

/** Per-corner settings that are never linked. */
export interface CornerSettings {
  steered: boolean;
  powered: boolean;
  /** Brake mounting: outboard (torque into the upright) or inboard (into the chassis), or none. */
  brake: BrakeMount;
  /** How a powered corner is driven: chassis diff + halfshaft, or hub motor. */
  drive: 'chassis' | 'hub';
  /** Anti-lock brakes on this corner (default on). Without ABS a tire braked past its grip locks and slides. */
  abs: boolean;
  /** Differential for a chassis-driven corner (the axle uses its left corner's setting). */
  diff: DiffType;
}
export type DiffType = 'open' | 'locked' | 'lsd';

/** Shared (left–right) components per axle; each can be absent or one of several types. */
export interface SharedDesign {
  antiRollBar: 'none' | 'wheelRate' | 'torsionBar';
  /** Rate at the wheel (N/mm of left/right travel difference). */
  arbRate: Field;
  /** Torsion bar rate (N·m/deg of twist). */
  barRate: Field;
  /** Bar arm (lever) length, mm. */
  lever: Field;
  /** Drop-link mount (corner frame; mirrored for the right side), on `dropLinkOn`. */
  dropLink: [Field, Field, Field];
  /** What the drop link is fixed to: the lower arm (default), upper arm, knuckle or the rocker (pushrod layouts). */
  dropLinkOn?: 'lca' | 'uca' | 'upright' | 'rocker';
  heaveSpring: 'none' | 'wheelRate';
  /** Heave spring rate at the wheel, N/mm. */
  heaveRate: Field;
}
export type Axle = 'front' | 'rear';
export type SharedFieldKey = 'arbRate' | 'barRate' | 'lever' | 'heaveRate';
export const SHARED_META: Record<SharedFieldKey, { label: string; quantity: Quantity; unit: string; hint?: string }> = {
  arbRate: { label: 'Bar rate at the wheel', quantity: 'rate', unit: 'N/mm', hint: 'Force per mm of left/right travel difference' },
  barRate: { label: 'Torsion bar rate', quantity: 'torsion', unit: 'Nm/deg' },
  lever: { label: 'Bar arm length', quantity: 'length', unit: 'mm' },
  heaveRate: { label: 'Heave spring rate at the wheel', quantity: 'rate', unit: 'N/mm', hint: 'Acts on the average travel of the two corners (no roll stiffness)' },
};

/** Which corners share dimensions. */
export interface CornerLinks {
  /** FR uses FL's dimensions. */
  frontPair: boolean;
  /** RR uses RL's dimensions. */
  rearPair: boolean;
  /** The rear corners use the front corners' dimensions. */
  rearFromFront: boolean;
}

/** The corner whose design a corner actually uses, following the links. */
/** A button on a notice. */
export interface NoticeAction { label: string; run: () => void }

/** Whether a type can steer (a twist beam's hub is fixed to its arm). */
export const canSteer = (kind: SuspensionKind | undefined) => kind !== 'twistBeam';

export function rootOf(id: CornerId, links: CornerLinks): CornerId {
  switch (id) {
    case 'FL': return 'FL';
    case 'FR': return links.frontPair ? 'FL' : 'FR';
    case 'RL': return links.rearFromFront ? 'FL' : 'RL';
    case 'RR': return links.rearPair ? rootOf('RL', links) : links.rearFromFront ? rootOf('FR', links) : 'RR';
  }
}

export const CORNER_NAMES: Record<CornerId, string> = { FL: 'Front left', FR: 'Front right', RL: 'Rear left', RR: 'Rear right' };

/** Vehicle inputs (L6). */
export const VEHICLE_KEYS = ['mass', 'cgX', 'cgY', 'cgZ', 'wheelbase', 'brakeBias', 'driveSplit', 'rollInertia', 'pitchInertia', 'yawInertia', 'tireDamping', 'relaxation', 'rollingResistance'] as const;
/** Vehicle inputs only the ride over time (Phase B) and handling (Phase C) use. */
export const RIDE_KEYS = ['rollInertia', 'pitchInertia', 'yawInertia', 'tireDamping', 'relaxation'] as const;
export type VehicleKey = (typeof VEHICLE_KEYS)[number];
export const VEHICLE_META: Record<VehicleKey, { label: string; quantity: Quantity; unit: string; hint?: string }> = {
  mass: { label: 'Total mass (incl. unsprung)', quantity: 'mass', unit: 'kg' },
  cgX: { label: 'CG X (+ left of centerline)', quantity: 'length', unit: 'mm' },
  cgY: { label: 'CG height above ground (static)', quantity: 'length', unit: 'mm' },
  cgZ: { label: 'CG Z from front axle (+ forward)', quantity: 'length', unit: 'mm', hint: 'Negative = behind the front axle' },
  wheelbase: { label: 'Wheelbase', quantity: 'length', unit: 'mm' },
  brakeBias: { label: 'Brake bias (front share)', quantity: 'percent', unit: '%', hint: 'Share of the braking force on the front axle' },
  driveSplit: { label: 'Drive split (front share)', quantity: 'percent', unit: '%', hint: 'Only used when both axles have powered corners; within an axle the drive is shared equally (open differential)' },
  rollInertia: { label: 'Body roll inertia', quantity: 'ratio', unit: 'kg·m²', hint: 'Sprung body about its CG, around the car\'s long axis (ride over time). About sprung mass × (0.3–0.4 × track)².' },
  pitchInertia: { label: 'Body pitch inertia', quantity: 'ratio', unit: 'kg·m²', hint: 'Sprung body about its CG, around the side-to-side axis (ride over time). About sprung mass × (0.35–0.45 × wheelbase)².' },
  yawInertia: { label: 'Yaw inertia (whole car)', quantity: 'ratio', unit: 'kg·m²', hint: 'About the CG, around the vertical axis (handling over time). About total mass × (0.45 × wheelbase)².' },
  tireDamping: { label: 'Tire damping', quantity: 'damping', unit: 'N·s/m', hint: 'Vertical damping of each tire (ride over time). Small: rubber and air damp little.' },
  relaxation: { label: 'Tire relaxation length', quantity: 'length', unit: 'mm', hint: 'Handling over time: a tire\'s side force builds up over this distance rolled after its slip angle changes (≈ 0.5–1 × the tire radius for cars; 0 = at once). Slows the car\'s response to quick steering.' },
  rollingResistance: { label: 'Rolling resistance (coefficient)', quantity: 'ratio', unit: '', hint: 'The tires\u2019 own drag ÷ their load while rolling (≈ 0.008–0.015 for road tires, 0.02–0.03 off-road; 0 = none). The powered wheels push against it like the air; with the driver working the pedals a coasting car slows by it.' },
};

export type Workspace = 'corner' | 'vehicle' | 'tests';

/** Forces that can be drawn in the Vehicle view. */
export const FORCE_KEYS = ['tireVertical', 'tireLateral', 'tireLongitudinal', 'springs', 'shared', 'weights', 'inertia'] as const;
export type ForceKey = (typeof FORCE_KEYS)[number];
export const FORCE_META: Record<ForceKey, { label: string; color: string; hint: string }> = {
  tireVertical: { label: 'Tire vertical load', color: '#ffd166', hint: 'Ground on tire, at the patch centroid' },
  tireLateral: { label: 'Tire lateral force', color: '#ef476f', hint: 'Ground on tire, sideways' },
  tireLongitudinal: { label: 'Brake / drive force', color: '#06d6a0', hint: 'Ground on tire, fore/aft (− braking, + drive)' },
  springs: { label: 'Spring forces', color: '#ff7eb6', hint: 'Coilover on the body (at the chassis mount) and on the arm (at the arm mount)' },
  shared: { label: 'Anti-roll bar / heave', color: '#c77dff', hint: 'Shared-component force, shown as the equivalent force at each wheel' },
  weights: { label: 'Weights', color: '#e0e0e0', hint: 'Sprung weight at the sprung CG, unsprung weights at the wheel centers' },
  inertia: { label: 'Inertia (d’Alembert)', color: '#8ecae6', hint: '−m·a at the sprung CG: what the body "feels" when cornering, braking or accelerating' },
};

/** One optimizer goal: on/off, target (in the goal's unit) and weight. */
export interface GoalSetting { on: boolean; target: Field; weight: Field }

/** Optimizer setup for one corner design (keyed by its root corner). */
export interface OptimizerSetup {
  /** Free coordinates, key `${PointKey}.${x|y|z}` → allowed range (absolute, mm). */
  ranges: Record<string, { lo: Field; hi: Field }>;
  goals: Record<GoalKind, GoalSetting>;
  /** Body roll angle for the roll-camber goal, deg. */
  rollAngle: Field;
  /** Also check bump steer at ± this rack travel (mm); 0 = only straight ahead. */
  rackCheck: Field;
  /** Weight of the "prefer small changes" term. */
  keepClose: Field;
  /** Outside-wheel load in roll, × static corner load (contact-area / grip goals). */
  rollLoadFactor: Field;
  /** Gradient runs (1 = local from the current design; more = wide search from the best DOE samples too). */
  starts?: number;
  /** Lengths the optimizer keeps within a range (min / max, mm): the arms (pivot axis to ball joint) and the tie rod. */
  lengthRanges?: Partial<Record<'uca' | 'lca' | 'tieRod', { lo: Field; hi: Field }>>;
}

/** Whole-vehicle optimizer setup. */
/** Brake hydraulics inputs (docs/MATH.md § Brakes). */
export const BRAKE_KEYS = ['maxPedalForce', 'pedalRatio', 'boost', 'balanceFront', 'mcBoreF', 'mcBoreR', 'pistonDiaF', 'pistonsF', 'pistonDiaR', 'pistonsR', 'padMuF', 'padMuR', 'rotorRF', 'rotorRR'] as const;
export type BrakeKey = (typeof BRAKE_KEYS)[number];
export const BRAKE_META: Record<BrakeKey, { label: string; quantity: Quantity; unit: string; initial: number; hint?: string }> = {
  maxPedalForce: { label: 'Most pedal force', quantity: 'force', unit: 'N', initial: 500, hint: 'What the driver pushes in a hard stop (≈ 400–800 N; a race driver up to ~1000 N)' },
  pedalRatio: { label: 'Pedal ratio', quantity: 'ratio', unit: ':1', initial: 4, hint: 'Pedal lever: foot to pivot ÷ master-cylinder pushrod to pivot' },
  boost: { label: 'Booster gain', quantity: 'ratio', unit: '×', initial: 1, hint: '1 = no booster; road cars ≈ 3–6' },
  balanceFront: { label: 'Balance bar, front share', quantity: 'ratio', unit: '%', initial: 50, hint: 'Two master cylinders on a balance bar: the share of the pedal force to the front one' },
  mcBoreF: { label: 'Master cylinder bore, front', quantity: 'length', unit: 'mm', initial: 19.05, hint: '3/4" = 19.05 mm, 5/8" = 15.9 mm, 7/8" = 22.2 mm. Smaller = more pressure, more pedal travel' },
  mcBoreR: { label: 'Master cylinder bore, rear', quantity: 'length', unit: 'mm', initial: 19.05 },
  pistonDiaF: { label: 'Caliper piston diameter, front', quantity: 'length', unit: 'mm', initial: 32 },
  pistonsF: { label: 'Pistons per side, front', quantity: 'ratio', unit: '', initial: 2, hint: 'Opposed caliper: pistons on one side; floating caliper: its pistons' },
  pistonDiaR: { label: 'Caliper piston diameter, rear', quantity: 'length', unit: 'mm', initial: 28 },
  pistonsR: { label: 'Pistons per side, rear', quantity: 'ratio', unit: '', initial: 1 },
  padMuF: { label: 'Pad friction μ, front', quantity: 'ratio', unit: '', initial: 0.45, hint: 'Street pads ≈ 0.35–0.45, race pads ≈ 0.45–0.6 (hot)' },
  padMuR: { label: 'Pad friction μ, rear', quantity: 'ratio', unit: '', initial: 0.45 },
  rotorRF: { label: 'Effective rotor radius, front', quantity: 'length', unit: 'mm', initial: 100, hint: 'Rotor center to the middle of the pad' },
  rotorRR: { label: 'Effective rotor radius, rear', quantity: 'length', unit: 'mm', initial: 90 },
};
/** Brake fade inputs (docs/MATH.md § Brakes, fade): rotors heat through a test, pads lose grip when hot. */
export const FADE_KEYS = ['rotorMassF', 'rotorMassR', 'cooling', 'fadeStart', 'fadeEnd', 'fadeLoss', 'fadeAir', 'fadeStartTemp'] as const;
export type FadeKey = (typeof FADE_KEYS)[number];
export const FADE_META: Record<FadeKey, { label: string; quantity: Quantity; unit: string; initial: number; hint?: string }> = {
  rotorMassF: { label: 'Rotor mass, front (each)', quantity: 'mass', unit: 'kg', initial: 2.5, hint: 'Heavier rotors heat up less per stop (road-car front rotors ≈ 6–10 kg, small race cars ≈ 1.5–3 kg)' },
  rotorMassR: { label: 'Rotor mass, rear (each)', quantity: 'mass', unit: 'kg', initial: 2 },
  cooling: { label: 'Cooling per rotor at 100 km/h', quantity: 'ratio', unit: 'W/K', initial: 25, hint: 'Heat carried away per °C above the air (a fifth of it at a stop). Solid rotor ≈ 15–25, vented ≈ 30–50, more with ducts' },
  fadeStart: { label: 'Pads start to fade at', quantity: 'temperature', unit: '°C', initial: 400, hint: 'Street pads ≈ 300–400 °C, race pads ≈ 550–700 °C' },
  fadeEnd: { label: 'Fully faded at', quantity: 'temperature', unit: '°C', initial: 650 },
  fadeLoss: { label: 'Pad grip lost when fully faded', quantity: 'ratio', unit: '%', initial: 40 },
  fadeAir: { label: 'Air temperature', quantity: 'temperature', unit: '°C', initial: 20 },
  fadeStartTemp: { label: 'Rotor temperature at the start of a test', quantity: 'temperature', unit: '°C', initial: 50 },
};
/**
 * More brake inputs (round 3, R5): drums, the room for the brakes inside the wheel, the detailed
 * hydraulics (fluid and pedal travel) and the reserve the brake ladder sizes to.
 */
export const BRAKE_MORE_KEYS = [
  'wcBoreF', 'wcBoreR', 'drumRF', 'drumRR', 'brakeFactorF', 'brakeFactorR', 'drumFadeK',
  'brakeRoom', 'padHeight',
  'mcStroke', 'maxPedalTravel', 'padClearance', 'shoeClearance', 'complianceF', 'complianceR',
  'ladderReserve',
] as const;
export type BrakeMoreKey = (typeof BRAKE_MORE_KEYS)[number];
export const BRAKE_MORE_META: Record<BrakeMoreKey, { label: string; quantity: Quantity; unit: string; initial: number; hint?: string }> = {
  wcBoreF: { label: 'Wheel-cylinder bore, front', quantity: 'length', unit: 'mm', initial: 22.2, hint: 'Drum: the bore of the cylinder that pushes both shoes (3/4" = 19.05, 7/8" = 22.2 mm)' },
  wcBoreR: { label: 'Wheel-cylinder bore, rear', quantity: 'length', unit: 'mm', initial: 19.05 },
  drumRF: { label: 'Drum radius (inside), front', quantity: 'length', unit: 'mm', initial: 114.3, hint: 'Half the drum’s inside diameter (9" drum = 114 mm)' },
  drumRR: { label: 'Drum radius (inside), rear', quantity: 'length', unit: 'mm', initial: 114.3 },
  brakeFactorF: { label: 'Shoe brake factor, front', quantity: 'ratio', unit: '', initial: 2.2, hint: 'Torque ÷ (wheel-cylinder force × drum radius) for both shoes: leading / trailing ≈ 2–2.5, duo-servo ≈ 3–5 (lining μ ≈ 0.4). A disc’s is 2μ ≈ 0.9' },
  brakeFactorR: { label: 'Shoe brake factor, rear', quantity: 'ratio', unit: '', initial: 2.2 },
  drumFadeK: { label: 'Drum fade sensitivity', quantity: 'ratio', unit: '×', initial: 1.8, hint: 'A drum’s brake factor falls faster than its lining μ when hot: factor ∝ μ^k (leading / trailing ≈ 1.5–2, duo-servo ≈ 2.5–3; a disc is 1)' },
  brakeRoom: { label: 'Room inside the rim for the caliper', quantity: 'length', unit: 'mm', initial: 38, hint: 'Radial room from the rim’s bead seat to the rotor’s outer edge (rim barrel + caliper body). Sets the largest rotor that fits the wheel (a drum gets half of it)' },
  padHeight: { label: 'Pad height', quantity: 'length', unit: 'mm', initial: 36, hint: 'The effective rotor radius sits half the pad height inside the rotor’s edge' },
  mcStroke: { label: 'Master-cylinder stroke', quantity: 'length', unit: 'mm', initial: 32, hint: 'A tandem master cylinder’s two chambers share it' },
  maxPedalTravel: { label: 'Most pedal travel', quantity: 'length', unit: 'mm', initial: 100, hint: 'At the pedal pad, in the hardest stop: more = Long pedal' },
  padClearance: { label: 'Pad clearance (each pad)', quantity: 'length', unit: 'mm', initial: 0.15, hint: 'How far each pad moves before it clamps (knock-back, run-out): ≈ 0.1–0.3 mm' },
  shoeClearance: { label: 'Shoe clearance (drums, each shoe)', quantity: 'length', unit: 'mm', initial: 0.4, hint: 'Shoe travel at the wheel cylinder before the lining touches: ≈ 0.25–0.6 mm' },
  complianceF: { label: 'Circuit swell, front', quantity: 'ratio', unit: 'mm³/MPa', initial: 150, hint: 'Fluid the front circuit takes per MPa (both wheels): hose swell, caliper flex, pad compression. Rubber hoses and floating calipers ≈ 150–300, braided lines and stiff race calipers ≈ 50–100' },
  complianceR: { label: 'Circuit swell, rear', quantity: 'ratio', unit: 'mm³/MPa', initial: 120 },
  ladderReserve: { label: 'Brake reserve to keep', quantity: 'ratio', unit: '%', initial: 25, hint: 'The brake ladder picks the smallest brakes that still have this much to spare in the hardest stop of the tests (fade included)' },
};

export interface BrakeSettings extends Record<BrakeKey, Field>, Record<FadeKey, Field>, Record<BrakeMoreKey, Field> {
  /** Drum brakes on the front / rear axle (else discs). */
  drumF: boolean;
  drumR: boolean;
  /** Detailed hydraulics: fluid volumes and pedal travel (else the simple pressure-only model). */
  detail: boolean;
  /** The brake ladder may switch a drum axle to discs (only with the user's permission). */
  allowDiscF: boolean;
  allowDiscR: boolean;
  /** Model the brake hydraulics (off = the brakes are always strong enough). */
  on: boolean;
  /** Model brake fade in tests (with the hydraulics). */
  fade: boolean;
  /** Two master cylinders on a balance bar (else one tandem master cylinder). */
  dualMc: boolean;
  /** Use the hydraulics' front / rear split as the brake bias. */
  useBias: boolean;
}
export const defaultBrakes = (): BrakeSettings => ({
  ...(Object.fromEntries(BRAKE_KEYS.map((k) => [k, field(BRAKE_META[k].initial, BRAKE_META[k].quantity)])) as Record<BrakeKey, Field>),
  ...(Object.fromEntries(FADE_KEYS.map((k) => [k, field(FADE_META[k].initial, FADE_META[k].quantity)])) as Record<FadeKey, Field>),
  ...(Object.fromEntries(BRAKE_MORE_KEYS.map((k) => [k, field(BRAKE_MORE_META[k].initial, BRAKE_MORE_META[k].quantity)])) as Record<BrakeMoreKey, Field>),
  on: false, fade: false, dualMc: false, useBias: false, drumF: false, drumR: false, detail: false, allowDiscF: false, allowDiscR: false,
});

/** Shimmy / death wobble inputs (round 3, R8; docs/MATH.md § Shimmy). */
export const SHIMMY_KEYS = ['shimStiffness', 'shimDamper', 'swInertia', 'freePlay', 'wornStiffness', 'wornDamper', 'imbalance', 'shimMaxSpeed'] as const;
export type ShimmyKey = (typeof SHIMMY_KEYS)[number];
export const SHIMMY_META: Record<ShimmyKey, { label: string; quantity: Quantity; unit: string; initial: number; hint?: string }> = {
  shimStiffness: { label: 'Steering-system stiffness (at the wheels)', quantity: 'ratio', unit: 'N·m/rad', initial: 30000, hint: 'Torque per radian between the front wheels and the steering wheel (column, rack or box, tie rods, joints), both wheels together. Cars ≈ 20 000–60 000; a worn or long, soft linkage less' },
  shimDamper: { label: 'Steering damper (at the wheels)', quantity: 'ratio', unit: 'N·m·s/rad', initial: 20, hint: 'A steering damper plus the system\u2019s own friction, as damping of the wheels\u2019 steer. No damper ≈ 10–30; a truck steering damper ≈ 100–300' },
  swInertia: { label: 'Steering-wheel inertia', quantity: 'ratio', unit: 'kg·m²', initial: 0.04, hint: 'At the steering wheel (≈ 0.03–0.06 for a car\u2019s wheel)' },
  freePlay: { label: 'Free play when worn (at the wheels)', quantity: 'angle', unit: '°', initial: 1, hint: 'Lash in the steering (joints, rack / box) of worn parts, as the wheels\u2019 steer angle before the steering pushes back' },
  wornStiffness: { label: 'Worn: stiffness left', quantity: 'ratio', unit: '%', initial: 70, hint: 'Softer bushings and joints of worn parts' },
  wornDamper: { label: 'Worn: damping left', quantity: 'ratio', unit: '%', initial: 50, hint: 'A tired steering damper' },
  imbalance: { label: 'Wheel imbalance (at the rim, worn)', quantity: 'ratio', unit: 'g', initial: 40, hint: 'Out-of-balance mass at the rim: it shakes the wheels at their spin frequency in the kick test' },
  shimMaxSpeed: { label: 'Fastest speed to check', quantity: 'speed', unit: 'm/s', initial: 40 },
};
export interface ShimmySettings extends Record<ShimmyKey, Field> {
  /** Check shimmy in the tests (kick test). */
  check: boolean;
  /** The driver's hands lightly on the wheel (else hands off). */
  handsOn: boolean;
}
export const defaultShimmy = (): ShimmySettings => ({
  ...(Object.fromEntries(SHIMMY_KEYS.map((k) => [k, field(SHIMMY_META[k].initial, SHIMMY_META[k].quantity)])) as Record<ShimmyKey, Field>),
  check: true, handsOn: true,
});

/** Towing inputs (docs/MATH.md § Towing). */
export const TOW_KEYS = ['trailerMass', 'tongueShare', 'hitchHeight', 'hitchBehindRear', 'hitchToAxle', 'trailerCgHeight', 'trailerBrakes', 'trailerYawRadius', 'tongueLimit'] as const;
export type TowKey = (typeof TOW_KEYS)[number];
export const TOW_META: Record<TowKey, { label: string; quantity: Quantity; unit: string; initial: number; hint?: string }> = {
  trailerMass: { label: 'Trailer mass (loaded)', quantity: 'mass', unit: 'kg', initial: 400 },
  tongueShare: { label: 'Tongue weight (share of the trailer)', quantity: 'ratio', unit: '%', initial: 10, hint: 'About 10–15 % keeps a trailer stable; less makes it sway' },
  hitchHeight: { label: 'Hitch ball height', quantity: 'length', unit: 'mm', initial: 450, hint: 'Above the ground' },
  hitchBehindRear: { label: 'Hitch ball behind the rear axle', quantity: 'length', unit: 'mm', initial: 900 },
  hitchToAxle: { label: 'Hitch ball to the trailer axle', quantity: 'length', unit: 'mm', initial: 3000 },
  trailerCgHeight: { label: 'Trailer CG height', quantity: 'length', unit: 'mm', initial: 700, hint: 'Above the ground; above the hitch, braking presses the tongue down more' },
  trailerBrakes: { label: 'Trailer brakes (share of its braking)', quantity: 'ratio', unit: '%', initial: 0, hint: '0 = none: the trailer pushes the car when braking; 100 = it stops itself' },
  tongueLimit: { label: 'Hitch rating (most tongue load)', quantity: 'mass', unit: 'kg', initial: 0, hint: 'The hitch\'s rated tongue weight (0 = no limit). Tests fail Hitch overloaded when braking, accelerating or bumps push the hitch load above it' },
  trailerYawRadius: { label: 'Trailer yaw radius of gyration', quantity: 'length', unit: 'mm', initial: 1350, hint: 'For sway (tests with Ride over time and the driver steering): √(yaw inertia ÷ mass) about its CG. A box trailer ≈ 0.3 × its length; heavy ends make it larger and the trailer sway sooner' },
};
export interface TowSettings extends Record<TowKey, Field> { on: boolean }
export const defaultTow = (): TowSettings => ({
  ...(Object.fromEntries(TOW_KEYS.map((k) => [k, field(TOW_META[k].initial, TOW_META[k].quantity)])) as Record<TowKey, Field>), on: false,
});

export const AERO_KEYS = ['CdA', 'downF', 'downR', 'dragHeight', 'altitude', 'temperature', 'CsA', 'sideCp', 'rollSensF', 'rollSensR', 'yawBalance'] as const;
export type AeroKey = (typeof AERO_KEYS)[number];
export const AERO_META: Record<AeroKey, { label: string; quantity: Quantity; unit: string; hint: string }> = {
  CdA: { label: 'Drag area CdA', quantity: 'ratio', unit: 'm²', hint: 'Drag coefficient × frontal area. Road cars ≈ 0.6–0.8, open-wheel cars with wings ≈ 1–1.5.' },
  downF: { label: 'Downforce area, front (−ClA)', quantity: 'ratio', unit: 'm²', hint: 'Downforce at the front axle per dynamic pressure (½ρV²). 0 = none; negative = lift.' },
  downR: { label: 'Downforce area, rear (−ClA)', quantity: 'ratio', unit: 'm²', hint: 'Downforce at the rear axle per dynamic pressure.' },
  dragHeight: { label: 'Drag acts at height', quantity: 'length', unit: 'mm', hint: 'Above the ground: drag up high moves load to the rear.' },
  altitude: { label: 'Altitude', quantity: 'altitude', unit: 'm', hint: 'For the air density' },
  temperature: { label: 'Air temperature', quantity: 'temperature', unit: '°C', hint: 'For the air density' },
  CsA: { label: 'Side force area per ° of sideslip', quantity: 'ratio', unit: 'm²/°', hint: 'Handling over time: the body pushed back against its sideways motion. 0 = none; a car ≈ 0.01–0.04.' },
  sideCp: { label: 'Side force acts, behind the front axle', quantity: 'length', unit: 'mm', hint: 'Behind the CG it steadies the car in a slide (weathervane); ahead of it, it makes it less stable.' },
  rollSensF: { label: 'Downforce lost per ° of roll, front', quantity: 'ratio', unit: 'm²/°', hint: 'Lift area added per degree of body roll (either way): wings and floors lose downforce as the body rolls. 0 = none.' },
  rollSensR: { label: 'Downforce lost per ° of roll, rear', quantity: 'ratio', unit: 'm²/°', hint: 'As for the front.' },
  yawBalance: { label: 'Balance shift per ° of sideslip', quantity: 'ratio', unit: '/°', hint: 'Front share of the downforce moved per degree of sideslip (+ = forward: the center of pressure moves forward in a slide).' },
};
export interface AeroSettings extends Record<AeroKey, Field> {
  on: boolean;
  /** Characteristics imported from a file (replace the generic values while set). */
  file: AeroModel | null;
}
export const defaultAero = (): AeroSettings => ({
  on: false, file: null,
  CdA: field(0.8, 'ratio'), downF: field(0.3, 'ratio'), downR: field(0.4, 'ratio'), dragHeight: field(400),
  altitude: field(0, 'altitude'), temperature: field(20, 'temperature'), CsA: field(0, 'ratio'), sideCp: field(900), rollSensF: field(0, 'ratio'), rollSensR: field(0, 'ratio'), yawBalance: field(0, 'ratio'),
});

/** Setup wizard steps, easy to hard. */
export const SETUP_STEPS = ['type', 'drive', 'tires', 'size', 'weight', 'unsprung', 'points', 'springs', 'dampers', 'steering', 'grip', 'inertia'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const SETUP_LABELS: Record<SetupStep, string> = {
  type: 'Suspension type', drive: 'Steering, drive and brakes', tires: 'Wheels and tires', size: 'Track and wheelbase', weight: 'Weight and CG', unsprung: 'Unsprung weight',
  points: 'Suspension points', springs: 'Springs', dampers: 'Dampers and anti-roll bars', steering: 'Steering', grip: 'Tire grip', inertia: 'Body inertia',
};

/** Which axle a tire setting is for. */
export type TireAxle = 'both' | 'front' | 'rear';

/** One rate change from the rate tuner. */
export interface RateUpdate { root?: CornerId; axle?: Axle; section: 'spring' | 'damper' | 'shared'; key: string; value: number }

export interface VehicleOptimizerSetup {
  /** Free coordinates, key `${root}.${PointKey}.${x|y|z}` → allowed range (absolute, mm). */
  ranges: Record<string, { lo: Field; hi: Field }>;
  goals: Record<VehicleGoalKind, GoalSetting>;
  /** Load cases, g (0 = off). */
  lateralG: Field;
  brakingG: Field;
  accelG: Field;
  /** Braking in a turn (both g; off when either is 0). */
  combinedLatG?: Field;
  combinedBrakeG?: Field;
  /** Weight of each fixed case in the averaged goals (default 1). */
  caseWeights?: Partial<Record<FixedCaseKind, number>>;
  keepClose: Field;
  /** Load cases: the fixed ones above, or a test's segments (test id). */
  caseSource?: string;
  /** Gradient runs (1 = local from the current design; more = wide search from the best DOE samples too). */
  starts?: number;
}

export function defaultVehicleOptimizerSetup(): VehicleOptimizerSetup {
  return {
    ranges: {},
    goals: Object.fromEntries(VEHICLE_GOAL_KINDS.map((k) => [k, { on: false, target: field(VEHICLE_GOAL_META[k].target, 'ratio'), weight: field(1, 'ratio') }])) as Record<VehicleGoalKind, GoalSetting>,
    lateralG: field(1, 'ratio'),
    brakingG: field(1, 'ratio'),
    accelG: field(0, 'ratio'),
    keepClose: field(0.01, 'ratio'),
  };
}

/** Tire grip model (contact-patch pressure + load-sensitive friction), shared by all tires for now. */
export const GRIP_KEYS = ['muRef', 'pRef', 'sensitivity', 'carcassShare'] as const;
export type GripKey = (typeof GRIP_KEYS)[number];
export const GRIP_META: Record<GripKey, { label: string; quantity: Quantity; unit: string; hint: string }> = {
  muRef: { label: 'Friction coefficient μ', quantity: 'ratio', unit: '', hint: 'Rubber friction at the reference pressure' },
  pRef: { label: 'at reference pressure', quantity: 'pressure', unit: 'kPa', hint: 'Contact pressure where μ applies' },
  sensitivity: { label: 'Load sensitivity n', quantity: 'ratio', unit: '', hint: 'μ ∝ (p / p_ref)^−n. 0 = none; rubber is typically 0.1–0.3' },
  carcassShare: { label: 'Carcass share of load', quantity: 'ratio', unit: '', hint: '0 = even pressure over the patch (pure air spring); 1 = pressure follows the local tire deflection' },
};
export const defaultGrip = (): Record<GripKey, Field> =>
  Object.fromEntries(GRIP_KEYS.map((k) => [k, field(DEFAULT_GRIP[k], GRIP_META[k].quantity)])) as Record<GripKey, Field>;

/**
 * Tire grip model (Magic Formula) coefficients, docs/MATH.md § Tire grip. Basic ones are shown first;
 * the defaults are GENERIC, not fitted to a real tire.
 */
export const MF_KEYS = [
  'fz0', 'p0', 'pDy1', 'pDy2', 'pDy3', 'pVy3', 'pCy1', 'pKy1', 'pDx1', 'pCx1',
  'pEy1', 'pEy2', 'pKy2', 'pKy3', 'ppy1', 'ppy3', 'pDx2', 'pDx3', 'pEx1', 'pKx1', 'ppx3',
] as const satisfies readonly (keyof MFCoeffs)[];
export type MFKey = (typeof MF_KEYS)[number];
export const MF_META: Record<MFKey, { label: string; quantity: Quantity; unit: string; hint: string; basic?: boolean }> = {
  fz0: { label: 'Nominal load Fz0', quantity: 'force', unit: 'N', basic: true, hint: 'Load the coefficients refer to (about the static load of one corner).' },
  p0: { label: 'Nominal pressure p0', quantity: 'pressure', unit: 'kPa', basic: true, hint: 'Inflation pressure the coefficients refer to. The set pressure of the air-spring tire model is compared with it.' },
  pDy1: { label: 'Peak lateral μ at Fz0', quantity: 'ratio', unit: '', basic: true, hint: 'pDy1: peak side force ÷ load at the nominal load, wheel level.' },
  pDy2: { label: 'Lateral μ change with load', quantity: 'ratio', unit: '', basic: true, hint: 'pDy2: change in peak μ per +100 % load (negative = load sensitivity: a more loaded tire grips less per newton).' },
  pDy3: { label: 'Peak loss with camber', quantity: 'ratio', unit: '/rad²', basic: true, hint: 'pDy3: peak μ × (1 − pDy3·γ²). With camber thrust this sets the best lean (≈ pVy3 ÷ (2·pDy1·pDy3) rad).' },
  pVy3: { label: 'Camber thrust', quantity: 'ratio', unit: '×Fz/rad', basic: true, hint: 'pVy3: extra side force per radian of lean toward the turn, × load. Leaning away costs the same.' },
  pCy1: { label: 'Lateral shape C', quantity: 'ratio', unit: '', basic: true, hint: 'pCy1: sets how much grip is left once sliding: sliding ÷ peak = sin(C·π/2) (1.3 → 89 %).' },
  pKy1: { label: 'Cornering stiffness', quantity: 'ratio', unit: '×Fz0/rad', basic: true, hint: 'pKy1: side force per radian of slip angle at small slip (peak of the stiffness vs load curve), × Fz0.' },
  pDx1: { label: 'Peak longitudinal μ at Fz0', quantity: 'ratio', unit: '', basic: true, hint: 'pDx1: peak braking / drive force ÷ load at the nominal load.' },
  pCx1: { label: 'Longitudinal shape C', quantity: 'ratio', unit: '', basic: true, hint: 'pCx1: locked / spinning share of peak = sin(C·π/2) (1.5 → 71 %).' },
  pEy1: { label: 'Lateral curvature E', quantity: 'ratio', unit: '', hint: 'pEy1 (≤ 1): shape near the peak; lower = rounder peak.' },
  pEy2: { label: 'Curvature change with load', quantity: 'ratio', unit: '', hint: 'pEy2: E change per +100 % load.' },
  pKy2: { label: 'Load at max cornering stiffness', quantity: 'ratio', unit: '×Fz0', hint: 'pKy2: load (× Fz0) where cornering stiffness stops growing with load.' },
  pKy3: { label: 'Cornering stiffness loss with camber', quantity: 'ratio', unit: '/rad', hint: 'pKy3: stiffness × (1 − pKy3·|γ|).' },
  ppy1: { label: 'Cornering stiffness change with pressure', quantity: 'ratio', unit: '', hint: 'ppy1: stiffness × (1 + ppy1·dp), dp = (p − p0) / p0.' },
  ppy3: { label: 'Lateral μ change with pressure', quantity: 'ratio', unit: '', hint: 'ppy3: peak μ × (1 + ppy3·dp). Negative = more pressure, less grip.' },
  pDx2: { label: 'Longitudinal μ change with load', quantity: 'ratio', unit: '', hint: 'pDx2: change in peak μ per +100 % load.' },
  pDx3: { label: 'Longitudinal peak loss with camber', quantity: 'ratio', unit: '/rad²', hint: 'pDx3: peak × (1 − pDx3·γ²).' },
  pEx1: { label: 'Longitudinal curvature E', quantity: 'ratio', unit: '', hint: 'pEx1 (≤ 1).' },
  pKx1: { label: 'Slip stiffness', quantity: 'ratio', unit: '×Fz', hint: 'pKx1: braking / drive force per unit slip ratio at small slip, × load.' },
  ppx3: { label: 'Longitudinal μ change with pressure', quantity: 'ratio', unit: '', hint: 'ppx3: peak μ × (1 + ppx3·dp).' },
};
export const defaultTireGrip = (): Record<MFKey, Field> =>
  Object.fromEntries(MF_KEYS.map((k) => [k, field(DEFAULT_MF[k], MF_META[k].quantity)])) as Record<MFKey, Field>;

export const OPT_DEFAULT_RANGE = 25;

let dimCounter = 0;
export const newDimId = () => `dim-${Date.now().toString(36)}-${(dimCounter++).toString(36)}`;

export function defaultOptimizerSetup(): OptimizerSetup {
  return {
    ranges: {},
    goals: Object.fromEntries(GOAL_KINDS.map((k) => [k, { on: false, target: field(GOAL_META[k].target, 'ratio'), weight: field(1, 'ratio') }])) as Record<GoalKind, GoalSetting>,
    rollAngle: field(2, 'angle'),
    rackCheck: field(0),
    keepClose: field(0.01, 'ratio'),
    rollLoadFactor: field(1.5, 'ratio'),
  };
}

export interface DesignState {
  presetId: string;
  geom: EditableGeometry;
  spring: Record<SpringKey, Field>;
  damper: Record<DamperKey, Field>;
  bumpStop: boolean;
  /** Damper force curve (linear, two-stage, or dyno curves). */
  damperMode: DamperMode;
  /** Dyno curves and clicker (damperMode 'curve'). */
  damperCurve?: DamperCurveText;
  steer: Record<SteerKey, Field>;
  /** Measured steering ratio: 'steering-wheel °, input' pairs, one per line ('' = none; replaces the c-factors). */
  steerCurve?: string;
  /**
   * Each steering mechanism's own ratio and limit (rack mm, arm degrees), kept while the other one is in
   * use and put back when switching to it again.
   */
  steerSaved: Partial<Record<SteerMechanism, Record<MechSteerKey, Field>>>;
  tireModel: TireModelKind;
  tire: Record<TireKey, Field>;
  volumeChange: boolean;
  tireSizeText: string;
  droop: number;
  bump: number;
  driver: Extract<TravelDriver, 'wheelCenter' | 'contactPatch'>;
  /** All four corners. The active corner's root design lives in the working fields above. */
  corners: Record<CornerId, CornerDesign>;
  links: CornerLinks;
  settings: Record<CornerId, CornerSettings>;
  activeCorner: CornerId;
  vehicle: Record<VehicleKey, Field>;
  /** Fit each corner's spring preload so the static car sits at its design ride height. */
  autoPreload: boolean;
  /** Corner workbench load: the vehicle's static load for that corner, or a manual value. */
  cornerLoadMode: 'vehicle' | 'manual';
  shared: Record<Axle, SharedDesign>;
  /** Locked values (see locks.ts for the key format). The optimizer must work around them. */
  locks: Record<string, true>;
  /** Locks set by the setup wizard: lock key → the step that set it (a subset of `locks`). */
  wizardLocks: Record<string, SetupStep>;
  /** Optimizer setup per corner design (keyed by root corner). */
  optimizer: Partial<Record<CornerId, OptimizerSetup>>;
  /** Whole-vehicle optimizer setup. */
  vehicleOptimizer: VehicleOptimizerSetup;
  /** Tire grip model. */
  grip: Record<GripKey, Field>;
  /** Tire grip model (Magic Formula coefficients). */
  tireGrip: Record<MFKey, Field>;
  /** A tire model loaded from a `.tir` file: used instead of the simple coefficients while set (front, or both axles). */
  tireFile: TirModel | null;
  /** Rear tires: null = the same as the front, 'simple' = the simple coefficients, or their own file. */
  tireFileRear: TirModel | 'simple' | null;
  /** Aerodynamics (off = negligible). Generic values, or characteristics imported from a file (e.g. CFD). */
  aero: AeroSettings;
  /** Brake hydraulics (off = the brakes are always strong enough). */
  brakes: BrakeSettings;
  /** Shimmy / death wobble inputs. */
  shimmy: ShimmySettings;
  /** Towing a trailer (off = no trailer). */
  tow: TowSettings;
  /** Setup wizard: which steps hold the user's own values and which are estimates (results say so). */
  setupStatus: Partial<Record<SetupStep, 'entered' | 'estimated'>>;
  /** Held dimensions between two points (Measure → set, hold). Kept like CAD sketch dimensions. */
  dimensions: HeldDimension[];
  /** Tests (chains of segments) for the Tests workspace. */
  tests: TestDesign[];
}

/** A held dimension of one corner design. travel null = permanent (part dimension). */
export interface HeldDimension {
  id: string;
  root: CornerId;
  a: PointKey;
  b: PointKey;
  measure: DimMeasure;
  /** mm or degrees. */
  value: number;
  travel: number | null;
}

/** The working (active corner) fields as a CornerDesign. */
export const workingDesign = (s: CornerDesign): CornerDesign => ({
  geom: s.geom, spring: s.spring, damper: s.damper, bumpStop: s.bumpStop, damperMode: s.damperMode, ...(s.damperCurve ? { damperCurve: s.damperCurve } : {}), tireModel: s.tireModel,
  tire: s.tire, volumeChange: s.volumeChange, tireSizeText: s.tireSizeText,
});

/** All corner designs with the working fields written back into the active corner's root. */
export function mergedCorners(s: DesignState): Record<CornerId, CornerDesign> {
  return { ...s.corners, [rootOf(s.activeCorner, s.links)]: workingDesign(s) };
}

/** The design each corner actually uses (links resolved). */
export function resolvedCorner(s: DesignState, id: CornerId): CornerDesign {
  return mergedCorners(s)[rootOf(id, s.links)];
}

/** Static corner loads (N) from the vehicle mass and CG. */
export function vehicleStaticLoads(
  vehicle: Record<VehicleKey, Field>, corners: Record<CornerId, CornerDesign>, links: CornerLinks,
): Record<CornerId, number> {
  const contactX = Object.fromEntries(CORNER_IDS.map((id) => {
    const g = corners[rootOf(id, links)].geom;
    const radius = g.scalars.tireDiameter.value / 2;
    const camber = (g.scalars.staticCamber.value * Math.PI) / 180;
    return [id, toGeometry(g).wheel.center.x - radius * Math.sin(camber)];
  })) as Record<CornerId, number>;
  const v = vehicle;
  return staticCornerLoads(v.mass.value, vec3(v.cgX.value, v.cgY.value, v.cgZ.value), v.wheelbase.value, contactX);
}

/** The design part of the app state (what a file saves). */
export const pickDesign = (s: DesignState): DesignState => ({
  presetId: s.presetId, geom: s.geom, spring: s.spring, damper: s.damper, bumpStop: s.bumpStop, damperMode: s.damperMode, ...(s.damperCurve ? { damperCurve: s.damperCurve } : {}), steer: s.steer, steerSaved: s.steerSaved,
  tireModel: s.tireModel, tire: s.tire, volumeChange: s.volumeChange, tireSizeText: s.tireSizeText,
  droop: s.droop, bump: s.bump, driver: s.driver,
  corners: s.corners, links: s.links, settings: s.settings, activeCorner: s.activeCorner,
  vehicle: s.vehicle, autoPreload: s.autoPreload, cornerLoadMode: s.cornerLoadMode, shared: s.shared, locks: s.locks, wizardLocks: s.wizardLocks,
  optimizer: s.optimizer, vehicleOptimizer: s.vehicleOptimizer, grip: s.grip, tireGrip: s.tireGrip, tireFile: s.tireFile, tireFileRear: s.tireFileRear, setupStatus: s.setupStatus, aero: s.aero, brakes: s.brakes, shimmy: s.shimmy, tow: s.tow, dimensions: s.dimensions, tests: s.tests,
});

/** The default layout (File → New). */
export const DEFAULT_LINKS: CornerLinks = { frontPair: true, rearPair: true, rearFromFront: true };
export const DEFAULT_SETTINGS: Record<CornerId, CornerSettings> = {
  FL: { steered: true, powered: false, brake: 'outboard', drive: 'chassis', abs: true, diff: 'open' }, FR: { steered: true, powered: false, brake: 'outboard', drive: 'chassis', abs: true, diff: 'open' },
  RL: { steered: false, powered: true, brake: 'outboard', drive: 'chassis', abs: true, diff: 'open' }, RR: { steered: false, powered: true, brake: 'outboard', drive: 'chassis', abs: true, diff: 'open' },
};
export const defaultShared = (): SharedDesign => ({
  antiRollBar: 'none',
  arbRate: field(15, 'rate'),
  // ≈ 15 N/mm at the wheel with the default 100 mm arm and drop-link position.
  barRate: field(5, 'torsion'),
  lever: field(100),
  dropLink: [field(450), field(41.5), field(60)],
  heaveSpring: 'none',
  heaveRate: field(30, 'rate'),
});
export const defaultVehicle = (): Record<VehicleKey, Field> => ({
  mass: field(300, 'mass'),
  cgX: field(0),
  cgY: field(280),
  cgZ: field(-728.5),
  wheelbase: field(1550),
  brakeBias: field(60, 'percent'),
  driveSplit: field(50, 'percent'),
  rollInertia: field(35, 'ratio'),
  pitchInertia: field(100, 'ratio'),
  yawInertia: field(140, 'ratio'),
  tireDamping: field(100, 'damping'), relaxation: field(0), rollingResistance: field(0.012, 'ratio'),
});

export function defaultDesign(presetId = 'C'): DesignState {
  const geom = editableFromLayout(presetId);
  const vehicle = defaultVehicle();
  const base: CornerDesign = {
    geom,
    spring: {
      cornerLoad: field(900, 'force'),
      unsprungMass: field(12, 'mass'),
      springRate: field(SAMPLE_SPRING.rate, 'rate'),
      freeLength: field(SAMPLE_SPRING.freeLength),
    },
    damper: {
      maxLength: field(430), minLength: field(330), bumpStopLength: field(345), bumpStopRate: field(400, 'rate'),
      bumpDamping: field(1500, 'damping'), reboundDamping: field(2500, 'damping'),
      // Generic two-stage (digressive) curve: half the rate past a 0.1 m/s knee.
      bumpDampingHigh: field(750, 'damping'), reboundDampingHigh: field(1250, 'damping'), bumpKnee: field(0.1, 'ratio'), reboundKnee: field(0.1, 'ratio'),
    },
    bumpStop: true,
    damperMode: 'linear',
    tireModel: 'gas',
    tire: Object.fromEntries(TIRE_KEYS.map((k) => [k, field(TIRE_META[k].initial, TIRE_META[k].quantity)])) as Record<TireKey, Field>,
    volumeChange: true,
    tireSizeText: '',
  };
  // Fit the shared spring to the front-left static load so the corner workbench starts at ride height.
  const fl = Math.round(vehicleStaticLoads(vehicle, { FL: base, FR: base, RL: base, RR: base }, DEFAULT_LINKS).FL);
  const design: CornerDesign = { ...base, spring: fittedSpring(geom, { ...base.spring, cornerLoad: field(fl, 'force') }) };
  return {
    presetId,
    ...design,
    steer: Object.fromEntries(STEER_KEYS.map((k) => [k, field(STEER_META[k].initial, STEER_META[k].quantity)])) as Record<SteerKey, Field>,
    steerSaved: {},
    droop: 50,
    bump: 50,
    driver: 'wheelCenter',
    corners: { FL: design, FR: design, RL: design, RR: design },
    links: { ...DEFAULT_LINKS },
    settings: structuredClone(DEFAULT_SETTINGS),
    activeCorner: 'FL',
    vehicle,
    autoPreload: true,
    cornerLoadMode: 'vehicle',
    shared: { front: defaultShared(), rear: defaultShared() },
    locks: {},
    wizardLocks: {},
    optimizer: {},
    vehicleOptimizer: defaultVehicleOptimizerSetup(),
    grip: defaultGrip(),
    tireGrip: defaultTireGrip(),
    tireFile: null,
    tireFileRear: null,
    setupStatus: {},
    aero: defaultAero(),
    brakes: defaultBrakes(),
    shimmy: defaultShimmy(),
    tow: defaultTow(),
    dimensions: [],
    tests: [],
  };
}

/** Optional URL overrides, e.g. ?preset=A&view=iso&travel=30&rack=10&labels=1 */
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);
const VIEW_NAMES: ViewName[] = ['front', 'rear', 'outboard', 'inboard', 'top', 'bottom', 'iso'];
const initialView = (VIEW_NAMES as string[]).includes(params.get('view') ?? '') ? (params.get('view') as ViewName) : 'iso';
const initialPreset = PRESET_LAYOUTS.some((l) => l.id === params.get('preset')) ? params.get('preset')! : 'C';

const initialDesign = defaultDesign(initialPreset);

export const useApp = create<AppState>((set, get) => ({
  ...initialDesign,
  travel: num('travel', 0),
  rack: num('rack', 0),
  playing: false,
  playingSteer: false,
  trails: true,
  simpleTire: false,
  ghosts: true,
  visibility: {
    chassis: true, uca: true, lca: true, upright: true, tieRod: true, wheel: true, spring: true,
    patch: true, steeringAxis: true, icConstruction: true, rollCenter: true, ground: true, datum: true, labels: params.get('labels') === '1',
    dimensions: true, ackermann: true, cg: true, arb: true, markerLabels: true,
  },
  projection: params.get('projection') === 'perspective' ? 'perspective' : 'orthographic',
  focus: 'corner',
  followFocus: false,
  cameraRequest: { view: initialView, nonce: 0 },

  tireModel: (['rigid', 'stiffness', 'gas'] as string[]).includes(params.get('tire') ?? '') ? (params.get('tire') as TireModelKind) : initialDesign.tireModel,
  tireSizeError: null,

  mode: params.get('mode') === 'loaded' ? 'loaded' : 'kinematic',
  loadFactor: num('load', 1),

  fileName: null,
  savedSnapshot: null,
  savedTests: null,
  notice: null,
  steerRemoved: [],
  saveAsOpen: false,

  workspace: params.get('workspace') === 'vehicle' ? 'vehicle' : 'corner',
  lateralG: num('g', 0),
  playingLateral: false,
  forceVis: { tireVertical: true, tireLateral: true, tireLongitudinal: true, springs: false, shared: false, weights: false, inertia: false },
  forceScale: 0.12,
  forceValues: true,
  longitudinalG: params.has('brake') ? -Math.abs(num('brake', 0)) : num('accel', 0),
  playingLongitudinal: false,
  suspendHtml: false,
  setShared: (axle, patch) => set({ shared: { ...get().shared, [axle]: { ...get().shared[axle], ...patch } } }),
  setSharedField: (axle, key, text) => {
    const a = get().shared[axle];
    set({ shared: { ...get().shared, [axle]: { ...a, [key]: parseField(text, SHARED_META[key].quantity, a[key]) } } });
  },
  setDropLink: (axle, axis, text) => {
    const a = get().shared[axle];
    const p = [...a.dropLink] as [Field, Field, Field];
    p[axis] = parseField(text, 'length', p[axis]);
    set({ shared: { ...get().shared, [axle]: { ...a, dropLink: p } } });
  },

  setActiveCorner: (id) => {
    const s = get();
    if (id === s.activeCorner) return;
    const corners = mergedCorners(s);
    const root = rootOf(id, s.links);
    set({
      corners, activeCorner: id, ...corners[root], damperCurve: corners[root].damperCurve,
      selection: null, measure: [], rack: s.settings[id].steered ? s.rack : 0,
    });
  },
  setLink: (key, value) => {
    const s = get();
    const before = mergedCorners(s);
    // A solid axle or twist beam is one part under both wheels: its left and right can't have different designs.
    if (!value && (key === 'frontPair' || key === 'rearPair')) {
      const kind = before[rootOf(key === 'frontPair' ? 'FL' : 'RL', s.links)].geom.kind;
      if (isOneAxle(kind)) {
        s.notify(`The ${key === 'frontPair' ? 'front' : 'rear'} is a ${SUSPENSION_LABELS[kind!].toLowerCase()}: one axle under both wheels, so its left and right share one design. Change the type to separate them.`, 'warn');
        return;
      }
    }
    const links = { ...s.links, [key]: value };
    // A corner that stops following another starts from a copy of the design it was using.
    const corners = { ...before };
    const locks = { ...s.locks };
    const wizardLocks = { ...s.wizardLocks };
    const optimizer = { ...s.optimizer };
    const dimensions = [...s.dimensions];
    for (const id of CORNER_IDS) {
      const oldRoot = rootOf(id, s.links);
      const newRoot = rootOf(id, links);
      if (newRoot === id && oldRoot !== id) {
        corners[id] = before[oldRoot];
        // The new copy starts with the same locks as the design it came from.
        for (const k of Object.keys(s.locks)) {
          if (!k.startsWith(`${oldRoot}.`)) continue;
          const nk = `${id}${k.slice(oldRoot.length)}`;
          locks[nk] = true;
          if (s.wizardLocks[k]) wizardLocks[nk] = s.wizardLocks[k];
        }
        // ...and the same optimizer setup.
        if (s.optimizer[oldRoot]) optimizer[id] = structuredClone(s.optimizer[oldRoot]);
        // ...and the same held dimensions.
        for (const d of s.dimensions) if (d.root === oldRoot) dimensions.push({ ...d, id: newDimId(), root: id });
      }
    }
    set({ links, corners, locks, wizardLocks, optimizer, dimensions, ...corners[rootOf(s.activeCorner, links)] });
  },
  toggleLock: (key) => {
    const locks = { ...get().locks };
    const wizardLocks = { ...get().wizardLocks };
    if (locks[key]) { delete locks[key]; delete wizardLocks[key]; } else locks[key] = true;
    set({ locks, wizardLocks });
  },
  setLocks: (keys, locked) => {
    const locks = { ...get().locks };
    const wizardLocks = { ...get().wizardLocks };
    for (const k of keys) { if (locked) locks[k] = true; else { delete locks[k]; delete wizardLocks[k]; } }
    set({ locks, wizardLocks });
  },
  clearLocks: () => set({ locks: {}, wizardLocks: {} }),
  lockFromWizard: (step, keys) => {
    const s = get();
    const locks = { ...s.locks };
    const wizardLocks = { ...s.wizardLocks };
    // Re-applying a step replaces what it locked before (e.g. a bar that is now off).
    for (const [k, st] of Object.entries(s.wizardLocks)) if (st === step) { delete locks[k]; delete wizardLocks[k]; }
    for (const k of keys) {
      if (locks[k] && !wizardLocks[k]) continue; // the user's own lock stays theirs
      locks[k] = true;
      wizardLocks[k] = step;
    }
    set({ locks, wizardLocks });
  },
  updateOptimizer: (fn) => {
    const s = get();
    const root = rootOf(s.activeCorner, s.links);
    set({ optimizer: { ...s.optimizer, [root]: fn(s.optimizer[root] ?? defaultOptimizerSetup()) } });
  },
  optUndo: null,
  applyOptimized: (updates) => {
    const s = get();
    const before = s.geom;
    s.setPointsAxis(updates.map((u) => ({ ...u, value: Number(u.value.toFixed(2)) })));
    set({ optUndo: { root: rootOf(s.activeCorner, s.links), geom: before } });
  },
  undoOptimized: () => {
    const s = get();
    if (!s.optUndo || s.optUndo.root !== rootOf(s.activeCorner, s.links)) return;
    set({ geom: s.optUndo.geom, optUndo: null, presetId: 'custom' });
  },
  updateVehicleOptimizer: (fn) => set({ vehicleOptimizer: fn(get().vehicleOptimizer) }),
  setGripField: (key, text) => {
    const g = get().grip;
    set({ grip: { ...g, [key]: parseField(text, GRIP_META[key].quantity, g[key]) } });
  },
  setTireGripField: (key, text) => {
    const g = get().tireGrip;
    set({ tireGrip: { ...g, [key]: parseField(text, MF_META[key].quantity, g[key]) } });
  },
  resetTireGrip: () => set({ tireGrip: defaultTireGrip() }),
  setTireFile: (m, axle = 'both') => {
    if (axle === 'both') set({ tireFile: m, tireFileRear: null });
    else if (axle === 'front') {
      // The rear keeps what it had: if it followed the front, it keeps the old front tire.
      const s = get();
      set({ tireFile: m, tireFileRear: s.tireFileRear ?? s.tireFile ?? 'simple' });
    } else set({ tireFileRear: m ?? 'simple' });
  },
  setRearTireSame: () => set({ tireFileRear: null }),
  updateDesigns: (axle, fn) => {
    const s = get();
    const merged = mergedCorners(s);
    const activeRoot = rootOf(s.activeCorner, s.links);
    const roots = new Set(CORNER_IDS.filter((id) => axle === 'both' || (axle === 'front') === (id === 'FL' || id === 'FR')).map((id) => rootOf(id, s.links)));
    const corners = { ...s.corners };
    let working: Partial<CornerDesign> = {};
    for (const root of roots) {
      const d1 = fn(root === activeRoot ? workingDesign(s) : merged[root]);
      if (root === activeRoot) working = d1;
      else corners[root] = d1;
    }
    set({ corners, ...working, presetId: 'custom' });
  },
  setAeroField: (key, text) => {
    const a = get().aero;
    set({ aero: { ...a, [key]: parseField(text, AERO_META[key].quantity, a[key]) } });
  },
  setAero: (patch) => set({ aero: { ...get().aero, ...patch } }),
  setBrakeField: (key, text) => {
    const b = get().brakes;
    set({ brakes: { ...b, [key]: parseField(text, BRAKE_META[key].quantity, b[key]) } });
  },
  setBrakes: (patch) => set({ brakes: { ...get().brakes, ...patch } }),
  setFadeField: (key, text) => {
    const b = get().brakes;
    set({ brakes: { ...b, [key]: parseField(text, FADE_META[key].quantity, b[key]) } });
  },
  setShimmyField: (key, text) => {
    const m = get().shimmy;
    set({ shimmy: { ...m, [key]: parseField(text, SHIMMY_META[key].quantity, m[key]) } });
  },
  setShimmy: (patch) => set({ shimmy: { ...get().shimmy, ...patch } }),
  setBrakeMoreField: (key, text) => {
    const b = get().brakes;
    set({ brakes: { ...b, [key]: parseField(text, BRAKE_MORE_META[key].quantity, b[key]) } });
  },
  setTowField: (key, text) => {
    const t = get().tow;
    set({ tow: { ...t, [key]: parseField(text, TOW_META[key].quantity, t[key]) } });
  },
  setTow: (patch) => set({ tow: { ...get().tow, ...patch } }),
  setSetupStatus: (step, status) => {
    const cur = { ...get().setupStatus };
    if (status) cur[step] = status; else delete cur[step];
    // An estimate (or clearing the step) frees what the step had locked.
    if (status !== 'entered') {
      const locks = { ...get().locks };
      const wizardLocks = { ...get().wizardLocks };
      for (const [k, st] of Object.entries(wizardLocks)) if (st === step) { delete locks[k]; delete wizardLocks[k]; }
      set({ setupStatus: cur, locks, wizardLocks });
      return;
    }
    set({ setupStatus: cur });
  },
  setTireScale: (key, value, axle = 'front') => {
    if (!(value > 0)) return;
    const s = get();
    if (axle === 'rear' && s.tireFileRear && s.tireFileRear !== 'simple') { set({ tireFileRear: { ...s.tireFileRear, p: { ...s.tireFileRear.p, [key]: value } } }); return; }
    if (s.tireFile) set({ tireFile: { ...s.tireFile, p: { ...s.tireFile.p, [key]: value } } });
  },
  applyTireDims: (axle, dims) => {
    const s = get();
    const merged = mergedCorners(s);
    const activeRoot = rootOf(s.activeCorner, s.links);
    const roots = new Set(CORNER_IDS.filter((id) => axle === 'both' || (axle === 'front') === (id === 'FL' || id === 'FR')).map((id) => rootOf(id, s.links)));
    const corners = { ...s.corners };
    let geom = s.geom;
    const patch = (g: EditableGeometry): EditableGeometry => ({
      ...g,
      scalars: {
        ...g.scalars,
        ...(dims.outerDiameter ? { tireDiameter: field(Number(dims.outerDiameter.toFixed(1))) } : {}),
        ...(dims.width ? { tireWidth: field(Number(dims.width.toFixed(1))) } : {}),
        ...(dims.rimDiameter ? { rimDiameter: field(Number(dims.rimDiameter.toFixed(1))) } : {}),
      },
    });
    for (const root of roots) {
      if (root === activeRoot) geom = patch(geom);
      else corners[root] = { ...merged[root], geom: patch(merged[root].geom) };
    }
    set({ corners, geom, presetId: 'custom' });
  },
  vehOptUndo: null,
  dimViolations: [],
  holdDimension: (d) => {
    const rest = get().dimensions.filter((x) => !(x.root === d.root && x.measure === d.measure
      && ((x.a === d.a && x.b === d.b) || (x.a === d.b && x.b === d.a))));
    set({ dimensions: [...rest, { ...d, id: newDimId() }] });
  },
  removeDimension: (id) => set({ dimensions: get().dimensions.filter((d) => d.id !== id), dimViolations: get().dimViolations.filter((v) => v !== id) }),
  applyRateValues: (updates) => {
    const s = get();
    const merged = mergedCorners(s);
    const activeRoot = rootOf(s.activeCorner, s.links);
    const corners = { ...s.corners };
    let spring = s.spring, damper = s.damper;
    const shared = { front: { ...s.shared.front }, rear: { ...s.shared.rear } };
    for (const u of updates) {
      if (u.section === 'shared' && u.axle) {
        const k = u.key as SharedFieldKey;
        shared[u.axle] = { ...shared[u.axle], [k]: field(Number(u.value.toFixed(3)), SHARED_META[k].quantity) };
        continue;
      }
      if (!u.root) continue;
      const v = Number(u.value.toFixed(1));
      if (u.root === activeRoot) {
        if (u.section === 'spring') spring = { ...spring, [u.key]: field(v, 'rate') };
        else damper = { ...damper, [u.key]: field(v, 'damping') };
      } else {
        const d = corners[u.root] ?? merged[u.root];
        corners[u.root] = u.section === 'spring'
          ? { ...d, spring: { ...d.spring, [u.key]: field(v, 'rate') } }
          : { ...d, damper: { ...d.damper, [u.key]: field(v, 'damping') } };
      }
    }
    set({ corners, spring, damper, shared, presetId: 'custom' });
  },
  applyVehicleOptimized: (updates) => {
    const s = get();
    const merged = mergedCorners(s);
    const activeRoot = rootOf(s.activeCorner, s.links);
    const before: Partial<Record<CornerId, EditableGeometry>> = {};
    const corners = { ...s.corners };
    let working = s.geom;
    for (const root of new Set(updates.map((u) => u.root))) {
      const g0 = root === activeRoot ? s.geom : merged[root].geom;
      before[root] = g0;
      const points = { ...g0.points };
      for (const u of updates.filter((x) => x.root === root)) {
        const triple = [...points[u.key]] as [Field, Field, Field];
        triple[u.axis] = field(Number(u.value.toFixed(2)));
        points[u.key] = triple;
      }
      const g1 = { ...g0, points };
      if (root === activeRoot) working = g1;
      else corners[root] = { ...merged[root], geom: g1 };
    }
    set({ corners, geom: working, presetId: 'custom', vehOptUndo: before });
  },
  undoVehicleOptimized: () => {
    const s = get();
    const snap = s.vehOptUndo;
    if (!snap) return;
    const merged = mergedCorners(s);
    const activeRoot = rootOf(s.activeCorner, s.links);
    const corners = { ...s.corners };
    let working = s.geom;
    for (const root of Object.keys(snap) as CornerId[]) {
      if (root === activeRoot) working = snap[root]!;
      else corners[root] = { ...merged[root], geom: snap[root]! };
    }
    set({ corners, geom: working, presetId: 'custom', vehOptUndo: null });
  },
  setCornerSetting: (id, key, value) => {
    const s = get();
    if (key === 'steered' && value && !canSteer(mergedCorners(s)[rootOf(id, s.links)].geom.kind)) {
      s.notify(`${CORNER_NAMES[id]} is a twist beam, which doesn't steer (the hub is fixed to the trailing arm: no knuckle or tie rod). Choose a type that steers for it first.`, 'warn');
      return;
    }
    set({ settings: { ...s.settings, [id]: { ...s.settings[id], [key]: value } }, ...(key === 'steered' && !value && id === s.activeCorner ? { rack: 0 } : {}) });
    if (key !== 'steered' || !value) return;
    // A steered corner needs a type that steers: a solid axle gets its knuckles, a twist beam can't.
    const root = rootOf(id, s.links);
    const g = mergedCorners(s)[root].geom;
    if (isBeam(g.kind) && !g.steeredAxle) {
      if (root === rootOf(s.activeCorner, s.links)) get().setSteeredAxle(true);
      else {
        const next: EditableGeometry = { ...g, steeredAxle: true, points: { ...g.points, ...steeredAxlePoints(g, s.vehicle.wheelbase.value) } };
        set({ corners: { ...get().corners, [root]: { ...get().corners[root], geom: next } } });
        get().notify(`${CORNER_NAMES[id]}: its solid axle is now a steered axle (knuckles on kingpins at the axle ends, a cross tie rod and a drag link) so it can steer.`, 'info');
      }
    }
  },
  setVehicleField: (key, text) => {
    const v = get().vehicle;
    set({ vehicle: { ...v, [key]: parseField(text, VEHICLE_META[key].quantity, v[key]) } });
  },
  applyDesign: (design, fileName, savedModel, savedTests = null) => set({
    ...design, ...design.corners[rootOf(design.activeCorner, design.links)], fileName, savedSnapshot: savedModel, savedTests, tireSizeError: null,
    travel: 0, rack: 0, loadFactor: 1, mode: 'kinematic', playing: false, playingSteer: false, steerRemoved: [],
    selection: null, measure: [], measureMode: false,
  }),
  markSaved: (fileName, model, tests) => set({ fileName, ...(model !== undefined ? { savedSnapshot: model } : {}), ...(tests !== undefined ? { savedTests: tests } : {}) }),
  notify: (text, kind = 'info', action) => set({ notice: { text, kind, ...(action ? { action } : {}) } }),
  setSuspensionKindFor: (id, kind) => {
    const prev = get().activeCorner;
    if (prev !== id) get().setActiveCorner(id);
    get().setSuspensionKind(kind);
    if (get().activeCorner !== prev) get().setActiveCorner(prev);
  },

  selection: null,
  leftTab: 'inspector',
  vehicleTab: 'inputs',
  roadGrade: 0,
  activeTestId: null,
  testView: null,
  rideView: null,
  vehicleSpeed: 0,
  updateTests: (fn) => set({ tests: fn(get().tests) }),
  roadBank: 0,
  wheelBumps: { FL: 0, FR: 0, RL: 0, RR: 0 },
  nudgeStep: 1,
  snapToGrid: true,
  gridSize: 1,
  interacting: false,
  measureMode: false,
  measure: [],

  select: (selection) => set(selection ? { selection, leftTab: 'inspector', customPick: null } : { selection, customPick: null }),
  customPick: null,
  previewGeometry: null,
  movePoints: (keys, delta) => {
    const geom = get().geom;
    const points = { ...geom.points };
    for (const k of new Set(keys)) {
      const [fx, fy, fz] = points[k];
      points[k] = fields(add(vec3(fx.value, fy.value, fz.value), delta));
    }
    set({ geom: { ...geom, points }, presetId: 'custom' });
  },
  setPointsAxis: (updates) => {
    const geom = get().geom;
    const points = { ...geom.points };
    for (const u of updates) {
      const triple = [...points[u.key]] as [Field, Field, Field];
      triple[u.axis] = field(u.value);
      points[u.key] = triple;
    }
    set({ geom: { ...geom, points }, presetId: 'custom' });
  },
  toggleSelectPoints: (keys) => {
    const sel = get().selection;
    const current = sel?.kind === 'point' ? [sel.id] : sel?.kind === 'points' ? sel.ids : [];
    const allIn = keys.every((k) => current.includes(k));
    const next = allIn ? current.filter((k) => !keys.includes(k)) : [...new Set([...current, ...keys])];
    set({
      selection: next.length === 0 ? null : next.length === 1 ? { kind: 'point', id: next[0]! } : { kind: 'points', ids: next },
      leftTab: 'inspector',
    });
  },
  movePoint: (key, delta) => {
    const geom = get().geom;
    const [fx, fy, fz] = geom.points[key];
    const moved = add(vec3(fx.value, fy.value, fz.value), delta);
    set({ geom: { ...geom, points: { ...geom.points, [key]: fields(moved) } }, presetId: 'custom' });
  },
  setPointAxis: (key, axis, value) => {
    const geom = get().geom;
    const triple = [...geom.points[key]] as [Field, Field, Field];
    triple[axis] = field(value);
    set({ geom: { ...geom, points: { ...geom.points, [key]: triple } }, presetId: 'custom' });
  },
  setArmDerived: (arm, which, text) => {
    const r = parseValue(text, which === 'length' ? 'length' : 'angle');
    if (!r.ok) return;
    const geom = get().geom;
    const g = toGeometry(geom);
    const a = g[arm];
    const next = which === 'length' ? setArmLength(a, r.value)
      : which === 'inclination' ? setPivotInclination(a, (r.value * Math.PI) / 180)
        : which === 'planAngle' ? setPivotPlanAngle(a, (r.value * Math.PI) / 180)
          : setArmFrontViewAngle(a, (r.value * Math.PI) / 180);
    const kF = arm === 'uca' ? 'ucaFwd' : 'lcaFwd';
    const kA = arm === 'uca' ? 'ucaAft' : 'lcaAft';
    set({ geom: { ...geom, points: { ...geom.points, [kF]: fields(next.fwd), [kA]: fields(next.aft) } }, presetId: 'custom' });
  },
  setDamperField: (key, text) => {
    const d = get().damper;
    set({ damper: { ...d, [key]: parseField(text, DAMPER_META[key].quantity, d[key]) } });
  },
  setSteerField: (key, text) => {
    const st = get().steer;
    set({ steer: { ...st, [key]: parseField(text, STEER_META[key].quantity, st[key]) } });
  },
  toggleMeasure: () => set({ measureMode: !get().measureMode, measure: [], vehicleMeasure: [] }),
  vehicleMeasure: [],
  addVehicleMeasure: (a) => {
    const m = get().vehicleMeasure;
    if (m.length === 1 && m[0] === a) { get().notify('That is the point you picked first: pick a different one to measure to.', 'warn'); return; }
    set({ vehicleMeasure: m.length >= 2 ? [a] : [...m, a] });
  },
  startMeasure: (ids) => set({ measureMode: true, measure: ids.slice(0, 2) }),
  lineMove: null,
  addMeasureAnchor: (a, at) => {
    const m = get().measure;
    if (m.length === 1) {
      // A measurement needs two different points: the same point (or another one at the same place) again is refused.
      const same = m[0] === a || (at && firstMeasurePos && Math.hypot(at.x - firstMeasurePos.x, at.y - firstMeasurePos.y, at.z - firstMeasurePos.z) < 0.01);
      if (same) { get().notify('That is the point you picked first: pick a different one to measure to.', 'warn'); return; }
    }
    if (m.length !== 1) firstMeasurePos = at ?? null;
    set({ measure: m.length >= 2 ? [a] : [...m, a] });
  },

  setSpringField: (key, text) => {
    const spring = get().spring;
    set({ spring: { ...spring, [key]: parseField(text, SPRING_META[key].quantity, spring[key]) } });
  },
  setDamperArm: (arm) => {
    const geom = get().geom;
    if (arm === geom.damperArm) return;
    const g = toGeometry(geom);
    // Move the coilover as a unit: the arm mount goes to the same relative spot on the other arm and
    // the chassis mount follows by the same amount, so the installed length and angle (and therefore
    // the damper stroke and bump-stop settings) stay valid. On the knuckle: a quarter of the way up from
    // the lower ball joint, 35 mm inboard; from the knuckle to an arm: 80 % of the way out.
    const from = geom.damperArm, bj = (a: 'uca' | 'lca') => g[a].out;
    const moved = from !== 'upright' && arm !== 'upright'
      ? transferArmPoint(g.damper!.armPoint, g[from], g[arm])
      : arm === 'upright'
        ? add(bj('lca'), vec3(0.25 * (bj('uca').x - bj('lca').x) - 35, 0.25 * (bj('uca').y - bj('lca').y), 0.25 * (bj('uca').z - bj('lca').z)))
        : (() => { const a = g[arm]; const f = vec3((a.fwd.x + a.aft.x) / 2, (a.fwd.y + a.aft.y) / 2, (a.fwd.z + a.aft.z) / 2); return vec3(f.x + 0.8 * (a.out.x - f.x), f.y + 0.8 * (a.out.y - f.y) + 5, f.z + 0.8 * (a.out.z - f.z) + 30); })();
    const shift = sub(moved, g.damper!.armPoint);
    const chassisMount = add(g.damper!.chassis, shift);
    const next: EditableGeometry = {
      ...geom, damperArm: arm,
      points: { ...geom.points, dmpArm: fields(moved), dmpChassis: fields(chassisMount) },
    };
    set({ geom: next, presetId: 'custom', spring: fittedSpring(next, get().spring) });
  },
  setSteerMechanism: (m) => {
    const s = get();
    const from = s.geom.steerMechanism ?? 'rack';
    if (from === m) return;
    s.updateDesigns('both', (d) => {
      const geom = { ...d.geom, steerMechanism: m };
      if (m !== 'centerLink') return { ...d, geom };
      // A center link: lay one out around the inner tie-rod joint the first time (or when its points are far from it).
      const v = (k: PointKey) => vec3(geom.points[k][0].value, geom.points[k][1].value, geom.points[k][2].value);
      const i = v('trInner');
      if (s.steerSaved.centerLink && Math.hypot(v('pitEnd').x - i.x, v('pitEnd').y - i.y, v('pitEnd').z - i.z) < 200) return { ...d, geom };
      const lay = centerLinkDefaults(i) as Record<'pitEnd' | 'idlPiv1' | 'idlPiv2' | 'idlEnd', [Field, Field, Field]>;
      const pe = vec3(lay.pitEnd[0].value, lay.pitEnd[1].value, lay.pitEnd[2].value);
      return { ...d, geom: { ...geom, points: { ...geom.points, ...lay, strPiv1: fields(vec3(pe.x, pe.y - 60, pe.z + 150)), strPiv2: fields(vec3(pe.x, pe.y + 90, pe.z + 150)) } } };
    });
    // The ratio and limit belong to the mechanism (mm vs degrees): keep the current ones with it and put
    // back the other mechanism's own (first time: typical values; arm 1 : 1 like ATV handlebars, ±40°).
    const f = (v: number) => ({ text: String(v), value: v });
    const keep = Object.fromEntries(MECH_STEER_KEYS.map((k) => [k, s.steer[k]])) as Record<MechSteerKey, Field>;
    const saved = s.steerSaved[m];
    const back = saved ?? { cFactor: f(m === 'arm' ? 360 : m === 'centerLink' ? 24 : 75), cFactorLock: f(0), rackLimit: f(m === 'rack' ? 30 : 40) };
    set({ steer: { ...get().steer, ...back }, steerSaved: { ...s.steerSaved, [from]: keep }, rack: 0 });
    const what = `${back.cFactor.value} ${angleInput(m) ? '°' : 'mm'}/rev, ±${back.rackLimit.value} ${angleInput(m) ? '°' : 'mm'}`;
    if (m === 'centerLink') { get().notify(`Pitman arm, idler arm and center link: the steering box turns the pitman arm (FL_Str_Piv1–2, its ball end FL_Pitman_End); the center link runs from it to the idler arm (FL_Idler_Piv1–2, FL_Idler_End) and carries the inner tie-rod joints. The input is the pitman's angle (°): ${saved ? 'your values are back' : 'typical values'} (${what}). Each corner sees the linkage mirrored, so left and right behave alike.`, 'info'); return; }
    get().notify(m === 'arm'
      ? `Steering arm / plate: the inner tie-rod joints swing about the arm's pivot axis (FL_Str_Piv1–2). The steering input is the arm angle (°): ${saved ? 'your arm values are back' : 'typical values'} (${what}). The rack's values are kept for switching back.`
      : `Rack: the steering input is rack travel (mm): ${saved ? 'your rack values are back' : 'typical values'} (${what}). The arm's values are kept for switching back.`, 'info');
  },
  setRackSide: (ahead) => {
    const geom = get().geom;
    if (rackAhead(geom) === ahead) return;
    try {
      const next = flipRackSide(geom);
      new DoubleWishbone(toGeometry(next)).design();
      set({ geom: next, presetId: 'custom' });
      get().notify(`Rack ${ahead ? 'ahead of' : 'behind'} the axle: the steering arm was mirrored through the steering axis (same Ackermann line); the rack now moves the other way for the same turn.`, 'info');
    } catch (err) { get().notify(`Can't move the rack: ${err instanceof Error ? err.message : String(err)}`, 'error'); }
  },
  setSpringLayout: (layout) => {
    const geom = get().geom;
    if (layoutOf(geom) === layout) return;
    if (layout === 'rocker' && !rockerAllowed(geom.kind ?? 'doubleWishbone')) { get().notify('A pushrod and rocker needs an arm or knuckle to push from (not a MacPherson strut or a rigid corner).', 'warn'); return; }
    const p = (k: PointKey) => vec3(geom.points[k][0].value, geom.points[k][1].value, geom.points[k][2].value);
    let next: EditableGeometry;
    if (layout === 'rocker') {
      // Pushrod from where the coilover's lower mount was, to a rocker near its top; the spring on the rocker.
      const body = (geom.kind ?? 'doubleWishbone') === 'doubleWishbone' ? geom.damperArm : geom.damperArm === 'upright' ? 'upright' : 'lca';
      const lay = rockerFromCoilover(p('dmpChassis'), p('dmpArm'), body);
      next = {
        ...geom, springLayout: 'rocker', pushrodOn: body,
        points: { ...geom.points, rkrPiv1: fields(lay.rocker.pivot1), rkrPiv2: fields(lay.rocker.pivot2), prArm: fields(lay.rocker.pushrodLower), prRkr: fields(lay.rocker.pushrodUpper), dmpChassis: fields(lay.damper.chassis), dmpArm: fields(lay.damper.armPoint) },
      };
    } else {
      // Back to a coilover: from the pushrod's lower end up to the rocker pivot.
      const lo = p('prArm'), a = p('rkrPiv1'), b = p('rkrPiv2');
      next = { ...geom, springLayout: 'coilover', damperArm: geom.pushrodOn ?? 'lca', points: { ...geom.points, dmpArm: fields(lo), dmpChassis: fields(vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)) } };
    }
    try { new DoubleWishbone(toGeometry(next)).design(); } catch (err) { get().notify(`Can't switch the spring layout: ${err instanceof Error ? err.message : String(err)}`, 'error'); return; }
    set({ geom: next, presetId: 'custom', spring: fittedSpring(next, get().spring) });
    get().notify(layout === 'rocker'
      ? 'Pushrod + rocker: the pushrod starts at the old coilover mount and runs to a rocker near its top (levers square to their links, 60 / 50 mm); the spring keeps its length on the rocker. Move the points to shape the motion ratio.'
      : 'Coilover: from the pushrod\'s lower end up to where the rocker pivot was.', 'info');
  },
  setCustom: (c) => set({ geom: { ...get().geom, custom: c }, presetId: 'custom' }),
  setBushing: (which, text) => {
    const g = get().geom;
    const b = g.bushing ?? { radial: field(5000, 'rate'), axial: field(1500, 'rate') };
    const f = parseField(text, 'rate', b[which]);
    if (!(f.value > 0)) { get().notify('Bushing stiffness must be above 0.', 'warn'); return; }
    set({ geom: { ...g, bushing: { ...b, [which]: f } }, presetId: 'custom' });
  },
  setSteeredAxle: (on) => {
    const s = get();
    const geom = s.geom;
    if (!isBeam(geom.kind) || !!geom.steeredAxle === on) return;
    let next: EditableGeometry = { ...geom, steeredAxle: on };
    if (on) next = { ...next, points: { ...geom.points, ...steeredAxlePoints(geom, s.vehicle.wheelbase.value) } };
    try { new DoubleWishbone(toGeometry(next)).design(); } catch (err) {
      get().notify(`Can't steer this axle: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    set({ geom: next, presetId: 'custom' });
    if (on) get().notify('Steered axle: each wheel turns on a kingpin at the axle end (UCA_Out2 top, LCA_Out2 bottom). A cross tie rod joins the knuckle arms (TR_Out and its mirror), set behind the kingpins pointing at the rear axle (Ackermann), and a drag link runs from the steering (TR_In, moved by the rack) to the left arm. Its angle against the axle\'s links sets the bump steer.', 'info');
  },
  setCornerPoint: (id, key, v) => {
    const s = get();
    const root = rootOf(id, s.links);
    if (root === rootOf(s.activeCorner, s.links)) {
      set({ geom: { ...s.geom, points: { ...s.geom.points, [key]: fields(v) } }, presetId: 'custom' });
      return;
    }
    const c = s.corners[root];
    set({ corners: { ...s.corners, [root]: { ...c, geom: { ...c.geom, points: { ...c.geom.points, [key]: fields(v) } } } }, presetId: 'custom' });
  },
  setPushrodOn: (on) => {
    const geom = get().geom;
    if ((geom.pushrodOn ?? 'lca') === on) return;
    const g = toGeometry(geom);
    const lo = g.rocker?.pushrodLower;
    if (!lo) return;
    const from = geom.pushrodOn ?? 'lca';
    const moved = from !== 'upright' && on !== 'upright' ? transferArmPoint(lo, g[from as 'uca' | 'lca'], g[on]) : lo;
    set({ geom: { ...geom, pushrodOn: on, points: { ...geom.points, prArm: fields(moved) } }, presetId: 'custom' });
  },
  setSuspensionKind: (kind) => {
    if ((get().geom.kind ?? 'doubleWishbone') === kind) return;
    // A solid axle or twist beam belongs to one axle: if the rear shares the front's design, give this axle its own first.
    if ((isBeam(kind) || kind === 'twistBeam') && get().links.rearFromFront) get().setLink('rearFromFront', false);
    const geom = get().geom;
    const next = convertGeometry(geom, kind);
    try { new DoubleWishbone(toGeometry(next)).design(); } catch (err) {
      get().notify(`Can't switch to ${SUSPENSION_LABELS[kind]}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    set({ geom: next, presetId: 'custom', spring: fittedSpring(next, get().spring), selection: null });
    // A solid axle or twist beam spans the axle: its left and right corners share this design (the left
    // corner takes it first, so it isn't lost when the right one starts following the left).
    if (isOneAxle(kind)) {
      const s = get();
      const front = s.activeCorner === 'FL' || s.activeCorner === 'FR';
      const pair = front ? 'frontPair' : 'rearPair';
      if (!s.links[pair]) {
        const all = mergedCorners(s);
        set({ corners: { ...all, [rootOf(front ? 'FL' : 'RL', s.links)]: all[rootOf(s.activeCorner, s.links)] } });
        get().setLink(pair, true);
      }
    }
    // A steered corner gets a steered axle (a twist beam can't steer: said below).
    if (isBeam(kind) && get().settings[get().activeCorner].steered && !get().geom.steeredAxle) get().setSteeredAxle(true);
    // A twist beam's beam twists like an anti-roll bar: start from a typical stiffness if the axle has none.
    if (kind === 'twistBeam') {
      const axle = get().activeCorner === 'FL' || get().activeCorner === 'FR' ? 'front' : 'rear';
      const sh = get().shared[axle];
      if (sh.antiRollBar === 'none') { get().setShared(axle, { antiRollBar: 'wheelRate' }); get().setSharedField(axle, 'arbRate', '15'); }
    }
    // Steering: a type that can't steer (a twist beam) turns it off on its corners, remembered; choosing a
    // type that steers again offers to add it back.
    const st = get();
    const ids = CORNER_IDS.filter((c) => rootOf(c, st.links) === rootOf(st.activeCorner, st.links));
    let steerNote = '';
    let action: NoticeAction | undefined;
    if (!canSteer(kind)) {
      const off = ids.filter((c) => st.settings[c].steered);
      if (off.length) {
        set({
          settings: { ...st.settings, ...Object.fromEntries(off.map((c) => [c, { ...st.settings[c], steered: false }])) },
          steerRemoved: [...new Set([...st.steerRemoved, ...off])], rack: 0, playingSteer: false,
        });
        steerNote = `

Steering turned off for ${off.join(', ')}: a twist beam doesn't steer. Choosing a type that steers offers to add it back.`;
      }
    } else {
      const back = st.steerRemoved.filter((c) => ids.includes(c));
      if (back.length) {
        set({ steerRemoved: st.steerRemoved.filter((c) => !back.includes(c)) });
        steerNote = `

${back.join(', ')} steered before the twist beam turned it off. This type steers: add steering back?`;
        action = { label: `Add steering back (${back.join(', ')})`, run: () => { for (const c of back) get().setCornerSetting(c, 'steered', true); } };
      }
    }
    get().notify(`${SUSPENSION_LABELS[kind]}: ${kind === 'custom' ? 'edit its bodies and joints in the Linkage editor (Inspector, with nothing selected). It starts from the current arms as hinged bodies with ball joints to the knuckle and the tie rod as a rod from the rack, so it moves the same; add bodies, hinges, ball joints and rods to build anything with one free motion.' : kind === 'twistBeam' ? 'each hub is fixed to its trailing arm, which swings about the line from its bushing to the beam\'s shear center (on the centerline); the beam\'s twist stiffness is this axle\'s anti-roll bar (Shared components; started at 15 N/mm at the wheel if there was none). Moving the shear center back adds roll camber and roll steer.' : kind === 'beamLeaf' ? 'a solid axle on leaf springs (left and right now share this design): set the front eye, the spring seat on the axle and the rear shackle; the spring rate is the leaf rate at the seat. Roll center ≈ the seat height.' : isBeam(kind) ? `one axle carries both wheels (left and right now share this design). Lower links run forward from the axle, ${kind === 'beam4' ? 'the upper links angle in to locate it sideways' : kind === 'beamWatts' ? 'one upper link in the middle and a Watt\'s linkage locate it (its pivot on the axle moves straight up and down: no sideways shift)' : 'one upper link in the middle and a Panhard rod locate it'}; coilovers sit on the axle. Move the link ends to shape it. Steered (Inspector → Steered axle): knuckles on kingpins at the axle ends.` : kind === 'singleArm' ? 'the knuckle now rides on the lower arm, turning on a kingpin from the lower to the upper ball joint\'s position (both on the arm); the arm swings on its frame pivots. Move the pivots along the car for a swing arm, across it for a trailing arm.' : kind === 'rigid' ? 'the wheel turns on a fixed kingpin through the ball joints\' positions; no spring or travel (only the tire gives).' : kind === 'macpherson' ? 'a strut was placed from the upright (top mount above the upper ball joint); adjust its points.' : kind === 'multilink' ? `each link now ends at its own point on the upright (moved 35 mm along the link: the same motion at ride height, nearly the same through travel); move them to shape the motion.${geom.kind === 'doubleWishbone' || !geom.kind ? ' The coilover now mounts on the upright (a multilink has no arm body), so check its motion ratio.' : ''}` : 'the links rejoin at one ball joint per arm.'}${steerNote}`, 'info', action);
  },
  fitSpring: () => {
    const s = get();
    const load = s.cornerLoadMode === 'vehicle' ? vehicleStaticLoads(s.vehicle, mergedCorners(s), s.links)[s.activeCorner] : undefined;
    set({ spring: fittedSpring(s.geom, s.spring, load) });
  },

  setTireField: (key, text) => {
    const tire = get().tire;
    set({ tire: { ...tire, [key]: parseField(text, TIRE_META[key].quantity, tire[key]) } });
  },
  applyTireSize: (text) => {
    const size = parseTireSize(text);
    if (!size) { set({ tireSizeText: text, tireSizeError: 'Unrecognized size (try 225/45R17, 31x10.50R15 or 20.5x7.0-13)' }); return; }
    const geom = get().geom;
    set({
      tireSizeText: text, tireSizeError: null, presetId: 'custom',
      geom: {
        ...geom,
        scalars: {
          ...geom.scalars,
          tireDiameter: field(size.outerDiameter), tireWidth: field(size.sectionWidth), rimDiameter: field(size.rimDiameter),
        },
      },
    });
  },
  loadPreset: (id) => {
    const geom = editableFromLayout(id);
    set({ presetId: id, geom, travel: 0, rack: 0, spring: fittedSpring(geom, get().spring) });
  },
  setPoint: (key, axis, text) => {
    const geom = get().geom;
    const triple = [...geom.points[key]] as [Field, Field, Field];
    triple[axis] = parseField(text, 'length', triple[axis]);
    set({ geom: { ...geom, points: { ...geom.points, [key]: triple } }, presetId: 'custom' });
  },
  setScalar: (key, text) => {
    const geom = get().geom;
    const f = parseField(text, SCALAR_META[key].quantity, geom.scalars[key]);
    set({ geom: { ...geom, scalars: { ...geom.scalars, [key]: f } }, presetId: 'custom' });
  },
  set: (key, value) => set({ [key]: value } as Partial<AppState>),
  toggleVisibility: (key) => set({ visibility: { ...get().visibility, [key]: !get().visibility[key] } }),
  requestView: (view) => set({ cameraRequest: { view, nonce: get().cameraRequest.nonce + 1 } }),
  focusOn: (focus) => set({ focus, cameraRequest: { view: null, nonce: get().cameraRequest.nonce + 1 } }),
}));
