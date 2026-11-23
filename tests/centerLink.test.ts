import { describe, it, expect } from 'vitest';
import { DoubleWishbone, characteristics, centerLinkPose, vec3, add, sub, type DoubleWishboneGeometry } from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const i = C.tieRod.inner;
const A0 = vec3(i.x - 60, i.y, i.z), Bx = -A0.x;
const link = {
  pivot1: vec3(A0.x, i.y - 60, i.z + 150), pivot2: vec3(A0.x, i.y + 90, i.z + 150), pitmanEnd: A0,
  idlerPivot1: vec3(Bx, i.y - 60, i.z + 150), idlerPivot2: vec3(Bx, i.y + 90, i.z + 150), idlerEnd: vec3(Bx, i.y, i.z),
};

describe('center-link steering', () => {
  it('a parallelogram (equal, parallel pitman and idler arms) slides the link without turning it', () => {
    const p = centerLinkPose(link, 20)!;
    expect(p).not.toBeNull();
    expect(p.idlerAngle * 180 / Math.PI).toBeCloseTo(20, 6);
    for (const k of [0, 4, 8]) expect(p.R[k]).toBeCloseTo(1, 9);
  });

  it('steers the corner exactly like a steering arm on the shifted pitman axis; an unequal idler turns the link', () => {
    const g: DoubleWishboneGeometry = { ...C, steering: { kind: 'centerLink', ...link } };
    const d = sub(i, A0);
    const arm: DoubleWishboneGeometry = { ...C, steering: { kind: 'arm', pivot1: add(link.pivot1, d), pivot2: add(link.pivot2, d) } };
    for (const deg of [-25, -10, 10, 25]) {
      const a = characteristics(new DoubleWishbone(g).solve({ rack: deg })), b = characteristics(new DoubleWishbone(arm).solve({ rack: deg }));
      expect(a.toe).toBeCloseTo(b.toe, 8);
    }
    expect(Math.abs(characteristics(new DoubleWishbone(g).solve({ rack: 15 })).toe)).toBeGreaterThan(0.02);
    const shortIdler = { ...link, idlerPivot1: vec3(Bx, i.y - 60, i.z + 110), idlerPivot2: vec3(Bx, i.y + 90, i.z + 110) };
    const q = centerLinkPose(shortIdler, 20)!;
    expect(Math.abs(q.R[2]!)).toBeGreaterThan(1e-3); // the link turns
  });

  it('in the app: switching lays one out around the inner joint; it saves; older files get the points quietly', async () => {
    const { useApp, defaultDesign, toGeometry } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    useApp.setState({ ...defaultDesign() });
    useApp.getState().setSteerMechanism('centerLink');
    const g = useApp.getState().geom;
    expect(g.steerMechanism).toBe('centerLink');
    const corner = new DoubleWishbone(toGeometry(g));
    expect(Math.abs(characteristics(corner.solve({ rack: 15 })).toe - characteristics(corner.design()).toe)).toBeGreaterThan(0.02);
    expect(useApp.getState().steer.cFactor.value).toBe(24);
    const d = useApp.getState();
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'L')))).design;
    expect(back.geom.steerMechanism).toBe('centerLink');
    expect(back.geom.points.idlEnd[0].value).toBeCloseTo(g.points.idlEnd[0].value, 6);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'O')));
    old.formatVersion = 30;
    for (const c of Object.values(old.corners) as { points: Record<string, unknown> }[]) for (const k of Object.keys(c.points)) if (/Pitman|Idler/.test(k)) delete c.points[k];
    const o = importProject(old);
    expect(o.warnings.filter((w: string) => !w.startsWith('Upgraded'))).toEqual([]);
    expect(Number.isFinite(o.design.geom.points.pitEnd[0].value)).toBe(true);
  });
});
