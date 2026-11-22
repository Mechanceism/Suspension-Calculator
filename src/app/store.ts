/**
 * UI state. Geometry fields keep the text the user typed (e.g. "5in") alongside the parsed
 * base-unit value (mm / deg), per GOALS.md § Units.
 */
import { create } from 'zustand';
import { parseValue, formatValue, type Quantity } from '../core/units/units';
import { vec3, type Vec3 } from '../core/math/vec3';
import { DoubleWishbone, spinAxisFromCamberToe, SUSPENSION_LABELS, virtualPivot, type DoubleWishboneGeometry, type TravelDriver, type SuspensionKind } from '../core/suspension/doubleWishbone';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING, PRESET_LAYOUTS } from '../examples/sampleLayouts';
import { fitFreeLength } from '../core/suspension/spring';
import { CORNER_IDS, staticCornerLoads, type CornerId, type BrakeMount, type ChassisPose } from '../core/vehicle/vehicle';
import { setArmLength, setPivotInclination, setPivotPlanAngle, setArmFrontViewAngle, transferArmPoint } from '../core/suspension/armGeometry';
import { add, sub } from '../core/math/vec3';
import type { TireProfile } from '../core/tire/geometry';
import type { TireForceModel } from '../core/tire/model';
import { parseTireSize } from '../core/tire/size';
import { GOAL_KINDS, GOAL_META, type GoalKind } from '../core/optimize/corner';
import { VEHICLE_GOAL_KINDS, VEHICLE_GOAL_META, type VehicleGoalKind } from '../core/optimize/vehicle';
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
export const POINT_KEYS = ['ucaFwd', 'ucaAft', 'ucaOut', 'lcaFwd', 'lcaAft', 'lcaOut', 'trInner', 'trOuter', 'wheelCenter', 'dmpChassis', 'dmpArm', 'ucaOut2', 'lcaOut2'] as const;
export type PointKey = (typeof POINT_KEYS)[number];

