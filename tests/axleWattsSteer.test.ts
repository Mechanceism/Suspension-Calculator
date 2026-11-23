import { describe, it, expect } from 'vitest';
import { SolidAxle, axleCharacteristics, solidAxleOf, wattsOf, DoubleWishbone, characteristics, vec3, cross, normalize, Y_AXIS, type DoubleWishboneGeometry, type Vec3 } from '../src/core';
import { SAMPLE_BEAM3 } from '../src/examples/sampleLayouts';

const D = 180 / Math.PI;
/** A wheel's heading (rad, + = its front turned toward the left) from its outboard spin axis. */
const heading = (spin: Vec3, left: boolean) => { const f = normalize(left ? cross(spin, Y_AXIS) : cross(Y_AXIS, spin)); return Math.atan2(f.x, f.z); };

const watts: DoubleWishboneGeometry = { ...SAMPLE_BEAM3, kind: 'beamWatts', panhard: { axle: vec3(0, 200, -120), chassis: vec3(350, 290, -120) } };

describe("Watt's linkage", () => {
  it('locates the axle sideways with no shift in heave; roll center at its pivot', () => {
    const g = solidAxleOf(watts);
    expect(g.watts).toBeDefined();
    expect(g.watts!.bottom.chassis.x).toBeCloseTo(-350, 9); // the bottom link mirrors the top one
    const a = new SolidAxle(g);
    for (const [l, r] of [[0, 0], [40, 40], [-40, -40], [30, -30]]) expect(a.solve({ left: l, right: r }).solve.status).toBe('converged');
    const c = axleCharacteristics(a, a.design());
    expect(c.rollCenterHeight!).toBeCloseTo(200 + 100, 0); // pivot at y = 200, ground at −100
    expect(Math.abs(c.lateralShift)).toBeLessThan(1e-3);
    // A Panhard rod shifts it a little in heave; the Watt's linkage doesn't (to second order).
    const pan = new SolidAxle(solidAxleOf(SAMPLE_BEAM3));
    const shift = (ax: SolidAxle) => Math.abs(ax.solve({ left: 40, right: 40 }).left.center.x - ax.design().left.center.x);
    expect(shift(a)).toBeLessThan(shift(pan));
    expect(wattsOf(vec3(0, 0, 0), vec3(300, 80, 0)).bottom.bar.y).toBeCloseTo(-80, 9);
  });
});

describe('steered solid axle', () => {
  const steered: DoubleWishboneGeometry = {
    ...SAMPLE_BEAM3, steeredAxle: true,
    lca: { ...SAMPLE_BEAM3.lca, out2: vec3(490, 40, 8) }, uca: { ...SAMPLE_BEAM3.uca, out2: vec3(460, 280, -8) },
    tieRod: { inner: vec3(60, 140, -150), outer: vec3(430, 140, -150) },
  };
  it('the rack turns both wheels the same way, the inside one more (Ackermann); KPI and caster from the kingpin', () => {
    const a = new SolidAxle(solidAxleOf(steered));
    const s0 = a.design();
    expect(s0.solve.status).toBe('converged');
    expect(heading(s0.left.spinAxis, true)).toBeCloseTo(0, 6);
    const s = a.solve({ rack: 15 });
    expect(s.solve.status).toBe('converged');
    const hl = heading(s.left.spinAxis, true), hr = heading(s.right.spinAxis, false);
    expect(Math.abs(hl)).toBeGreaterThan(0.05);
    expect(Math.sign(hl)).toBe(Math.sign(hr));
    // The arms point in toward the rear (behind the kingpins): the wheel on the inside of the turn turns more.
    const inside = hl > 0 ? hl : hr, outside = hl > 0 ? hr : hl;
    expect(Math.abs(inside)).toBeGreaterThan(Math.abs(outside));
    // The axle itself doesn't move when steering.
    expect(s.left.center.y).toBeCloseTo(s0.left.center.y, 6);
    const c = characteristics(new DoubleWishbone(steered).design());
    expect(c.kpi * D).toBeCloseTo(Math.atan2(30, 240) * D, 3);
    expect(c.caster * D).toBeCloseTo(Math.atan2(16, 240) * D, 3);
    expect(Number.isFinite(c.scrubRadius)).toBe(true);
    // As a corner: steering moves the wheel; the drag link against the axle's motion gives some bump steer.
    const corner = new DoubleWishbone(steered);
    expect(Math.abs(characteristics(corner.solve({ rack: 10 })).toe - c.toe)).toBeGreaterThan(0.02);
    expect(Math.abs(characteristics(corner.solve({ travel: 30 })).toe - c.toe)).toBeGreaterThan(1e-5);
  });

  it('in the app: switching a steered corner to a solid axle steers it; it saves and loads', async () => {
    const { useApp, editableFromLayout, toGeometry, defaultDesign } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    useApp.setState({ ...defaultDesign() });
    useApp.getState().setSuspensionKind('beamWatts'); // FL is steered by default
    const g = useApp.getState().geom;
    expect(g.kind).toBe('beamWatts');
    expect(g.steeredAxle).toBe(true);
    const c = new DoubleWishbone(toGeometry(g));
    expect(c.design().solve.status).toBe('converged');
    expect(Math.abs(characteristics(c.solve({ rack: 10 })).toe - characteristics(c.design()).toe)).toBeGreaterThan(0.02);
    expect(characteristics(c.design()).kpi * D).toBeCloseTo(Math.atan2(30, 240) * D, 2); // the default kingpin: 7° KPI
    const d = { ...defaultDesign(), geom: g };
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'S')))).design;
    expect(back.geom.steeredAxle).toBe(true);
    expect(back.geom.kind).toBe('beamWatts');
    expect(editableFromLayout('C').steeredAxle).toBeUndefined();
  });
});
