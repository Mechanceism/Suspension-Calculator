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
export type FocusKey = 'corner' | 'wheel' | 'upright' | 'uca' | 'lca' | 'tieRod' | 'spring' | 'contact';

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

interface AppState {
  presetId: string;
  geom: EditableGeometry;
  travel: number;
  rack: number;
  driver: Extract<TravelDriver, 'wheelCenter' | 'contactPatch'>;
  droop: number;
  bump: number;
  rackRange: number;
  playing: boolean;
  trails: boolean;
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

  loadPreset(id: string): void;
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

/** Optional URL overrides, e.g. ?preset=A&view=iso&travel=30&rack=10&labels=1 */
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);
const VIEW_NAMES: ViewName[] = ['front', 'rear', 'outboard', 'inboard', 'top', 'bottom', 'iso'];
const initialView = (VIEW_NAMES as string[]).includes(params.get('view') ?? '') ? (params.get('view') as ViewName) : 'iso';
const initialPreset = SAMPLE_LAYOUTS.some((l) => l.id === params.get('preset')) ? params.get('preset')! : 'C';

export const useApp = create<AppState>((set, get) => ({
  presetId: initialPreset,
  geom: editableFromLayout(initialPreset),
  travel: num('travel', 0),
  rack: num('rack', 0),
  driver: 'wheelCenter',
  droop: 50,
  bump: 50,
  rackRange: 30,
  playing: false,
  trails: true,
  ghosts: true,
  visibility: {
    chassis: true, uca: true, lca: true, upright: true, tieRod: true, wheel: true, spring: true,
    patch: true, steeringAxis: true, icConstruction: true, rollCenter: true, ground: true, datum: true, labels: params.get('labels') === '1',
  },
  projection: params.get('projection') === 'perspective' ? 'perspective' : 'orthographic',
  focus: 'corner',
  followFocus: false,
  cameraRequest: { view: initialView, nonce: 0 },

  tireModel: (['rigid', 'stiffness', 'gas'] as string[]).includes(params.get('tire') ?? '') ? (params.get('tire') as TireModelKind) : 'gas',
  tire: Object.fromEntries(TIRE_KEYS.map((k) => [k, field(TIRE_META[k].initial, TIRE_META[k].quantity)])) as Record<TireKey, Field>,
  volumeChange: true,
  tireSizeText: '',
  tireSizeError: null,

  mode: params.get('mode') === 'loaded' ? 'loaded' : 'kinematic',
  loadFactor: num('load', 1),
  spring: fittedSpring(editableFromLayout(initialPreset), {
    cornerLoad: field(900, 'force'),
    unsprungMass: field(12, 'mass'),
    springRate: field(SAMPLE_SPRING.rate, 'rate'),
    freeLength: field(SAMPLE_SPRING.freeLength),
  }),

  setSpringField: (key, text) => {
    const spring = get().spring;
    set({ spring: { ...spring, [key]: parseField(text, SPRING_META[key].quantity, spring[key]) } });
  },
  setDamperArm: (arm) => set({ geom: { ...get().geom, damperArm: arm }, presetId: 'custom' }),
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
