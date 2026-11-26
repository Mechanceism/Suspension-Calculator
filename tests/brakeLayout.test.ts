import { describe, expect, it } from 'vitest';
import { brakeSplit, type VehicleInput, type VehicleCorner, type CornerId } from '../src/core/vehicle/vehicle';
import { carProfileDesign } from '../src/app/carProfiles';
import { defaultDesign, type AppState } from '../src/app/store';
import { brakesOf } from '../src/app/optimizer';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';

// Round 5 (6): braking shared between an axle's wheels as the wheels and brakes really do it.
const input = (over: Partial<Record<CornerId, Partial<VehicleCorner>>>, diff: VehicleInput['diff'] = {}): VehicleInput =>
  ({ corners: (['FL', 'FR', 'RL', 'RR'] as CornerId[]).map((id) => ({ id, brake: 'outboard', drive: 'none', abs: false, ...over[id] })), diff, lsdBias: 2.5 } as unknown as VehicleInput);
const loads = { FL: 3000, FR: 1000, RL: 3000, RR: 1000 };

describe('braking split within an axle', () => {
  it('ABS: each wheel up to its own grip (by load)', () => {
    const s = brakeSplit(input({ FL: { abs: true }, FR: { abs: true } }), 'FL', 'FR', loads);
    expect(s[0]).toBeCloseTo(0.75, 9);
  });
  it('a brake on each wheel without ABS: the same force on both (the lighter wheel locks first)', () => {
    expect(brakeSplit(input({}), 'FL', 'FR', loads)).toEqual([0.5, 0.5]);
    // On a driven axle with an open differential: still independent.
    expect(brakeSplit(input({ RL: { drive: 'chassis' }, RR: { drive: 'chassis' } }, { rear: 'open' }), 'RL', 'RR', loads)).toEqual([0.5, 0.5]);
  });
  it('wheels tied by a locked or limited-slip differential: by load (limited-slip within its bias)', () => {
    const driven = { RL: { drive: 'chassis' as const }, RR: { drive: 'chassis' as const } };
    expect(brakeSplit(input(driven, { rear: 'locked' }), 'RL', 'RR', loads)[0]).toBeCloseTo(0.75, 9);
    // 3 : 1 is more than the 2.5 bias: held at 2.5 : 1.
    expect(brakeSplit(input(driven, { rear: 'lsd' }), 'RL', 'RR', loads)[0]).toBeCloseTo(2.5 / 3.5, 9);
  });
  it('one brake through the differential: open — equal; locked — by load', () => {
    const dl = { RL: { brake: 'driveline' as const }, RR: { brake: 'driveline' as const } };
    expect(brakeSplit(input(dl, { rear: 'open' }), 'RL', 'RR', loads)).toEqual([0.5, 0.5]);
    expect(brakeSplit(input(dl, { rear: 'locked' }), 'RL', 'RR', loads)[0]).toBeCloseTo(0.75, 9);
  });
});

describe('one brake through the differential', () => {
  it('the mower and the kart have it on the rear; it counts one rotor for the axle', () => {
    for (const id of ['mower', 'kart']) {
      const d = carProfileDesign(id);
      expect(d.settings.RL.brake).toBe('driveline');
      expect(d.settings.RR.brake).toBe('driveline');
      expect(d.settings.FL.brake).toBe('none');
    }
    const d = { ...defaultDesign() } as unknown as AppState;
    const on = { ...d, brakes: { ...d.brakes, on: true } } as AppState;
    const two = brakesOf(on)!;
    const one = brakesOf({ ...on, settings: { ...on.settings, RL: { ...on.settings.RL, brake: 'driveline' }, RR: { ...on.settings.RR, brake: 'driveline' } } })!;
    expect(one.capacity.axleForce.rear).toBeCloseTo(two.capacity.axleForce.rear / 2, 6);
    expect(one.capacity.axleForce.front).toBeCloseTo(two.capacity.axleForce.front, 6);
  });
  it('saved and opened (format 49)', () => {
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(49);
    const d = carProfileDesign('mower');
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d as never, 'M')))).design;
    expect(back.settings.RL.brake).toBe('driveline');
  });
});

describe('the driver braking over time without ABS', () => {
  it('on rough ground, a brake on each wheel stops the car sooner than one brake through an open differential', async () => {
    const { rideRun, DEFAULT_MF } = await import('../src/core');
    const { SAMPLE_LAYOUTS, SAMPLE_SPRING } = await import('../src/examples/sampleLayouts');
    const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
    const gas = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } } as const;
    const car = (rear: 'outboard' | 'driveline') => ({
      designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } } },
      roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
      // Rear brakes only, no ABS, an open differential: a wheel going light over the rough ground.
      settings: { FL: { brake: 'none', drive: 'none' }, FR: { brake: 'none', drive: 'none' }, RL: { brake: rear, drive: 'chassis', abs: false }, RR: { brake: rear, drive: 'chassis', abs: false } },
      diff: { rear: 'open' },
      mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0, driveSplit: 0, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
      dropLinks: { front: null, rear: null }, droop: 8, bump: 30, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
      steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
      ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 },
      tireGrip: DEFAULT_MF,
    });
    const segs = [{ distance: 40, v0: 14, v1: 3, path: 'straight' as const, radius: 0, grade: 0, bank: 0, road: { rough: { seed: 7, maxHeight: 40, scale: 1.5, coverage: 1 } } }];
    const each = rideRun(car('outboard') as never, { FL: geom }, segs, { handling: true, driverSpeed: true });
    const diff = rideRun(car('driveline') as never, { FL: geom }, segs, { handling: true, driverSpeed: true });
    const end = (r: typeof each) => r.frames.at(-1)!.speed;
    // Both slow down; the open-differential brake loses its braking whenever a rear wheel goes light.
    expect(end(each)).toBeLessThan(14);
    expect(end(each)).toBeLessThan(end(diff) - 0.2);
  }, 120000);
});
