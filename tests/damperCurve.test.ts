import { describe, it, expect } from 'vitest';
import { curveForce, parseDamperCurve, blendCurves, damperForce } from '../src/core';
import { damperOf } from '../src/app/optimizer';
import { defaultDesign, DEFAULT_DAMPER_CURVE } from '../src/app/store';

describe('damper dyno curves and clicker', () => {
  it('reads a dyno sheet (mm/s, N), interpolates, extends with the last slope, resists the motion', () => {
    const { pts, bad } = parseDamperCurve('50, 200\n100 350\n200, 500\nspeed, force');
    expect(bad).toEqual(['speed, force']);
    expect(pts[0]).toEqual([0.05, 200]);
    expect(curveForce(pts, 0.025)).toBeCloseTo(100, 9);
    expect(curveForce(pts, 0.15)).toBeCloseTo(425, 9);
    expect(curveForce(pts, 0.3)).toBeCloseTo(650, 9); // last slope 1500 N/(m/s)
    const spec = { bump: 0, rebound: 0, curve: { bump: pts, rebound: pts.map(([v, f]) => [v, 2 * f] as [number, number]) } };
    expect(damperForce(spec, -0.1)).toBeCloseTo(-350, 9);
    expect(damperForce(spec, 0.1)).toBeCloseTo(700, 9);
  });
  it('the clicker blends full soft and full firm; the low-speed slope stands in for the rate', () => {
    const soft: [number, number][] = [[0.1, 300]], firm: [number, number][] = [[0.05, 300], [0.1, 600]];
    expect(curveForce(blendCurves(soft, firm, 0.5), 0.1)).toBeCloseTo(450, 9);
    const d = defaultDesign();
    const curve = { ...DEFAULT_DAMPER_CURVE, softBump: '100, 300', softRebound: '100, 500', firmBump: '100, 900', firmRebound: '100, 1500', clicks: 10, click: 5 };
    const spec = damperOf({ damper: d.damper, damperMode: 'curve', damperCurve: curve });
    expect(damperForce(spec, -0.1)).toBeCloseTo(-600, 9);
    expect(spec.bump).toBeCloseTo(6000, 6); // 600 N at 0.1 m/s
    expect(damperForce(damperOf({ damper: d.damper, damperMode: 'curve', damperCurve: { ...curve, click: 0 } }), 0.1)).toBeCloseTo(500, 9);
  });
  it('saves with the project; older files load without', async () => {
    const { serializeProject, importProject } = await import('../src/app/project');
    const d = { ...defaultDesign(), damperMode: 'curve' as const, damperCurve: { ...DEFAULT_DAMPER_CURVE, clicks: 12, click: 4 } };
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'D')))).design;
    expect(back.damperMode).toBe('curve');
    expect(back.damperCurve!.click).toBe(4);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'O')));
    old.formatVersion = 35;
    expect(importProject(old).warnings.filter((w: string) => !w.startsWith('Upgraded'))).toEqual([]);
  });
});
