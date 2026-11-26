/**
 * F29 (round 5): a design's setup character — the values the Compare page sets against the typical ranges per
 * kind of driving (src/core/vehicle/character.ts). Per axle (the front's and the rear's designs, as the left
 * corners use them) and for the car. Pure: works on the current design or a snapshot's.
 */
import { create } from 'zustand';
import { DoubleWishbone } from '../core/suspension/doubleWishbone';
import { solveEquilibrium, rideMetrics, type SpringSpec } from '../core/suspension/spring';
import { tireRate } from '../core/tire/model';
import { sampleCorner, goalValue } from '../core/optimize/corner';
import { evaluateVehicle, vehicleGoalValue, designRideHeight } from '../core/optimize/vehicle';
import { DEFAULT_REFERENCES, STYLES, ROW_KEYS, type References, type RowKey, type Range } from '../core/vehicle/character';
import { toGeometry, toForceModel, toProfile, sprungLoad, vehicleStaticLoads, mergedCorners, type AppState, type DesignState } from './store';
import { buildVehicleProblem } from './optimizer';

const G = 9.80665;

/** One axle's corner (the left one): its kinematic values and its ride frequency. */
function axleValues(s: DesignState, id: 'FL' | 'RL', steered: boolean): Partial<Record<string, number | null>> {
  const corners = mergedCorners(s as AppState);
  const d = corners[id];
  const out: Partial<Record<string, number | null>> = {
    staticCamber: d.geom.scalars.staticCamber.value,
    staticToe: d.geom.scalars.staticToe.value,
  };
  let corner: DoubleWishbone;
  try { corner = new DoubleWishbone(toGeometry(d.geom)); } catch { return out; }
  const kinds = ['camberGain', 'rollCenter', ...(steered ? ['caster', 'kpi'] as const : [])] as const;
  const sm = sampleCorner(corner.geometry, { droop: -Math.abs(s.droop), bump: Math.abs(s.bump), samples: 5, goals: kinds.map((k) => ({ kind: k, target: 0, weight: 1 })) });
  for (const k of kinds) out[k] = sm ? goalValue(k, sm) : null;
  // Ride frequency at the static load: the wheel rate at the spring's equilibrium, in series with the tire.
  try {
    const load = s.cornerLoadMode === 'vehicle' ? vehicleStaticLoads(s.vehicle, corners, s.links)[id] : d.spring.cornerLoad.value;
    const spring = { ...d.spring, cornerLoad: { text: String(load), value: load } };
    const ws = sprungLoad(spring, 1);
    const spec: SpringSpec = {
      rate: d.spring.springRate.value, freeLength: d.spring.freeLength.value,
      ...(d.bumpStop ? { bumpStopLength: d.damper.bumpStopLength.value, bumpStopRate: d.damper.bumpStopRate.value } : {}),
    };
    if (corner.geometry.damper && ws > 0 && spec.rate > 0) {
      const eq = solveEquilibrium(corner, spec, ws, [-Math.abs(s.droop), Math.abs(s.bump)]);
      const model = toForceModel(d.tireModel, d.tire, d.volumeChange);
      const kt = model ? tireRate(model, toProfile(d.geom), eq.load.state.spinAxis.y, Math.max(load, 1)) : Infinity;
      const f = rideMetrics(eq.wheelRate, kt, ws / G).frequency;
      out.rideFrequency = Number.isFinite(f) ? f : null;
    }
  } catch { /* no spring model */ }
  return out;
}

/** The design's values, by row (`front.caster`, `car.antiSquat` …); null where they can't be worked out. */
export function characterValues(s: DesignState): Partial<Record<RowKey, number | null>> {
  const v: Partial<Record<RowKey, number | null>> = {};
  const front = axleValues(s, 'FL', !!s.settings.FL.steered);
  const rear = axleValues(s, 'RL', !!s.settings.RL.steered);
  for (const [w, vals] of [['front', front], ['rear', rear]] as const) for (const [k, x] of Object.entries(vals)) v[`${w}.${k}` as RowKey] = x ?? null;
  try {
    const p = buildVehicleProblem(s as AppState).problem;
    const ride = s.rideHeight.on ? null : designRideHeight(p);
    v['front.rideHeight'] = s.rideHeight.on ? s.rideHeight.front.value : ride;
    v['rear.rideHeight'] = s.rideHeight.on ? s.rideHeight.rear.value : ride;
    const geometries = Object.fromEntries(Object.entries(p.designs).map(([r, x]) => [r, x!.geometry]));
    const e = evaluateVehicle(p, geometries);
    if (e) {
      v['car.antiDive'] = vehicleGoalValue('antiDive', p, e);
      v['car.antiSquat'] = vehicleGoalValue('antiSquat', p, e);
      v['car.rollShare'] = vehicleGoalValue('rollStiffness', p, e);
    }
  } catch { /* the car can't be assembled */ }
  return v;
}

// The reference ranges: the defaults, with the user's edits kept in this browser (a guide, not part of a design).
const KEY = 'susp.characterRefs';
const load = (): References => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Record<string, Partial<Record<string, Range>>>> | null;
    if (!raw) return DEFAULT_REFERENCES;
    return Object.fromEntries(STYLES.map((st) => [st, Object.fromEntries(ROW_KEYS.map((k) => [k, raw[st]?.[k] ?? DEFAULT_REFERENCES[st][k]]).filter(([, r]) => r))])) as References;
  } catch { return DEFAULT_REFERENCES; }
};
export const useCharacterRefs = create<{ refs: References }>(() => ({ refs: load() }));
export function setReference(style: (typeof STYLES)[number], row: RowKey, range: Range | null) {
  const refs = { ...useCharacterRefs.getState().refs, [style]: { ...useCharacterRefs.getState().refs[style], [row]: range ?? DEFAULT_REFERENCES[style][row] } } as References;
  useCharacterRefs.setState({ refs });
  try { localStorage.setItem(KEY, JSON.stringify(refs)); } catch { /* private window */ }
}
export function resetReferences() {
  useCharacterRefs.setState({ refs: DEFAULT_REFERENCES });
  try { localStorage.removeItem(KEY); } catch { /* private window */ }
}
