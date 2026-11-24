import { describe, it, expect } from 'vitest';
import { parseTir, loadCapacityRatio, scaleTir, sizeChange, tireWheelMass, mfPeaks, parseTireSize } from '../src/core';
import { defaultDesign, resolvedCorner, type AppState } from '../src/app/store';
import { withTire, fitProblem, currentTire, candidatesOf } from '../src/app/tireChoice';

const TIR = `[MDI_HEADER]
FILE_TYPE = 'tir'
[UNITS]
LENGTH = 'meter'
FORCE = 'newton'
ANGLE = 'radians'
[MODEL]
FITTYP = 61
[DIMENSION]
UNLOADED_RADIUS = 0.317
WIDTH = 0.225
RIM_RADIUS = 0.2159
[OPERATING_CONDITIONS]
NOMPRES = 220000
[VERTICAL]
FNOMIN = 4000
VERTICAL_STIFFNESS = 200000
[LONGITUDINAL_COEFFICIENTS]
PCX1 = 1.6
PDX1 = 1.2
PDX2 = -0.1
PKX1 = 25
PEX1 = 0
[LATERAL_COEFFICIENTS]
PCY1 = 1.4
PDY1 = 1.1
PDY2 = -0.15
PDY3 = 5
PEY1 = -0.5
PKY1 = -20
PKY2 = 1.8
PKY4 = 2
[COMBINED]
RBY1 = 10
RCY1 = 1.0
RBX1 = 12
RCX1 = 1.0
`;
const base = { outer: 634.3, width: 225, rim: 431.8 }; // 225/45R17

describe('tires of other sizes', () => {
  it('load capacity grows with the size; nothing changes for the same size', () => {
    expect(loadCapacityRatio(base, base)).toBeCloseTo(1, 12);
    const wider = { ...base, width: 245 };
    expect(loadCapacityRatio(base, wider)).toBeGreaterThan(1.05);
    expect(loadCapacityRatio(base, { ...base, width: 205 })).toBeLessThan(1);
    expect(sizeChange(base, wider)).toBeCloseTo(20 / 225, 9);
  });

  it('a .tir approximated at another size: size and nominal load move, the shape stays; wider grips a little more at the same load', () => {
    const m = parseTir(TIR, 'road.tir').model!;
    const to = { outer: 652.2, width: 245, rim: 431.8 }; // 245/45R17
    const { model, change } = scaleTir(m, base, to, '245/45R17');
    const k = loadCapacityRatio(base, to);
    expect(model.fnomin).toBeCloseTo(4000 * k, 6);
    expect(model.p.WIDTH).toBeCloseTo(0.245, 9);
    expect(model.p.UNLOADED_RADIUS).toBeCloseTo(0.3261, 6);
    expect(model.p.PDY1).toBe(m.p.PDY1);
    expect(model.name).toMatch(/approximated as 245\/45R17/);
    expect(change).toBeCloseTo(20 / 225, 9);
    const i = { fz: 3500, gamma: 0 };
    expect(mfPeaks(model, i).y).toBeGreaterThan(mfPeaks(m, i).y);
    // Approximating again replaces the label, not stacks it.
    expect(scaleTir(model, to, base, '225/45R17').model.name).toBe('road.tir (approximated as 225/45R17)');
  });

  it('tire + wheel weight from the size (≈ 19.5 kg for a 225/45R17 on a 7.5" rim)', () => {
    expect(tireWheelMass(base, 190.5)).toBeCloseTo(19.5, 1);
    expect(tireWheelMass({ outer: 838, width: 318, rim: 381 })).toBeGreaterThan(30); // 33x12.50R15
  });

  it('a candidate on the car: sizes, unsprung mass, the grip model; fit rules', () => {
    const s = defaultDesign() as unknown as AppState;
    const cur = currentTire(s, 'front').dims;
    const z = parseTireSize('18x7.5-10')!;
    const w = withTire(s, 'both', '18x7.5-10', z);
    const s1 = { ...s, ...w.patch } as AppState;
    expect(resolvedCorner(s1, 'FL').geom.scalars.tireWidth.value).toBeCloseTo(z.sectionWidth, 1);
    expect(resolvedCorner(s1, 'RL').geom.scalars.tireDiameter.value).toBeCloseTo(z.outerDiameter, 1);
    expect(resolvedCorner(s1, 'FL').spring.unsprungMass.value - resolvedCorner(s, 'FL').spring.unsprungMass.value).toBeCloseTo(w.massChange, 2);
    // Generic grip model, both axles: its nominal load follows the size.
    expect(w.patch.tireGrip!.fz0.value / s.tireGrip.fz0.value).toBeCloseTo(loadCapacityRatio(cur, { outer: z.outerDiameter, width: z.sectionWidth, rim: z.rimDiameter }), 6);
    // A .tir on the front only: the rear keeps the unscaled one.
    const m = parseTir(TIR, 'road.tir').model!;
    const s2 = { ...s, tireFile: m, tireFileRear: null } as AppState;
    const w2 = withTire(s2, 'front', '18x7.5-10', z);
    expect(w2.patch.tireFile!.name).toMatch(/approximated/);
    expect(w2.patch.tireFileRear).toBe(m);
    // Fit: another rim needs permission; too wide for the room is left out.
    const set = { axle: 'both' as const, maxGrowDiameter: 25, maxGrowWidth: 25, rimsMayChange: false, reoptimize: false };
    expect(fitProblem(s, set, parseTireSize('225/45R17')!)).toMatch(/rim/);
    const sameRim = parseTireSize(`${Math.round(cur.width + 60)}/40-${Math.round(cur.rim / 25.4)}`) ?? parseTireSize(`20x${((cur.width + 60) / 25.4).toFixed(1)}-${Math.round(cur.rim / 25.4)}`)!;
    expect(fitProblem(s, set, sameRim)).toMatch(/wider/);
    expect(fitProblem(s, { ...set, rimsMayChange: true, maxGrowDiameter: 1000, maxGrowWidth: 1000 }, parseTireSize('225/45R17')!)).toBeNull();
    expect(candidatesOf(['225/45R17', 'nonsense', '225/45R17']).ok).toHaveLength(1);
  });
});