/** Parameter names follow GOALS.md § Parameter Naming. */
export const POINT_NAMES: Record<PointKey, string> = {
  ucaFwd: 'FL_UCA_Fwd', ucaAft: 'FL_UCA_Aft', ucaOut: 'FL_UCA_Out',
  lcaFwd: 'FL_LCA_Fwd', lcaAft: 'FL_LCA_Aft', lcaOut: 'FL_LCA_Out',
  trInner: 'FL_TR_In', trOuter: 'FL_TR_Out', wheelCenter: 'FL_Hub_Ctr',
  dmpChassis: 'FL_Dmp_Chs', dmpArm: 'FL_Dmp_Arm',
  ucaOut2: 'FL_UCA_Out2', lcaOut2: 'FL_LCA_Out2',
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
export type DamperMode = 'linear' | 'twoStage';
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
export const STEER_KEYS = ['cFactor', 'rackLimit', 'lateral', 'longitudinal', 'pneumaticTrail', 'mu'] as const;
export type SteerKey = (typeof STEER_KEYS)[number];
export const STEER_META: Record<SteerKey, { label: string; quantity: Quantity; unit: string; initial: number; hint?: string }> = {
  cFactor: { label: 'Rack travel per steering-wheel rev', quantity: 'length', unit: 'mm/rev', initial: 75 },
  rackLimit: { label: 'Rack travel limit (±)', quantity: 'length', unit: 'mm', initial: 30 },
  lateral: { label: 'Lateral tire force (+ outboard)', quantity: 'force', unit: 'N', initial: 0 },
  longitudinal: { label: 'Longitudinal tire force (+ drive, − brake)', quantity: 'force', unit: 'N', initial: 0 },
  pneumaticTrail: { label: 'Pneumatic trail', quantity: 'length', unit: 'mm', initial: 0 },
  mu: { label: 'Tire friction μ (parking)', quantity: 'ratio', unit: '×', initial: 1 },
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
  scalars: Record<ScalarKey, Field>;
  /** Which arm the coilover's lower mount is attached to. */
  damperArm: ArmChoice;
}

export const VIS_KEYS = [
  'chassis', 'uca', 'lca', 'upright', 'tieRod', 'wheel',
  'spring', 'patch', 'steeringAxis', 'icConstruction', 'rollCenter', 'ground', 'datum', 'labels', 'dimensions', 'ackermann',
] as const;
export type VisKey = (typeof VIS_KEYS)[number];

export type ViewName = 'front' | 'rear' | 'outboard' | 'inboard' | 'top' | 'bottom' | 'iso';
export type FocusKey = ComponentId | 'corner' | 'contact';

const field = (value: number, quantity: Quantity = 'length'): Field => ({ text: formatValue(value, quantity), value });
const fields = (v: Vec3): [Field, Field, Field] => [field(v.x), field(v.y), field(v.z)];

export function editableFromLayout(id: string): EditableGeometry {
  const g = (PRESET_LAYOUTS.find((l) => l.id === id) ?? SAMPLE_LAYOUTS[0]!).geometry;
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
    },
    kind: g.kind ?? 'doubleWishbone',
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

export function toGeometry(e: EditableGeometry): DoubleWishboneGeometry {
  const p = (k: PointKey) => vec3(e.points[k][0].value, e.points[k][1].value, e.points[k][2].value);
  const s = e.scalars;
  const spinAxis = spinAxisFromCamberToe((s.staticCamber.value * Math.PI) / 180, (s.staticToe.value * Math.PI) / 180);
  // The stored point is the hub's mounting face; the tire's centerline sits the wheel offset (ET) inboard of it.
  const et = Number.isFinite(s.wheelOffset.value) ? s.wheelOffset.value : 0;
  const hub = p('wheelCenter');
  const kind = e.kind ?? 'doubleWishbone';
  const ml = kind === 'multilink';
  return {
    kind,
    uca: { fwd: p('ucaFwd'), aft: p('ucaAft'), out: p('ucaOut'), ...(ml ? { out2: p('ucaOut2') } : {}) },
    lca: { fwd: p('lcaFwd'), aft: p('lcaAft'), out: p('lcaOut'), ...(ml ? { out2: p('lcaOut2') } : {}) },
    tieRod: { inner: p('trInner'), outer: p('trOuter') },
    wheel: {
      center: vec3(hub.x - et * spinAxis.x, hub.y - et * spinAxis.y, hub.z - et * spinAxis.z),
      spinAxis,
      radius: s.tireDiameter.value / 2,
      width: mountedTireWidth(s),
    },
    // MacPherson: the damper is the strut (its lower point is on the upright); multilink: on the upright;
    // no suspension: no spring or damper.
    // Single arm: on the arm (lca) or the knuckle.
    ...(kind === 'rigid' ? {} : { damper: { chassis: p('dmpChassis'), arm: kind === 'doubleWishbone' ? e.damperArm : kind === 'singleArm' ? (e.damperArm === 'upright' ? 'upright' : 'lca') : 'upright', armPoint: p('dmpArm') } }),
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

/** Hardpoints a suspension type uses, in table order. */
export function activePointKeys(kind: SuspensionKind): PointKey[] {
  if (kind === 'macpherson') return ['lcaFwd', 'lcaAft', 'lcaOut', 'dmpChassis', 'dmpArm', 'trInner', 'trOuter', 'wheelCenter'];
  if (kind === 'rigid') return ['ucaOut', 'lcaOut', 'trInner', 'trOuter', 'wheelCenter'];
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
  /** Damper force curve (linear or two-stage). */
  damperMode: DamperMode;
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

  /** Name of the open layout in the in-app library (null = untitled). */
  fileName: string | null;
  /** Snapshot of the design when it was last saved/opened, for the unsaved-changes marker. */
  /** Snapshots of the model and tests parts at the last save / export (unsaved-change tracking). */
  savedSnapshot: string | null;
  savedTests: string | null;
  notice: { text: string; kind: 'info' | 'warn' | 'error' } | null;
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
  setShared(axle: Axle, patch: Partial<Pick<SharedDesign, 'antiRollBar' | 'heaveSpring'>>): void;
  setSharedField(axle: Axle, key: SharedFieldKey, text: string): void;
  setDropLink(axle: Axle, axis: 0 | 1 | 2, text: string): void;
  setVehicleField(key: VehicleKey, text: string): void;
  toggleLock(key: string): void;
  /** Lock or unlock several keys at once (e.g. all three coordinates of a point). */
  setLocks(keys: string[], locked: boolean): void;
  clearLocks(): void;
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
  notify(text: string, kind?: 'info' | 'warn' | 'error'): void;
  loadPreset(id: string): void;
  select(sel: Selection): void;
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
  /** Put the steering rack ahead of or behind the axle (flipRackSide). */
  setRackSide(ahead: boolean): void;
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
function fittedSpring(geom: EditableGeometry, f: Record<SpringKey, Field>, cornerLoad?: number): Record<SpringKey, Field> {
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
  /** Damper force curve (linear or two-stage). */
  damperMode: DamperMode;
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
  /** Drop-link mount on the lower arm (corner frame; mirrored for the right side). */
  dropLink: [Field, Field, Field];
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
export const VEHICLE_KEYS = ['mass', 'cgX', 'cgY', 'cgZ', 'wheelbase', 'brakeBias', 'driveSplit', 'rollInertia', 'pitchInertia', 'yawInertia', 'tireDamping'] as const;
/** Vehicle inputs only the ride over time (Phase B) and handling (Phase C) use. */
export const RIDE_KEYS = ['rollInertia', 'pitchInertia', 'yawInertia', 'tireDamping'] as const;
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
}

/** Whole-vehicle optimizer setup. */
export const AERO_KEYS = ['CdA', 'downF', 'downR', 'dragHeight', 'altitude', 'temperature'] as const;
export type AeroKey = (typeof AERO_KEYS)[number];
export const AERO_META: Record<AeroKey, { label: string; quantity: Quantity; unit: string; hint: string }> = {
  CdA: { label: 'Drag area CdA', quantity: 'ratio', unit: 'm²', hint: 'Drag coefficient × frontal area. Road cars ≈ 0.6–0.8, open-wheel cars with wings ≈ 1–1.5.' },
  downF: { label: 'Downforce area, front (−ClA)', quantity: 'ratio', unit: 'm²', hint: 'Downforce at the front axle per dynamic pressure (½ρV²). 0 = none; negative = lift.' },
  downR: { label: 'Downforce area, rear (−ClA)', quantity: 'ratio', unit: 'm²', hint: 'Downforce at the rear axle per dynamic pressure.' },
  dragHeight: { label: 'Drag acts at height', quantity: 'length', unit: 'mm', hint: 'Above the ground: drag up high moves load to the rear.' },
  altitude: { label: 'Altitude', quantity: 'altitude', unit: 'm', hint: 'For the air density' },
  temperature: { label: 'Air temperature', quantity: 'temperature', unit: '°C', hint: 'For the air density' },
};
export interface AeroSettings extends Record<AeroKey, Field> {
  on: boolean;
  /** Characteristics imported from a file (replace the generic values while set). */
  file: AeroModel | null;
}
export const defaultAero = (): AeroSettings => ({
  on: false, file: null,
  CdA: field(0.8, 'ratio'), downF: field(0.3, 'ratio'), downR: field(0.4, 'ratio'), dragHeight: field(400),
  altitude: field(0, 'altitude'), temperature: field(20, 'temperature'),
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
  /** Damper force curve (linear or two-stage). */
  damperMode: DamperMode;
  steer: Record<SteerKey, Field>;
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
  geom: s.geom, spring: s.spring, damper: s.damper, bumpStop: s.bumpStop, damperMode: s.damperMode, tireModel: s.tireModel,
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
  presetId: s.presetId, geom: s.geom, spring: s.spring, damper: s.damper, bumpStop: s.bumpStop, damperMode: s.damperMode, steer: s.steer,
  tireModel: s.tireModel, tire: s.tire, volumeChange: s.volumeChange, tireSizeText: s.tireSizeText,
  droop: s.droop, bump: s.bump, driver: s.driver,
  corners: s.corners, links: s.links, settings: s.settings, activeCorner: s.activeCorner,
  vehicle: s.vehicle, autoPreload: s.autoPreload, cornerLoadMode: s.cornerLoadMode, shared: s.shared, locks: s.locks,
  optimizer: s.optimizer, vehicleOptimizer: s.vehicleOptimizer, grip: s.grip, tireGrip: s.tireGrip, tireFile: s.tireFile, tireFileRear: s.tireFileRear, setupStatus: s.setupStatus, aero: s.aero, dimensions: s.dimensions, tests: s.tests,
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
  tireDamping: field(100, 'damping'),
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
    optimizer: {},
    vehicleOptimizer: defaultVehicleOptimizerSetup(),
    grip: defaultGrip(),
    tireGrip: defaultTireGrip(),
    tireFile: null,
    tireFileRear: null,
    setupStatus: {},
    aero: defaultAero(),
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
    dimensions: true, ackermann: true,
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
      corners, activeCorner: id, ...corners[root],
      selection: null, measure: [], rack: s.settings[id].steered ? s.rack : 0,
    });
  },
  setLink: (key, value) => {
    const s = get();
    const before = mergedCorners(s);
    const links = { ...s.links, [key]: value };
    // A corner that stops following another starts from a copy of the design it was using.
    const corners = { ...before };
    const locks = { ...s.locks };
    const optimizer = { ...s.optimizer };
    const dimensions = [...s.dimensions];
    for (const id of CORNER_IDS) {
      const oldRoot = rootOf(id, s.links);
      const newRoot = rootOf(id, links);
      if (newRoot === id && oldRoot !== id) {
        corners[id] = before[oldRoot];
        // The new copy starts with the same locks as the design it came from.
        for (const k of Object.keys(s.locks)) if (k.startsWith(`${oldRoot}.`)) locks[`${id}${k.slice(oldRoot.length)}`] = true;
        // ...and the same optimizer setup.
        if (s.optimizer[oldRoot]) optimizer[id] = structuredClone(s.optimizer[oldRoot]);
        // ...and the same held dimensions.
        for (const d of s.dimensions) if (d.root === oldRoot) dimensions.push({ ...d, id: newDimId(), root: id });
      }
    }
    set({ links, corners, locks, optimizer, dimensions, ...corners[rootOf(s.activeCorner, links)] });
  },
  toggleLock: (key) => {
    const locks = { ...get().locks };
    if (locks[key]) delete locks[key]; else locks[key] = true;
    set({ locks });
  },
  setLocks: (keys, locked) => {
    const locks = { ...get().locks };
    for (const k of keys) { if (locked) locks[k] = true; else delete locks[k]; }
    set({ locks });
  },
  clearLocks: () => set({ locks: {} }),
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
  setSetupStatus: (step, status) => {
    const cur = { ...get().setupStatus };
    if (status) cur[step] = status; else delete cur[step];
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
    set({ settings: { ...s.settings, [id]: { ...s.settings[id], [key]: value } }, ...(key === 'steered' && !value && id === s.activeCorner ? { rack: 0 } : {}) });
  },
  setVehicleField: (key, text) => {
    const v = get().vehicle;
    set({ vehicle: { ...v, [key]: parseField(text, VEHICLE_META[key].quantity, v[key]) } });
  },
  applyDesign: (design, fileName, savedModel, savedTests = null) => set({
    ...design, ...design.corners[rootOf(design.activeCorner, design.links)], fileName, savedSnapshot: savedModel, savedTests, tireSizeError: null,
    travel: 0, rack: 0, loadFactor: 1, mode: 'kinematic', playing: false, playingSteer: false,
    selection: null, measure: [], measureMode: false,
  }),
  markSaved: (fileName, model, tests) => set({ fileName, ...(model !== undefined ? { savedSnapshot: model } : {}), ...(tests !== undefined ? { savedTests: tests } : {}) }),
  notify: (text, kind = 'info') => set({ notice: { text, kind } }),

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

  select: (selection) => set(selection ? { selection, leftTab: 'inspector' } : { selection }),
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
  toggleMeasure: () => set({ measureMode: !get().measureMode, measure: [] }),
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
  setSuspensionKind: (kind) => {
    const geom = get().geom;
    if ((geom.kind ?? 'doubleWishbone') === kind) return;
    const next = convertGeometry(geom, kind);
    try { new DoubleWishbone(toGeometry(next)).design(); } catch (err) {
      get().notify(`Can't switch to ${SUSPENSION_LABELS[kind]}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    set({ geom: next, presetId: 'custom', spring: fittedSpring(next, get().spring), selection: null });
    get().notify(`${SUSPENSION_LABELS[kind]}: ${kind === 'singleArm' ? 'the knuckle now rides on the lower arm, turning on a kingpin from the lower to the upper ball joint\'s position (both on the arm); the arm swings on its frame pivots. Move the pivots along the car for a swing arm, across it for a trailing arm.' : kind === 'rigid' ? 'the wheel turns on a fixed kingpin through the ball joints\' positions; no spring or travel (only the tire gives).' : kind === 'macpherson' ? 'a strut was placed from the upright (top mount above the upper ball joint); adjust its points.' : kind === 'multilink' ? `each link now ends at its own point on the upright (moved 35 mm along the link: the same motion at ride height, nearly the same through travel); move them to shape the motion.${geom.kind === 'doubleWishbone' || !geom.kind ? ' The coilover now mounts on the upright (a multilink has no arm body), so check its motion ratio.' : ''}` : 'the links rejoin at one ball joint per arm.'}`, 'info');
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
