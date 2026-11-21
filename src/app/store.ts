/**
 * UI state. Geometry fields keep the text the user typed (e.g. "5in") alongside the parsed
 * base-unit value (mm / deg), per GOALS.md § Units.
 */
import { create } from 'zustand';
import { parseValue, formatValue, type Quantity } from '../core/units/units';
import { vec3, type Vec3 } from '../core/math/vec3';
import { DoubleWishbone, spinAxisFromCamberToe, type DoubleWishboneGeometry, type TravelDriver } from '../core/suspension/doubleWishbone';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../examples/sampleLayouts';
import { fitFreeLength } from '../core/suspension/spring';
import { setArmLength, setPivotInclination, setPivotPlanAngle, transferArmPoint } from '../core/suspension/armGeometry';
import { add, sub } from '../core/math/vec3';
import type { TireProfile } from '../core/tire/geometry';
import type { TireForceModel } from '../core/tire/model';
import { parseTireSize } from '../core/tire/size';

export interface Field {
  text: string;
  /** Base units (mm or deg). */
  value: number;
  error?: string;
}

export const POINT_KEYS = ['ucaFwd', 'ucaAft', 'ucaOut', 'lcaFwd', 'lcaAft', 'lcaOut', 'trInner', 'trOuter', 'wheelCenter', 'dmpChassis', 'dmpArm'] as const;
export type PointKey = (typeof POINT_KEYS)[number];

/** Parameter names follow GOALS.md § Parameter Naming. */
export const POINT_NAMES: Record<PointKey, string> = {
  ucaFwd: 'FL_UCA_Fwd', ucaAft: 'FL_UCA_Aft', ucaOut: 'FL_UCA_Out',
  lcaFwd: 'FL_LCA_Fwd', lcaAft: 'FL_LCA_Aft', lcaOut: 'FL_LCA_Out',
  trInner: 'FL_TR_In', trOuter: 'FL_TR_Out', wheelCenter: 'FL_Hub_Ctr',
  dmpChassis: 'FL_Dmp_Chs', dmpArm: 'FL_Dmp_Arm',
};

export const SCALAR_KEYS = ['staticCamber', 'staticToe', 'tireDiameter', 'tireWidth', 'rimDiameter', 'shoulderRadius'] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];
export const SCALAR_META: Record<ScalarKey, { name: string; quantity: Quantity; label: string }> = {
  staticCamber: { name: 'FL_Whl_Camber', quantity: 'angle', label: 'Static camber' },
  staticToe: { name: 'FL_Whl_Toe', quantity: 'angle', label: 'Static toe (+ in)' },
  tireDiameter: { name: 'FL_Tire_Dia', quantity: 'length', label: 'Outer diameter' },
  tireWidth: { name: 'FL_Tire_Wid', quantity: 'length', label: 'Section width' },
  rimDiameter: { name: 'FL_Rim_Dia', quantity: 'length', label: 'Rim diameter' },
  shoulderRadius: { name: 'FL_Tire_Shldr', quantity: 'length', label: 'Shoulder radius' },
};

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
export type ArmChoice = 'lca' | 'uca';
export type CornerMode = 'kinematic' | 'loaded';
const G = 9.80665;
/** Load the spring carries: (corner load − unsprung weight) × load factor. */
export const sprungLoad = (f: Record<SpringKey, Field>, loadFactor: number) =>
  Math.max(0, (f.cornerLoad.value - f.unsprungMass.value * G) * loadFactor);

