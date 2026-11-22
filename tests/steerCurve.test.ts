import { describe, it, expect } from 'vitest';
import { parseSteerCurve, steeringWheelAngle, inputForWheelAngle, inputPerRev } from '../src/core';

describe('measured steering ratio curve', () => {
  const text = '90, 18\n180 38\n360,82; 540, 120\nnot a pair';
  it('parses pairs and reports what it couldn\'t read', () => {
    const p = parseSteerCurve(text);
    expect(p.curve).toHaveLength(4);
    expect(p.bad).toEqual(['not a pair']);
    expect(p.ok).toBe(true);
    expect(parseSteerCurve('90, 20\n180, 10').ok).toBe(false); // input must grow
  });
  it('replaces the c-factors: interpolates, inverts, mirrors, and gives the local ratio from its slope', () => {
    const s = { cFactor: 75, rackLimit: 120, curve: parseSteerCurve(text).curve };
    expect(steeringWheelAngle(18, s)).toBeCloseTo(90, 9);
    expect(steeringWheelAngle(60, s)).toBeCloseTo(180 + (22 / 44) * 180, 9);
    expect(steeringWheelAngle(-38, s)).toBeCloseTo(-180, 9);
    expect(inputForWheelAngle(270, s)).toBeCloseTo(60, 9);
    expect(inputForWheelAngle(steeringWheelAngle(100, s), s)).toBeCloseTo(100, 9);
    // Beyond the last pair: the end slope.
    expect(steeringWheelAngle(158, s)).toBeCloseTo(720, 6);
    // Local ratio, mm per revolution: 360 · Δinput / Δwheel.
    expect(inputPerRev(60, s)).toBeCloseTo((360 * 44) / 180, 6);
    // Without a curve the c-factor still rules.
    expect(steeringWheelAngle(75, { cFactor: 75, rackLimit: 30 })).toBeCloseTo(360, 9);
  });
  it('saves with the project; older files have none', async () => {
    const { defaultDesign } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    const d = { ...defaultDesign(), steerCurve: text };
    expect(importProject(JSON.parse(JSON.stringify(serializeProject(d, 'S')))).design.steerCurve).toBe(text);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'O')));
    old.formatVersion = 29;
    const o = importProject(old);
    expect(o.design.steerCurve).toBeUndefined();
    expect(o.warnings.filter((w: string) => !w.startsWith('Upgraded'))).toEqual([]);
  });
});
