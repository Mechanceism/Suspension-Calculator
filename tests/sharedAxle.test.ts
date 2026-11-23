/**
 * A solid axle or twist beam is ONE part under both wheels: both corners come from one solve of the whole
 * axle (so both wheels sit on it), its left and right always share one design, and the vehicle view draws
 * the shared parts once.
 */
import { describe, it, expect } from 'vitest';
import { DoubleWishbone, characteristics, vec3, type DoubleWishboneGeometry, type Vec3 } from '../src/core';
import {
  SAMPLE_BEAM4, SAMPLE_BEAM3, SAMPLE_BEAM_WATTS, SAMPLE_LEAF, SAMPLE_BEAM_STEERED, SAMPLE_TWIST_BEAM, SAMPLE_LAYOUTS,
} from '../src/examples/sampleLayouts';
import { linkageShape } from '../src/app/viewport/linkageShape';

const m = (v: Vec3) => vec3(-v.x, v.y, v.z);
const d = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const AXLES: [string, DoubleWishboneGeometry][] = [
  ['4-link', SAMPLE_BEAM4], ['3-link + Panhard', SAMPLE_BEAM3], ["Watt's", SAMPLE_BEAM_WATTS],
  ['leaf springs', SAMPLE_LEAF], ['steered', SAMPLE_BEAM_STEERED], ['twist beam', SAMPLE_TWIST_BEAM],
];

describe('one axle under both wheels', () => {
  for (const [name, g] of AXLES) {
    it(`${name}: in roll both corners are on the same axle`, () => {
      const c = new DoubleWishbone(g);
      const p = c.solveAxle({ left: 30, right: -30 });
      expect(p.axle.solve.status).toBe('converged');
      // Each wheel at its own travel; the right corner in its own (mirrored) frame.
      expect(p.left.points.wheelCenter.y).toBeCloseTo(g.wheel.center.y + 30, 6);
      expect(p.right.points.wheelCenter.y).toBeCloseTo(g.wheel.center.y - 30, 6);
      expect(p.right.points.wheelCenter.x).toBeGreaterThan(0);
      // The left corner's axle ends at the right wheel, and the two corners agree on the axle's ends.
      expect(d(p.left.points.axleRight!, m(p.right.points.wheelCenter))).toBeLessThan(1e-9);
      expect(d(p.left.points.axleEnds![1], m(p.right.points.axleEnds![0]))).toBeLessThan(1e-9);
      expect(d(p.left.points.axleEnds![0], m(p.right.points.axleEnds![1]))).toBeLessThan(1e-9);
      // The right wheel is the axle's right wheel (not a second axle heaved to its travel).
      expect(d(m(p.right.points.wheelCenter), p.axle.right.center)).toBeLessThan(1e-9);
      expect(d(m(p.right.spinAxis), p.axle.right.spinAxis)).toBeLessThan(1e-9);
      const alone = c.solve({ travel: -30 });
      expect(d(p.right.points.wheelCenter, alone.points.wheelCenter)).toBeGreaterThan(0.5);
      // A rolled axle cambers the wheels equally and oppositely (the right in its own frame).
      expect(characteristics(p.left).camber).toBeCloseTo(-characteristics(p.right).camber, 2);
    });

    it(`${name}: in heave it is the single-corner solve; mounts on it can be found (drop links)`, () => {
      const c = new DoubleWishbone(g);
      const p = c.solveAxle({ left: 20, right: 20 }), one = c.solve({ travel: 20 });
      expect(d(p.left.points.wheelCenter, one.points.wheelCenter)).toBeLessThan(1e-6);
      // The right wheel mirrors it but for the axle's sideways shift (a Panhard rod's arc moves both wheels the same way).
      expect(p.right.points.wheelCenter.y).toBeCloseTo(one.points.wheelCenter.y, 6);
      // (A steered axle's drag link bump-steers both wheels the same way, so they don't mirror fore / aft.)
      if (!g.steeredAxle) {
        expect(p.right.points.wheelCenter.z).toBeCloseTo(one.points.wheelCenter.z, 6);
        expect(p.right.points.wheelCenter.x + one.points.wheelCenter.x).toBeCloseTo(2 * Math.abs(g.wheel.center.x), 6);
      }
      // A drop-link mount moves with the axle: at rest it is the design point; in heave both sides rise
      // alike (a Panhard rod also shifts the axle sideways, so only the heights match).
      const at0 = c.solveAxle({});
      expect(d(c.pointOn(at0.left, 'lca', g.lca.out), g.lca.out)).toBeLessThan(1e-6);
      expect(d(c.pointOn(at0.right, 'lca', g.lca.out), g.lca.out)).toBeLessThan(1e-6);
      // (A steered axle rolls a hair as its knuckles turn with the bump steer.)
      expect(Math.abs(c.pointOn(p.left, 'lca', g.lca.out).y - c.pointOn(p.right, 'lca', g.lca.out).y)).toBeLessThan(g.steeredAxle ? 0.1 : 1e-3);
      expect(() => c.pointOn(one, 'lca', g.lca.out)).not.toThrow();
    });
  }

  it('steered axle: each corner turns on its own kingpin of the one axle, the right one with the same rack', () => {
    const c = new DoubleWishbone(SAMPLE_BEAM_STEERED);
    const p = c.solveAxle({ left: 20, right: -20, rack: 10 });
    const st = p.axle.steer!;
    expect(d(m(p.right.points.steerLower), st.kingpin.right[0])).toBeLessThan(1e-9);
    expect(d(m(p.right.points.steerUpper), st.kingpin.right[1])).toBeLessThan(1e-9);
    expect(d(p.left.points.crossTieRod![1], m(p.right.points.crossTieRod![0]))).toBeLessThan(1e-9);
    // Steering left turns both wheels left: the toe changes oppositely in the corners' own frames.
    const p0 = c.solveAxle({ left: 20, right: -20 });
    const dl = characteristics(p.left).toe - characteristics(p0.left).toe, dr = characteristics(p.right).toe - characteristics(p0.right).toe;
    expect(Math.sign(dl)).toBe(-Math.sign(dr));
  });

  it('independent corners have no shared axle', () => {
    expect(() => new DoubleWishbone(SAMPLE_LAYOUTS[0]!.geometry).solveAxle({})).toThrow();
  });
});

