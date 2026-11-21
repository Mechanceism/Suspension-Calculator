/**
 * UI state. Geometry fields keep the text the user typed (e.g. "5in") alongside the parsed
 * base-unit value (mm / deg), per GOALS.md § Units.
 */
import { create } from 'zustand';
import { parseValue, formatValue, type Quantity } from '../core/units/units';
import { vec3, type Vec3 } from '../core/math/vec3';
import { spinAxisFromCamberToe, type DoubleWishboneGeometry, type TravelDriver } from '../core/suspension/doubleWishbone';
import { SAMPLE_LAYOUTS } from '../examples/sampleLayouts';

export interface Field {
  text: string;
  /** Base units (mm or deg). */
  value: number;
  error?: string;
}

export const POINT_KEYS = ['ucaFwd', 'ucaAft', 'ucaOut', 'lcaFwd', 'lcaAft', 'lcaOut', 'trInner', 'trOuter', 'wheelCenter'] as const;
export type PointKey = (typeof POINT_KEYS)[number];

/** Parameter names follow GOALS.md § Parameter Naming. */
export const POINT_NAMES: Record<PointKey, string> = {
  ucaFwd: 'FL_UCA_Fwd', ucaAft: 'FL_UCA_Aft', ucaOut: 'FL_UCA_Out',
  lcaFwd: 'FL_LCA_Fwd', lcaAft: 'FL_LCA_Aft', lcaOut: 'FL_LCA_Out',
  trInner: 'FL_TR_In', trOuter: 'FL_TR_Out', wheelCenter: 'FL_Hub_Ctr',
};

export const SCALAR_KEYS = ['wheelRadius', 'tireWidth', 'staticCamber', 'staticToe'] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];
export const SCALAR_META: Record<ScalarKey, { name: string; quantity: Quantity }> = {
  wheelRadius: { name: 'FL_Tire_Rad', quantity: 'length' },
  tireWidth: { name: 'FL_Tire_Wid', quantity: 'length' },
  staticCamber: { name: 'FL_Whl_Camber', quantity: 'angle' },
  staticToe: { name: 'FL_Whl_Toe', quantity: 'angle' },
};

export interface EditableGeometry {
  points: Record<PointKey, [Field, Field, Field]>;
  scalars: Record<ScalarKey, Field>;
}

export const VIS_KEYS = [
  'chassis', 'uca', 'lca', 'upright', 'tieRod', 'wheel',
  'steeringAxis', 'icConstruction', 'rollCenter', 'ground', 'datum', 'labels',
] as const;
export type VisKey = (typeof VIS_KEYS)[number];

export type ViewName = 'front' | 'rear' | 'outboard' | 'inboard' | 'top' | 'bottom' | 'iso';
export type FocusKey = 'corner' | 'wheel' | 'upright' | 'uca' | 'lca' | 'tieRod' | 'contact';

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
    },
    scalars: {
      wheelRadius: field(g.wheel.radius),
      tireWidth: field(g.wheel.width ?? 200),
      staticCamber: field(0, 'angle'),
      staticToe: field(0, 'angle'),
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
      radius: s.wheelRadius.value,
      width: s.tireWidth.value,
    },
  };
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

  loadPreset(id: string): void;
  setPoint(key: PointKey, axis: 0 | 1 | 2, text: string): void;
  setScalar(key: ScalarKey, text: string): void;
  set<K extends keyof AppState>(key: K, value: AppState[K]): void;
  toggleVisibility(key: VisKey): void;
  requestView(view: ViewName | null): void;
  focusOn(key: FocusKey): void;
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
    chassis: true, uca: true, lca: true, upright: true, tieRod: true, wheel: true,
    steeringAxis: true, icConstruction: true, rollCenter: true, ground: true, datum: true, labels: params.get('labels') === '1',
  },
  projection: params.get('projection') === 'perspective' ? 'perspective' : 'orthographic',
  focus: 'corner',
  followFocus: false,
  cameraRequest: { view: initialView, nonce: 0 },

  loadPreset: (id) => set({ presetId: id, geom: editableFromLayout(id), travel: 0, rack: 0 }),
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
