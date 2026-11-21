import { describe, it, expect } from 'vitest';
import {
  DoubleWishbone, characteristics, deg, rad, linkLengths, spinAxisFromCamberToe,
  vec3, sub, dot, cross, normalize, distance, closestPointOnLine, lineThrough,
  rotatePointAboutAxis, type Vec3, type DoubleWishboneGeometry,
} from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const layoutC = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;

/** Independent 2D check: intersection of two circles in the XY plane, nearest to `near`. */
function circleIntersection(c1: Vec3, r1: number, c2: Vec3, r2: number, near: Vec3): Vec3 {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(r1 * r1 - a * a);
  const mx = c1.x + (a * dx) / d, my = c1.y + (a * dy) / d;
  const s1 = vec3(mx + (h * dy) / d, my - (h * dx) / d, 0);
  const s2 = vec3(mx - (h * dy) / d, my + (h * dx) / d, 0);
  return distance(s1, near) < distance(s2, near) ? s1 : s2;
}

describe('DoubleWishbone: design state', () => {
  it('returns the design geometry with zero inputs', () => {
    const s = new DoubleWishbone(layoutC).design();
    expect(s.solve.status).toBe('converged');
    expect(distance(s.points.ucaOut, layoutC.uca.out)).toBeLessThan(1e-8);
    expect(distance(s.points.lcaOut, layoutC.lca.out)).toBeLessThan(1e-8);
    expect(distance(s.points.wheelCenter, layoutC.wheel.center)).toBeLessThan(1e-8);
    expect(s.solve.equations).toBe(18);
    expect(s.solve.unknowns).toBe(18);
  });

  it('static camber and toe set through the spin axis read back exactly', () => {
    const geom = { ...layoutC, wheel: { ...layoutC.wheel, spinAxis: spinAxisFromCamberToe(rad(-1.5), rad(0.25)) } };
    const c = characteristics(new DoubleWishbone(geom).design());
    expect(deg(c.camber)).toBeCloseTo(-1.5, 9);
    expect(deg(c.toe)).toBeCloseTo(0.25, 9);
  });

  it('static characteristics match hand calculation', () => {
    const c = characteristics(new DoubleWishbone(layoutC).design());
    expect(deg(c.camber)).toBeCloseTo(0, 9);
    expect(deg(c.toe)).toBeCloseTo(0, 9);
    expect(deg(c.caster)).toBeCloseTo(0, 9);
    expect(deg(c.kpi)).toBeCloseTo(deg(Math.atan(30 / 280)), 9); // 6.116°
    expect(c.scrubRadius).toBeCloseTo(25, 6); // axis meets ground at x = 575
    expect(c.kingpinOffsetAtWheelCenter).toBeCloseTo(600 - (560 - (120 / 280) * 30), 6);
    expect(c.mechanicalTrail).toBeCloseTo(0, 9);
    expect(c.groundY).toBeCloseTo(-100, 9);
    expect(c.fvsa).toBeCloseTo(2000, 6);
    expect(c.rollCenterHeight!).toBeCloseTo(50, 6);
    expect(c.svsa).toBe(Infinity); // pivots parallel to Z → no anti geometry
  });
});

describe('DoubleWishbone: through travel', () => {
  const corner = new DoubleWishbone(layoutC);
  const travels = [-60, -30, -10, 0, 10, 30, 60];
  const states = corner.sweep(travels, (travel) => ({ travel }));
  const design = linkLengths(corner.design().points);

  it('converges at every travel position and hits the travel target', () => {
    states.forEach((s, i) => {
      expect(s.solve.status).toBe('converged');
      expect(s.points.wheelCenter.y).toBeCloseTo(layoutC.wheel.center.y + travels[i]!, 8);
    });
  });

  it('preserves every link length and the rigid upright', () => {
    for (const s of states) {
      const l = linkLengths(s.points);
      expect(l.ucaFwd).toBeCloseTo(design.ucaFwd, 7);
      expect(l.ucaAft).toBeCloseTo(design.ucaAft, 7);
      expect(l.lcaFwd).toBeCloseTo(design.lcaFwd, 7);
      expect(l.lcaAft).toBeCloseTo(design.lcaAft, 7);
      expect(l.tieRod).toBeCloseTo(design.tieRod, 7);
      expect(l.ballJoints).toBeCloseTo(design.ballJoints, 7);
    }
  });

  it('gains negative camber in bump and positive in droop', () => {
    const cam = states.map((s) => characteristics(s).camber);
    expect(cam[travels.indexOf(30)]!).toBeLessThan(0);
    expect(cam[travels.indexOf(-30)]!).toBeGreaterThan(0);
  });

  it('matches an independent 2D four-bar solution (lower-arm-angle driver)', () => {
    const pu = closestPointOnLine(lineThrough(layoutC.uca.aft, layoutC.uca.fwd), layoutC.uca.out);
    const pl = closestPointOnLine(lineThrough(layoutC.lca.aft, layoutC.lca.fwd), layoutC.lca.out);
    const rU = distance(pu, layoutC.uca.out);
    const c = distance(layoutC.uca.out, layoutC.lca.out);
    for (const angleDeg of [-12, -5, 0, 5, 12]) {
      const s = corner.solve({ driver: 'lowerArmAngle', armAngle: rad(angleDeg) });
      expect(s.solve.status).toBe('converged');
      const lbj = rotatePointAboutAxis(layoutC.lca.out, pl, vec3(0, 0, 1), rad(angleDeg));
      const ubj = circleIntersection(pu, rU, lbj, c, layoutC.uca.out);
      expect(distance(s.points.lcaOut, lbj)).toBeLessThan(1e-6);
      expect(distance(s.points.ucaOut, ubj)).toBeLessThan(1e-6);
      // Camber change ≈ −(upright rotation in front view). Bump steer adds a second-order term
      // (toe rotation about the inclined kingpin axis, ~0.0006° at 12°), so compare to 0.005°.
      // The ball-joint positions above are the exact independent check.
      const phi =
        Math.atan2(ubj.y - lbj.y, ubj.x - lbj.x) -
        Math.atan2(layoutC.uca.out.y - layoutC.lca.out.y, layoutC.uca.out.x - layoutC.lca.out.x);
      expect(deg(characteristics(s).camber)).toBeCloseTo(deg(-phi), 2);
    }
  });
});