describe('the vehicle view draws a shared axle once', () => {
  const segs = (s: ReturnType<typeof linkageShape>) => [...s.uca, ...s.lca];
  for (const [name, g] of AXLES) {
    it(`${name}: the right corner draws only its own links; the left one the shared parts`, () => {
      const c = new DoubleWishbone(g);
      const p = c.solveAxle({ left: 30, right: -30 });
      const kind = p.left.kind;
      const whole = linkageShape(p.left.points, kind, 'whole');
      const left = linkageShape(p.left.points, kind, 'left');
      // The right corner's points as the vehicle view places them (mirrored back to the vehicle frame).
      const rp = Object.fromEntries(Object.entries(p.right.points).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? x.map(m) : m(x))) : m(v as Vec3)])) as unknown as typeof p.right.points;
      const right = linkageShape(rp, kind, 'right');
      // Together they draw as many links as the whole axle, none twice (the corner view draws one twist-beam arm).
      expect(segs(left).length + segs(right).length).toBe(segs(whole).length + (kind === 'twistBeam' ? 1 : 0));
      // The right corner's own links end at the axle's right side (where the left drawing mirrors them to).
      if (kind !== 'twistBeam') for (const [a, b] of segs(right)) expect(segs(whole).some(([x, y]) => d(a, x) + d(b, y) < 1e-6)).toBe(true);
      else {
        // The beam joins the two arms: its ends are where each arm's own beam end is.
        const beam = left.lca[1]!;
        expect(d(beam[1], m(p.right.points.axleEnds![0]))).toBeLessThan(1e-9);
      }
      // The tube / beam is drawn by the left corner only, from wheel to wheel.
      if (kind !== 'twistBeam') {
        expect(d(left.upright[left.upright.length - 1]!, rp.wheelCenter)).toBeLessThan(1e-9);
        expect(right.upright.length).toBe(2);
      }
    });
  }
});

describe('left and right of an axle share one design', () => {
  it('a solid axle or twist beam pair cannot be unlinked; independent ones can', async () => {
    const { useApp, defaultDesign } = await import('../src/app/store');
    useApp.setState({ ...defaultDesign() });
    useApp.getState().setActiveCorner('RL');
    useApp.getState().setSuspensionKind('twistBeam');
    expect(useApp.getState().links.rearPair).toBe(true);
    useApp.getState().setLink('rearPair', false);
    expect(useApp.getState().links.rearPair).toBe(true);
    expect(useApp.getState().notice?.kind).toBe('warn');
    useApp.getState().setLink('frontPair', false); // the front is independent
    expect(useApp.getState().links.frontPair).toBe(false);
  });

  it('choosing an axle type on the right of an unlinked pair links it and keeps the new type on both', async () => {
    const { useApp, defaultDesign, resolvedCorner } = await import('../src/app/store');
    useApp.setState({ ...defaultDesign() });
    useApp.getState().setLink('rearFromFront', false);
    useApp.getState().setLink('rearPair', false);
    useApp.getState().setActiveCorner('RR');
    useApp.getState().setSuspensionKind('beam4');
    const s = useApp.getState();
    expect(s.links.rearPair).toBe(true);
    expect(resolvedCorner(s, 'RL').geom.kind).toBe('beam4');
    expect(resolvedCorner(s, 'RR').geom.kind).toBe('beam4');
    expect(resolvedCorner(s, 'FL').geom.kind ?? 'doubleWishbone').toBe('doubleWishbone');
  });

  it('a file with an axle pair unlinked loads linked, with a warning', async () => {
    const { useApp, defaultDesign } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    useApp.setState({ ...defaultDesign() });
    useApp.getState().setLink('rearFromFront', false);
    useApp.getState().setLink('rearPair', false);
    useApp.getState().setActiveCorner('RR');
    useApp.getState().setSuspensionKind('beamLeaf');
    const json = JSON.parse(JSON.stringify(serializeProject(useApp.getState(), 'S')));
    // As an older version could have saved it: the pair apart, the axle only on the right.
    json.links.rearPair = false;
    const o = importProject(json);
    expect(o.design.links.rearPair).toBe(true);
    expect(o.design.corners.RL.geom.kind).toBe('beamLeaf');
    expect(o.warnings.some((w) => w.includes('one axle under both wheels'))).toBe(true);
  });
});