/** Damper stroke and bump stop (docs/MATH.md § L5). */
export const DAMPER_KEYS = ['maxLength', 'minLength', 'bumpStopLength', 'bumpStopRate'] as const;
export type DamperKey = (typeof DAMPER_KEYS)[number];
export const DAMPER_META: Record<DamperKey, { label: string; quantity: Quantity; unit: string }> = {
  maxLength: { label: 'Damper fully extended', quantity: 'length', unit: 'mm' },
  minLength: { label: 'Damper fully compressed', quantity: 'length', unit: 'mm' },
  bumpStopLength: { label: 'Bump stop engages at', quantity: 'length', unit: 'mm' },
  bumpStopRate: { label: 'Bump stop rate', quantity: 'rate', unit: 'N/mm' },
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

export const ARM_DERIVED = ['length', 'inclination', 'planAngle'] as const;
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
/** Anything the measure tool can snap to: a hardpoint or a derived point. */
export type AnchorId = PointKey | 'contact' | 'patchCentroid' | 'axisGround' | 'rollCenter' | 'frontViewIC';

export interface EditableGeometry {
  points: Record<PointKey, [Field, Field, Field]>;
  scalars: Record<ScalarKey, Field>;
  /** Which arm the coilover's lower mount is attached to. */
  damperArm: ArmChoice;
}

export const VIS_KEYS = [
  'chassis', 'uca', 'lca', 'upright', 'tieRod', 'wheel',
  'spring', 'patch', 'steeringAxis', 'icConstruction', 'rollCenter', 'ground', 'datum', 'labels',
] as const;
export type VisKey = (typeof VIS_KEYS)[number];

export type ViewName = 'front' | 'rear' | 'outboard' | 'inboard' | 'top' | 'bottom' | 'iso';
export type FocusKey = ComponentId | 'corner' | 'contact';

const field = (value: number, quantity: Quantity = 'length'): Field => ({ text: formatValue(value, quantity), value });
const fields = (v: Vec3): [Field, Field, Field] => [field(v.x), field(v.y), field(v.z)];

export function editableFromLayout(id: string): EditableGeometry {
  const g = (SAMPLE_LAYOUTS.find((l) => l.id === id) ?? SAMPLE_LAYOUTS[0]!).geometry;
  return {
    points: {
      ucaFwd: fields(g.uca.fwd), ucaAft: fields(g.uca.aft), ucaOut: fields(g.uca.out),
      lcaFwd: fields(g.lca.fwd), lcaAft: fields(g.lca.aft), lcaOut: fields(g.lca.out),
      trInner: fields(g.tieRod.inner), trOuter: fields(g.tieRod.outer),
      wheelCenter: fields(g.wheel.center),
      dmpChassis: fields(g.damper?.chassis ?? vec3(300, 380, 30)),
      dmpArm: fields(g.damper?.armPoint ?? vec3(480, 45, 30)),
    },
    damperArm: g.damper?.arm ?? 'lca',
    scalars: {
      staticCamber: field(0, 'angle'),
      staticToe: field(0, 'angle'),
      tireDiameter: field(2 * g.wheel.radius),
      tireWidth: field(g.wheel.width ?? 200),
      rimDiameter: { text: '13in', value: 13 * 25.4 },
      shoulderRadius: field(25),
    },
  };
}

export function toGeometry(e: EditableGeometry): DoubleWishboneGeometry {
  const p = (k: PointKey) => vec3(e.points[k][0].value, e.points[k][1].value, e.points[k][2].value);
  const s = e.scalars;
  return {
    uca: { fwd: p('ucaFwd'), aft: p('ucaAft'), out: p('ucaOut') },
    lca: { fwd: p('lcaFwd'), aft: p('lcaAft'), out: p('lcaOut') },
    tieRod: { inner: p('trInner'), outer: p('trOuter') },
    wheel: {
      center: p('wheelCenter'),
      spinAxis: spinAxisFromCamberToe((s.staticCamber.value * Math.PI) / 180, (s.staticToe.value * Math.PI) / 180),
      radius: s.tireDiameter.value / 2,
      width: s.tireWidth.value,
    },
    damper: { chassis: p('dmpChassis'), arm: e.damperArm, armPoint: p('dmpArm') },
  };
}

export function toProfile(e: EditableGeometry): TireProfile {
  const s = e.scalars;
  return {
    radius: s.tireDiameter.value / 2,
    width: s.tireWidth.value,
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

export interface AppState {
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
  steer: Record<SteerKey, Field>;

  selection: Selection;
  leftTab: 'inspector' | 'browser' | 'table';
  nudgeStep: number;
  /** Round dragged joint coordinates to the grid. */
  snapToGrid: boolean;
  gridSize: number;
  /** A joint is being dragged: heavy sweeps pause until release. */
  interacting: boolean;
  measureMode: boolean;
  measure: AnchorId[];

  /** Name of the open layout in the in-app library (null = untitled). */
  fileName: string | null;
  /** Snapshot of the design when it was last saved/opened, for the unsaved-changes marker. */
  savedSnapshot: string | null;
  notice: { text: string; kind: 'info' | 'warn' | 'error' } | null;
  /** Save-as dialog open. */
  saveAsOpen: boolean;

  /** Replace the whole design (File → New / Open / Import). */
  applyDesign(design: DesignState, fileName: string | null, savedSnapshot: string | null): void;
  markSaved(fileName: string | null, snapshot: string): void;
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
  addMeasureAnchor(a: AnchorId): void;
  setSpringField(key: SpringKey, text: string): void;
  setDamperArm(arm: ArmChoice): void;
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
function fittedSpring(geom: EditableGeometry, f: Record<SpringKey, Field>): Record<SpringKey, Field> {
  try {
    const corner = new DoubleWishbone(toGeometry(geom));
    const fl = fitFreeLength(corner, f.springRate.value, sprungLoad(f, 1));
    if (!Number.isFinite(fl)) return f;
    return { ...f, freeLength: field(Math.round(fl * 10) / 10) };
  } catch {
    return f;
  }
}

/** Everything a saved layout holds (docs: project files). */
export interface DesignState {
  presetId: string;
  geom: EditableGeometry;
  spring: Record<SpringKey, Field>;
  damper: Record<DamperKey, Field>;
  bumpStop: boolean;
  steer: Record<SteerKey, Field>;
  tireModel: TireModelKind;
  tire: Record<TireKey, Field>;
  volumeChange: boolean;
  tireSizeText: string;
  droop: number;
  bump: number;
  driver: Extract<TravelDriver, 'wheelCenter' | 'contactPatch'>;
}

/** The design part of the app state (what a file saves). */
export const pickDesign = (s: DesignState): DesignState => ({
  presetId: s.presetId, geom: s.geom, spring: s.spring, damper: s.damper, bumpStop: s.bumpStop, steer: s.steer,
  tireModel: s.tireModel, tire: s.tire, volumeChange: s.volumeChange, tireSizeText: s.tireSizeText,
  droop: s.droop, bump: s.bump, driver: s.driver,
});

/** The default layout (File → New). */
export function defaultDesign(presetId = 'C'): DesignState {
  const geom = editableFromLayout(presetId);
  return {
    presetId,
    geom,
    spring: fittedSpring(geom, {
      cornerLoad: field(900, 'force'),
      unsprungMass: field(12, 'mass'),
      springRate: field(SAMPLE_SPRING.rate, 'rate'),
      freeLength: field(SAMPLE_SPRING.freeLength),
    }),
    damper: { maxLength: field(430), minLength: field(330), bumpStopLength: field(345), bumpStopRate: field(400, 'rate') },
    bumpStop: true,
    steer: Object.fromEntries(STEER_KEYS.map((k) => [k, field(STEER_META[k].initial, STEER_META[k].quantity)])) as Record<SteerKey, Field>,
    tireModel: 'gas',
    tire: Object.fromEntries(TIRE_KEYS.map((k) => [k, field(TIRE_META[k].initial, TIRE_META[k].quantity)])) as Record<TireKey, Field>,
    volumeChange: true,
    tireSizeText: '',
    droop: 50,
    bump: 50,
    driver: 'wheelCenter',
  };
}

/** Optional URL overrides, e.g. ?preset=A&view=iso&travel=30&rack=10&labels=1 */
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);
const VIEW_NAMES: ViewName[] = ['front', 'rear', 'outboard', 'inboard', 'top', 'bottom', 'iso'];
const initialView = (VIEW_NAMES as string[]).includes(params.get('view') ?? '') ? (params.get('view') as ViewName) : 'iso';
const initialPreset = SAMPLE_LAYOUTS.some((l) => l.id === params.get('preset')) ? params.get('preset')! : 'C';

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
  notice: null,
  saveAsOpen: false,
  applyDesign: (design, fileName, savedSnapshot) => set({
    ...design, fileName, savedSnapshot, tireSizeError: null,
    travel: 0, rack: 0, loadFactor: 1, mode: 'kinematic', playing: false, playingSteer: false,
    selection: null, measure: [], measureMode: false,
  }),
  markSaved: (fileName, savedSnapshot) => set({ fileName, savedSnapshot }),
  notify: (text, kind = 'info') => set({ notice: { text, kind } }),

  selection: null,
  leftTab: 'inspector',
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
        : setPivotPlanAngle(a, (r.value * Math.PI) / 180);
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
  addMeasureAnchor: (a) => {
    const m = get().measure;
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
    // the damper stroke and bump-stop settings) stay valid.
    const moved = transferArmPoint(g.damper!.armPoint, g[geom.damperArm], g[arm]);
    const shift = sub(moved, g.damper!.armPoint);
    const chassisMount = add(g.damper!.chassis, shift);
    const next: EditableGeometry = {
      ...geom, damperArm: arm,
      points: { ...geom.points, dmpArm: fields(moved), dmpChassis: fields(chassisMount) },
    };
    set({ geom: next, presetId: 'custom', spring: fittedSpring(next, get().spring) });
  },
  fitSpring: () => set({ spring: fittedSpring(get().geom, get().spring) }),

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