describe('DoubleWishbone: steering', () => {
  const corner = new DoubleWishbone(layoutC);
  const design = corner.design();

  it('steering at a fixed arm angle is a pure rotation about the ball-joint axis (Rodrigues)', () => {
    for (const rack of [-15, 15]) {
      const s = corner.solve({ driver: 'lowerArmAngle', armAngle: 0, rack });
      expect(s.solve.status).toBe('converged');
      expect(distance(s.points.ucaOut, layoutC.uca.out)).toBeLessThan(1e-6);
      expect(distance(s.points.lcaOut, layoutC.lca.out)).toBeLessThan(1e-6);
      // Recover the steer angle from the tie-rod outer point, then rotate the wheel center by it.
      const axisPt = layoutC.lca.out;
      const u = normalize(sub(layoutC.uca.out, layoutC.lca.out));
      const r0 = sub(layoutC.tieRod.outer, axisPt);
      const r1 = sub(s.points.trOuter, axisPt);
      const p0 = sub(r0, vec3(u.x * dot(r0, u), u.y * dot(r0, u), u.z * dot(r0, u)));
      const p1 = sub(r1, vec3(u.x * dot(r1, u), u.y * dot(r1, u), u.z * dot(r1, u)));
      const angle = Math.atan2(dot(u, cross(p0, p1)), dot(p0, p1));
      const expected = rotatePointAboutAxis(layoutC.wheel.center, axisPt, u, angle);
      expect(distance(s.points.wheelCenter, expected)).toBeLessThan(1e-6);
    }
  });

  it('KPI jacking: with zero caster the tire drops (body would rise) when steered either way', () => {
    const y0 = design.points.contact.y;
    for (const rack of [-15, 15]) {
      const s = corner.solve({ driver: 'lowerArmAngle', armAngle: 0, rack });
      expect(s.points.contact.y).toBeLessThan(y0);
      expect(deg(characteristics(s).toe)).not.toBeCloseTo(0, 1);
    }
  });
});

describe('Parallel equal-length arms (parallelogram)', () => {
  const geom: DoubleWishboneGeometry = {
    uca: { fwd: vec3(230, 320, 150), aft: vec3(230, 320, -150), out: vec3(530, 320, 0) },
    lca: { fwd: vec3(230, 40, 150), aft: vec3(230, 40, -150), out: vec3(530, 40, 0) },
    tieRod: { inner: vec3(230, 100, -120), outer: vec3(530, 100, -120) },
    wheel: { center: vec3(570, 180, 0), spinAxis: vec3(1, 0, 0), radius: 280 },
  };
  const corner = new DoubleWishbone(geom);

  it('keeps camber constant through travel and puts the IC at infinity', () => {
    for (const travel of [-40, 0, 40]) {
      const c = characteristics(corner.solve({ travel }));
      expect(deg(c.camber)).toBeCloseTo(0, 8);
      expect(c.fvsa).toBe(Infinity);
    }
    expect(characteristics(corner.design()).rollCenterHeight!).toBeCloseTo(0, 8);
  });
});

describe('Sample layouts', () => {
  const byId = Object.fromEntries(SAMPLE_LAYOUTS.map((l) => [l.id, new DoubleWishbone(l.geometry)]));

  it('A–C share the same static IC, roll center and camber gain', () => {
    const ref = characteristics(byId.A!.design());
    const gain = (id: string) => {
      const [m, p] = byId[id]!.sweep([-0.5, 0.5], (travel) => ({ travel })).map(characteristics);
      return (p!.camber - m!.camber) / 1;
    };
    for (const id of ['B', 'C']) {
      const c = characteristics(byId[id]!.design());
      expect(c.fvsa).toBeCloseTo(ref.fvsa, 6);
      expect(c.rollCenterHeight!).toBeCloseTo(ref.rollCenterHeight!, 6);
      expect(gain(id)).toBeCloseTo(gain('A'), 6);
    }
  });

  it('every layout passes through zero camber from positive (droop) to negative (bump)', () => {
    for (const id of ['A', 'B', 'C', 'D']) {
      const [droop, mid, bump] = byId[id]!.sweep([-40, 0, 40], (travel) => ({ travel })).map(characteristics);
      expect(droop!.camber).toBeGreaterThan(0);
      expect(mid!.camber).toBeCloseTo(0, 9);
      expect(bump!.camber).toBeLessThan(0);
    }
  });
});
