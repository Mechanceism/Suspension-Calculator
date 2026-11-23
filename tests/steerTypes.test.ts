/**
 * Every suspension type that can steer does when its corner is set to steer (the ▶ Steer play moves the
 * rack): a tie rod (or a solid axle's drag link and cross tie rod) is there to draw. A twist beam can't
 * steer and says so.
 */
import { describe, it, expect } from 'vitest';
import { DoubleWishbone, characteristics, SUSPENSION_KINDS } from '../src/core';
import { SAMPLE_LEAF } from '../src/examples/sampleLayouts';
import { linkageShape } from '../src/app/viewport/linkageShape';

const D = 180 / Math.PI;

describe('steering on every type', () => {
  for (const kind of SUSPENSION_KINDS.filter((k) => k !== 'twistBeam')) {
    it(`${kind}: a steered front corner turns with the rack and has its tie rod`, async () => {
      const { useApp, defaultDesign, toGeometry } = await import('../src/app/store');
      useApp.setState({ ...defaultDesign() }); // FL steers by default
      useApp.getState().setSuspensionKind(kind);
      const c = new DoubleWishbone(toGeometry(useApp.getState().geom));
      const toe = (rack: number) => characteristics(c.solve({ rack })).toe * D;
      expect(Math.abs(toe(20) - toe(0))).toBeGreaterThan(3);
      const p = c.solve({ rack: 20 }).points;
      expect(Number.isFinite(p.trInner.x) && Number.isFinite(p.trOuter.x)).toBe(true);
      if (kind.startsWith('beam')) expect(p.crossTieRod).toBeDefined();
    });
  }

  it('a steered leaf-spring axle: both wheels turn together through the cross tie rod', () => {
    const c = new DoubleWishbone({ ...SAMPLE_LEAF, steeredAxle: true, lca: { ...SAMPLE_LEAF.lca, out2: { x: 490, y: 40, z: 8 } }, uca: { ...SAMPLE_LEAF.uca, out2: { x: 460, y: 280, z: -8 } }, tieRod: { inner: { x: 380, y: 140, z: -200 }, outer: { x: 470, y: 140, z: -150 } } });
    const p0 = c.solveAxle({}), p = c.solveAxle({ rack: 15 });
    expect(p.axle.solve.status).toBe('converged');
    expect(p.axle.steer).toBeDefined();
    const dl = characteristics(p.left).toe - characteristics(p0.left).toe, dr = characteristics(p.right).toe - characteristics(p0.right).toe;
    expect(Math.abs(dl * D)).toBeGreaterThan(2);
    expect(Math.sign(dl)).toBe(-Math.sign(dr)); // toe in on one side, out on the other: both turn the same way
    // The vehicle view draws its drag link and cross tie rod, and the kingpin as the steering axis.
    const sh = linkageShape(p.left.points, 'beamLeaf', 'left');
    expect(sh.axis[0]).toEqual(p.left.points.steerLower);
    expect(p.left.points.crossTieRod).toBeDefined();
  });

  it('ticking Steers on a solid axle (not the corner being edited) makes it a steered axle', async () => {
    const { useApp, defaultDesign, toGeometry, resolvedCorner } = await import('../src/app/store');
    useApp.setState({ ...defaultDesign() });
    useApp.getState().setActiveCorner('RL');
    useApp.getState().setSuspensionKind('beam4'); // rear corners don't steer by default
    expect(resolvedCorner(useApp.getState(), 'RL').geom.steeredAxle).toBeFalsy();
    useApp.getState().setActiveCorner('FL');
    useApp.getState().setCornerSetting('RL', 'steered', true);
    const g = resolvedCorner(useApp.getState(), 'RL').geom;
    expect(g.steeredAxle).toBe(true);
    const c = new DoubleWishbone(toGeometry(g));
    expect(Math.abs(characteristics(c.solve({ rack: 20 })).toe - characteristics(c.design()).toe) * D).toBeGreaterThan(3);
    // The corner being edited is unchanged.
    expect(useApp.getState().geom.kind ?? 'doubleWishbone').toBe('doubleWishbone');
  });

  it('a twist beam set to steer says it does not', async () => {
    const { useApp, defaultDesign } = await import('../src/app/store');
    useApp.setState({ ...defaultDesign() });
    useApp.getState().setSuspensionKind('twistBeam'); // on the steered FL
    expect(useApp.getState().notice?.kind).toBe('warn');
    expect(useApp.getState().notice?.text).toMatch(/doesn't/);
    useApp.setState({ ...defaultDesign() });
    useApp.getState().setActiveCorner('RL');
    useApp.getState().setSuspensionKind('twistBeam');
    useApp.getState().setCornerSetting('RL', 'steered', true);
    expect(useApp.getState().notice?.kind).toBe('warn');
  });
});
