import { describe, it, expect } from 'vitest';
import { serializeProject, importProject, designSnapshot, FORMAT_VERSION, APP_VERSION } from '../src/app/project';
import { defaultDesign, type DesignState } from '../src/app/store';

const roundTrip = (d: DesignState) => importProject(JSON.parse(JSON.stringify(serializeProject(d, 'Test car'))));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('project files', () => {
  it('records the format and app version, and names parameters per corner', () => {
    const f = serializeProject(defaultDesign(), 'Test car');
    expect(f.formatVersion).toBe(FORMAT_VERSION);
    expect(f.appVersion).toBe(APP_VERSION);
    expect(f.corners.FL.points.FL_UCA_Fwd).toBeDefined();
    expect(f.corners.RR.points.RR_UCA_Fwd).toBeDefined();
    expect(f.corners.RR.scalars.RR_Whl_Camber).toBeDefined();
  });

  it('round-trips a design exactly, keeping the typed units', () => {
    const d = defaultDesign();
    d.geom.points.ucaOut = [{ text: '21in', value: 533.4 }, d.geom.points.ucaOut[1], d.geom.points.ucaOut[2]];
    d.spring.cornerLoad = { text: '200lbf', value: 889.6443216 };
    d.geom.damperArm = 'uca';
    d.tireModel = 'stiffness';
    d.droop = 70;
    const r = roundTrip(d);
    expect(r.warnings).toEqual([]);
    expect(r.name).toBe('Test car');
    expect(r.design.geom.points.ucaOut[0]).toEqual({ text: '21in', value: 533.4 });
    expect(r.design.corners.RR.geom.points.ucaOut[0].value).toBe(533.4); // linked corners share it
    expect(r.design.spring.cornerLoad.text).toBe('200lbf');
    expect(r.design.geom.damperArm).toBe('uca');
    expect(r.design.tireModel).toBe('stiffness');
    expect(r.design.droop).toBe(70);
    expect(designSnapshot(r.design)).toBe(designSnapshot(d));
  });

  it('round-trips links, corner settings and vehicle inputs', () => {
    const d = defaultDesign();
    d.links = { frontPair: false, rearPair: true, rearFromFront: false };
    d.settings = { ...d.settings, RL: { steered: true, powered: true, brake: 'inboard', drive: 'hub' } };
    d.shared = { ...d.shared, front: { ...d.shared.front, antiRollBar: 'torsionBar', barRate: { text: '200', value: 200 } } };
    d.vehicle = { ...d.vehicle, cgY: { text: '11in', value: 279.4 } };
    d.corners = { ...d.corners, FR: { ...d.corners.FR, bumpStop: false } };
    const r = roundTrip(d);
    expect(r.design.links).toEqual(d.links);
    expect(r.design.settings.RL).toEqual({ steered: true, powered: true, brake: 'inboard', drive: 'hub' });
    expect(r.design.shared.front.antiRollBar).toBe('torsionBar');
    expect(r.design.shared.front.barRate.value).toBe(200);
    expect(r.design.shared.rear.antiRollBar).toBe('none');
    expect(r.design.vehicle.cgY.text).toBe('11in');
    expect(r.design.corners.FR.bumpStop).toBe(false);
  });

  it('fills missing values with defaults and reports them', () => {
    const f = clone(serializeProject(defaultDesign(), 'Old')) as Record<string, any>;
    delete f.corners.FL.points.FL_Dmp_Arm;
    delete f.corners.FL.spring.unsprungMass;
    const r = importProject(f);
    expect(r.design.geom.points.dmpArm[0].value).toBe(defaultDesign().geom.points.dmpArm[0].value);
    expect(r.warnings.some((w) => w.includes('FL_Dmp_Arm'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('FL.spring.unsprungMass'))).toBe(true);
  });

  it('opens format-1 (single corner) files: the corner becomes all four, linked', () => {
    const v1 = {
      format: 'suspension-calculator-project', formatVersion: 1, appVersion: '0.2.0', name: 'Old car',
      corner: {
        id: 'FL', type: 'doubleWishbone', damperArm: 'lca',
        points: { FL_UCA_Out: { x: { text: '21in', value: 533.4 }, y: { text: '320', value: 320 }, z: { text: '0', value: 0 } } },
        scalars: { FL_Whl_Camber: { text: '-1.5', value: -1.5 } },
      },
      spring: { springRate: { text: '70', value: 70 } },
      damper: { fields: {}, bumpStop: false },
      steering: {},
      tire: { model: 'stiffness', volumeChange: true, sizeText: '', fields: {} },
      motion: { droop: 60, bump: 55, driver: 'wheelCenter' },
    };
    const r = importProject(v1);
    expect(r.warnings.some((w) => w.includes('Upgraded from file format 1 to 2'))).toBe(true);
    for (const id of ['FL', 'FR', 'RL', 'RR'] as const) {
      expect(r.design.corners[id].geom.points.ucaOut[0].value).toBe(533.4);
      expect(r.design.corners[id].geom.scalars.staticCamber.value).toBe(-1.5);
      expect(r.design.corners[id].spring.springRate.value).toBe(70);
      expect(r.design.corners[id].bumpStop).toBe(false);
      expect(r.design.corners[id].tireModel).toBe('stiffness');
    }
    expect(r.design.links).toEqual({ frontPair: true, rearPair: true, rearFromFront: true });
    expect(r.design.settings.RL.steered).toBe(false);
    expect(r.design.droop).toBe(60);
    expect(r.name).toBe('Old car');
  });

  it('warns about files from a newer version and ignores unknown values', () => {
    const f = clone(serializeProject(defaultDesign(), 'Future')) as Record<string, any>;
    f.formatVersion = FORMAT_VERSION + 1;
    f.steering.someFutureSetting = { text: '3', value: 3 };
    const r = importProject(f);
    expect(r.warnings.some((w) => w.includes('newer version'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('someFutureSetting'))).toBe(true);
  });

  it('falls back to the stored number when the text no longer parses', () => {
    const f = clone(serializeProject(defaultDesign(), 'X')) as Record<string, any>;
    f.corners.FL.points.FL_UCA_Out.x = { text: '530 furlongs', value: 531 };
    expect(importProject(f).design.geom.points.ucaOut[0].value).toBe(531);
  });

  it('rejects files that are not project files', () => {
    expect(() => importProject({ hello: 'world' })).toThrow();
  });
});
