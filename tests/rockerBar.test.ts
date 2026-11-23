import { describe, it, expect } from 'vitest';
import { DoubleWishbone, rockerFromCoilover, springLength, rockerRatio, rockerRatioMove, CornerTable, add, sub, length, type DoubleWishboneGeometry } from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const d0 = C.damper!;
const lay = rockerFromCoilover(d0.chassis, d0.armPoint, 'lca');
const R: DoubleWishboneGeometry = { ...C, rocker: lay.rocker, damper: { chassis: lay.damper.chassis, arm: 'rocker', armPoint: lay.damper.armPoint } };
const mr = (g: DoubleWishboneGeometry) => { const k = new DoubleWishbone(g); return Math.abs(springLength(k.solve({ travel: 1 }))! - springLength(k.solve({ travel: -1 }))!) / 2; };

describe('rocker ratio', () => {
  it('reads the levers, and setting it scales the spring motion by the same factor (coilover keeps its length)', () => {
    const r0 = rockerRatio(R);
    expect(r0.ratio).toBeGreaterThan(0);
    const d = rockerRatioMove(R, r0.ratio * 1.2)!;
    const g: DoubleWishboneGeometry = { ...R, damper: { ...R.damper!, armPoint: add(R.damper!.armPoint, d), chassis: add(R.damper!.chassis, d) } };
    expect(rockerRatio(g).ratio).toBeCloseTo(r0.ratio * 1.2, 9);
    expect(length(sub(g.damper!.chassis, g.damper!.armPoint))).toBeCloseTo(length(sub(R.damper!.chassis, R.damper!.armPoint)), 9);
    expect(mr(g) / mr(R)).toBeCloseTo(1.2, 1);
    expect(rockerRatioMove(C, 1)).toBeNull(); // no rocker
  });
});

describe('anti-roll bar drop link on the rocker', () => {
  it('tracks a point on the rocker through travel (it moves with the rocker, not the arm)', () => {
    const corner = new DoubleWishbone(R);
    const pt = add(R.rocker!.pushrodUpper, { x: 0, y: 0, z: 40 });
    const onRocker = new CornerTable(corner, 0, [-30, 30], 13, { body: 'rocker', point: pt });
    const onArm = new CornerTable(corner, 0, [-30, 30], 13, { body: 'lca', point: pt });
    const a = onRocker.at(20).ex, b = onRocker.at(-20).ex, c = onArm.at(20).ex;
    expect(length(sub(a, b))).toBeGreaterThan(3);
    expect(length(sub(a, c))).toBeGreaterThan(1);
    // A corner without a rocker puts it on the knuckle (no failure).
    expect(() => new CornerTable(new DoubleWishbone(C), 0, [-30, 30], 13, { body: 'rocker', point: pt })).not.toThrow();
  });

  it('saves with the project; older files keep it on the lower arm', async () => {
    const { defaultDesign } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    const d = defaultDesign();
    d.shared = { ...d.shared, front: { ...d.shared.front, antiRollBar: 'torsionBar', dropLinkOn: 'rocker' } };
    expect(importProject(JSON.parse(JSON.stringify(serializeProject(d, 'R')))).design.shared.front.dropLinkOn).toBe('rocker');
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'O')));
    old.formatVersion = 28;
    const o = importProject(old);
    expect(o.design.shared.front.dropLinkOn ?? 'lca').toBe('lca');
    expect(o.warnings.filter((w: string) => !w.startsWith('Upgraded'))).toEqual([]);
  });
});
