import { describe, expect, it } from 'vitest';
import { boundValues, activeBounds, evaluateVehicle, vehicleObjective, reportVehicle, BOUND_KINDS, BOUND_META, type VehicleProblem } from '../src/core/optimize/vehicle';
import { useApp, defaultDesign, defaultBounds, type AppState } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { offerLimits } from '../src/app/testOptimize';
import { serializeProject, importProject } from '../src/app/project';

// F28 (round 5): bounds on the characteristics — generic, wide, the same for every car.
const geoms = (p: VehicleProblem) => Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
const problem = (bounds = defaultBounds(), ranges: Record<string, { lo: number; hi: number }> = {}) => {
  const d = defaultDesign();
  const f = (x: number) => ({ text: String(x), value: x });
  return buildVehicleProblem({
    ...d,
    vehicleOptimizer: { ...d.vehicleOptimizer, bounds, ranges: Object.fromEntries(Object.entries(ranges).map(([k, r]) => [k, { lo: f(r.lo), hi: f(r.hi) }])) },
  } as unknown as AppState).problem;
};

describe('characteristic bounds', () => {
  it('on by default, measured per design (steering ones on steered designs only) and for the car', () => {
    const p = problem();
    expect(p.bounds!.map((b) => b.kind).sort()).toEqual([...BOUND_KINDS].sort());
    const e = evaluateVehicle(p, geoms(p))!;
    const vals = boundValues(p, e);
    const kindsOf = (root: string | null) => vals.filter((v) => v.root === root).map((v) => v.kind).sort();
    expect(kindsOf('FL')).toEqual(BOUND_KINDS.filter((k) => !BOUND_META[k].car).sort());
    // (The default car's rear follows the front design: one design.)
    expect(Object.keys(p.designs)).toEqual(['FL']);
    expect(kindsOf(null)).toEqual(['antiDive', 'antiSquat']);
    expect(vals.every((v) => v.value !== null && Number.isFinite(v.value))).toBe(true);
    // The default car is well inside the generic limits.
    expect(activeBounds(p, e)).toEqual([]);
  });

  it('a bound the design sits past is reported, and costs only when it gets worse than at the start', () => {
    const p0 = problem();
    const e0 = evaluateVehicle(p0, geoms(p0))!;
    const kpi = boundValues(p0, e0).find((v) => v.kind === 'kpi')!.value!;
    const tight = defaultBounds();
    tight.kpi = { on: true, min: { text: '0', value: 0 }, max: { text: String(kpi - 2), value: kpi - 2 } };
    const p = problem(tight, { 'FL.lcaOut.y': { lo: -25, hi: 25 } });
    const e = evaluateVehicle(p, geoms(p))!;
    const at = activeBounds(p, e);
    expect(at).toEqual([{ root: 'FL', kind: 'kpi', side: 'max', value: kpi, bound: kpi - 2 }]);
    // At the start nothing costs (held to no worse than it was): the same residuals as with the bound off,
    // which has one bound value fewer (FL only: the front is the one steered design).
    const obj = vehicleObjective(p);
    const r0 = obj.residuals(obj.x0)!;
    const off = defaultBounds();
    off.kpi.on = false;
    const rOff = vehicleObjective(problem(off, { 'FL.lcaOut.y': { lo: -25, hi: 25 } })).residuals(obj.x0)!;
    expect(rOff.length).toBe(r0.length - 1);
    const ss = (r: number[]) => r.reduce((a, b) => a + b * b, 0);
    expect(ss(r0)).toBeCloseTo(ss(rOff), 9);
  });

  it('a design moved past a bound pays heavily (a wall)', () => {
    const p = problem(defaultBounds(), { 'FL.lcaOut.y': { lo: -25, hi: 25 } });
    const obj = vehicleObjective(p);
    const sum = (x: number[]) => obj.residuals(x)!.reduce((a, b) => a + b * b, 0);
    const e0 = evaluateVehicle(p, geoms(p))!;
    const kpi0 = boundValues(p, e0).find((v) => v.kind === 'kpi')!.value!;
    // Tighten the KPI max just above the start: moving the lower ball joint outward/inward past it costs.
    const tight = defaultBounds();
    tight.kpi.max = { text: String(kpi0 + 0.2), value: kpi0 + 0.2 };
    const pt = problem(tight, { 'FL.lcaOut.y': { lo: -25, hi: 25 } });
    const ot = vehicleObjective(pt);
    const sumT = (x: number[]) => ot.residuals(x)!.reduce((a, b) => a + b * b, 0);
    const moves = [-10, 10].map((d) => [obj.x0[0]! + d]);
    const extra = moves.map((x) => sumT(x) - sum(x));
    // One direction raises the KPI past the bound: that one costs (3 per 1 % of the bound's span past it, squared);
    // the other costs nothing extra.
    const kpiAt = (x: number[]) => boundValues(pt, evaluateVehicle(pt, reportVehicle(pt, x).geometries)!).find((b) => b.kind === 'kpi')!.value!;
    const iUp = extra[0]! > extra[1]! ? 0 : 1;
    const over = kpiAt(moves[iUp]!) - (kpi0 + 0.2);
    expect(over).toBeGreaterThan(0.01);
    expect(extra[iUp]!).toBeCloseTo(((3 * over) / (0.01 * (tight.kpi.max.value - tight.kpi.min.value))) ** 2, 1);
    expect(extra[1 - iUp]!).toBeLessThan(1e-6);
  });

  it('saved and read back with the project (format 52)', () => {
    const d = defaultDesign();
    const o = d.vehicleOptimizer;
    const s0 = { ...d, vehicleOptimizer: { ...o, askLimits: false, bounds: { ...o.bounds, trail: { on: false, min: { text: '5', value: 5 }, max: { text: '45', value: 45 } } } } };
    const file = JSON.parse(JSON.stringify(serializeProject(s0 as never, 'B')));
    expect(file.formatVersion).toBe(52);
    const vo = importProject(file).design.vehicleOptimizer;
    expect(vo.askLimits).toBe(false);
    expect(vo.bounds.trail.on).toBe(false);
    expect(vo.bounds.trail.max.value).toBe(45);
    expect(vo.bounds.kpi.max.value).toBe(BOUND_META.kpi.max);
  });
});

