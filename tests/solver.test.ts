import { describe, it, expect } from 'vitest';
import { ConstraintSystem, PoseContext, revolute, hingeAngle, vec3 } from '../src/core';

describe('ConstraintSystem', () => {
  it('solves a hinged pendulum driven by angle', () => {
    const sys = new ConstraintSystem();
    sys.addBody('ground', vec3(0, 0, 0), { fixed: true });
    sys.addBody('arm', vec3(50, 0, 0), { size: 50 });
    sys.add(revolute(sys, 'hinge', 'ground', 'arm', vec3(0, 0, -10), vec3(0, 0, 10)));
    const angle = Math.PI / 6;
    sys.add(hingeAngle(sys, 'drive', 'arm', vec3(0, 0, -10), vec3(0, 0, 10), vec3(100, 0, 0), angle));
    const result = sys.solve(sys.designPoses());
    expect(result.status).toBe('converged');
    expect(result.equations).toBe(6);
    expect(result.unknowns).toBe(6);
    const tip = new PoseContext(result.poses).world(sys.attach('arm', vec3(100, 0, 0)));
    expect(tip.x).toBeCloseTo(100 * Math.cos(angle), 8);
    expect(tip.y).toBeCloseTo(100 * Math.sin(angle), 8);
    expect(tip.z).toBeCloseTo(0, 8);
  });

  it('reports an under-constrained system', () => {
    const sys = new ConstraintSystem();
    sys.addBody('ground', vec3(0, 0, 0), { fixed: true });
    sys.addBody('arm', vec3(50, 0, 0), { size: 50 });
    sys.add(revolute(sys, 'hinge', 'ground', 'arm', vec3(0, 0, -10), vec3(0, 0, 10)));
    const result = sys.solve(sys.designPoses());
    expect(result.status).toBe('under-constrained');
    expect(result.rank).toBeLessThan(result.unknowns);
  });
});
