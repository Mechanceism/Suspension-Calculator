import { describe, it, expect } from 'vitest';
import { serializeProject, importProject, designSnapshot, FORMAT_VERSION, APP_VERSION } from '../src/app/project';
import { defaultDesign, type DesignState } from '../src/app/store';

const roundTrip = (d: DesignState) => importProject(JSON.parse(JSON.stringify(serializeProject(d, 'Test car'))));

describe('project files', () => {
  it('records the format and app version', () => {
    const f = serializeProject(defaultDesign(), 'Test car');
    expect(f.formatVersion).toBe(FORMAT_VERSION);
    expect(f.appVersion).toBe(APP_VERSION);
    expect(f.corner.points.FL_UCA_Fwd).toBeDefined(); // parameter names as keys
  });

  it('round-trips a design exactly, keeping the typed units', () => {
    const d = defaultDesign();
    d.geom.points.ucaOut = [{ text: '21in', value: 533.4 }, d.geom.points.ucaOut[1], d.geom.points.ucaOut[2]];
    d.spring.cornerLoad = { text: '200lbf', value: 889.64432 };
    d.geom.damperArm = 'uca';
    d.tireModel = 'stiffness';
    d.droop = 70;
    const r = roundTrip(d);
    expect(r.warnings).toEqual([]);
    expect(r.name).toBe('Test car');
    expect(r.design.geom.points.ucaOut[0]).toEqual({ text: '21in', value: 533.4 });
    expect(r.design.spring.cornerLoad.text).toBe('200lbf');
    expect(r.design.geom.damperArm).toBe('uca');
    expect(r.design.tireModel).toBe('stiffness');
    expect(r.design.droop).toBe(70);
    expect(designSnapshot(r.design)).toBe(designSnapshot(d));
  });

  it('fills missing values with defaults and reports them', () => {
    const f = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'Old'))) as Record<string, any>;
    delete f.corner.points.FL_Dmp_Arm;
    delete f.spring.unsprungMass;
    const r = importProject(f);
    expect(r.design.geom.points.dmpArm[0].value).toBe(defaultDesign().geom.points.dmpArm[0].value);
    expect(r.warnings.some((w) => w.includes('FL_Dmp_Arm'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('spring.unsprungMass'))).toBe(true);
  });

  it('warns about files from a newer version and ignores unknown values', () => {
    const f = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'Future'))) as Record<string, any>;
    f.formatVersion = FORMAT_VERSION + 1;
    f.spring.someFutureSetting = { text: '3', value: 3 };
    const r = importProject(f);
    expect(r.warnings.some((w) => w.includes('newer version'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('someFutureSetting'))).toBe(true);
  });

  it('falls back to the stored number when the text no longer parses', () => {
    const f = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'X'))) as Record<string, any>;
    f.corner.points.FL_UCA_Out.x = { text: '530 furlongs', value: 531 };
    expect(importProject(f).design.geom.points.ucaOut[0].value).toBe(531);
  });

  it('rejects files that are not project files', () => {
    expect(() => importProject({ hello: 'world' })).toThrow();
  });
});