describe('asking at a limit mid-run', () => {
  const at = { atBounds: [{ root: 'FL' as const, kind: 'kpi' as const, side: 'max' as const, value: 20, bound: 20 }, { root: 'FR' as const, kind: 'kpi' as const, side: 'max' as const, value: 20.1, bound: 20 }], variables: [] };
  const setConfirm = (fn: (m: string) => boolean) => { (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis, { confirm: fn }); };

  it('one question for the designs at the bound; yes widens it by a fifth of its span', () => {
    useApp.getState().applyDesign(defaultDesign() as never, null, null);
    const asked: string[] = [];
    setConfirm((m) => { asked.push(m); return true; });
    const line = offerLimits(at, new Set());
    expect(asked.length).toBe(1);
    expect(asked[0]).toMatch(/KPI \(FL, FR\) reached its 20 ° maximum → allow up to 24 °/);
    expect(line).toMatch(/^Limits widened/);
    expect(useApp.getState().vehicleOptimizer.bounds.kpi.max.value).toBe(24);
  });

  it('no: kept, and not asked again in the run; box off: never asked', () => {
    useApp.getState().applyDesign(defaultDesign() as never, null, null);
    let n = 0;
    setConfirm(() => { n++; return false; });
    const declined = new Set<string>();
    expect(offerLimits(at, declined)).toMatch(/^Limits kept/);
    expect(offerLimits(at, declined)).toBeNull();
    expect(n).toBe(1);
    expect(useApp.getState().vehicleOptimizer.bounds.kpi.max.value).toBe(20);
    useApp.getState().updateVehicleOptimizer((o) => ({ ...o, askLimits: false }));
    expect(offerLimits(at, new Set())).toBeNull();
    expect(n).toBe(1);
  });

  it('an adjustment stopped at its range end is offered too (its range widened)', () => {
    useApp.getState().applyDesign(defaultDesign() as never, null, null);
    useApp.getState().updateVehicleOptimizer((o) => ({ ...o, ranges: { 'FL.scalar.tirePressure': { lo: { text: '60', value: 60 }, hi: { text: '110', value: 110 } } } }));
    const asked: string[] = [];
    setConfirm((m) => { asked.push(m); return true; });
    offerLimits({ variables: [{ root: 'FL', point: 'tirePressure', axis: 0, after: 110, atLimit: true }] }, new Set());
    expect(asked[0]).toMatch(/Tire pressure \(FL\) reached its range end 110 kPa → allow up to 120 kPa/);
    expect(useApp.getState().vehicleOptimizer.ranges['FL.scalar.tirePressure']!.hi.value).toBe(120);
  });
});
