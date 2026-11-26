import { describe, expect, it } from 'vitest';
import { motorTorque, wheelDrive, topSpeed, rpmTopSpeed, type Powertrain } from '../src/core/vehicle/powertrain';
import { planSpeeds, type PlanCar } from '../src/core/tests/plan';
import { G, type SegmentSpec } from '../src/core/tests/segments';
import { runTest } from '../src/core';
import type { AppState } from '../src/app/store';
import { defaultDesign } from '../src/app/store';
import { carProfileDesign } from '../src/app/carProfiles';
import { buildVehicleProblem, powertrainOf } from '../src/app/optimizer';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';
import { TEST_PRESETS, segmentSpec, planOption } from '../src/app/tests';

const w = (rpm: number) => (rpm * 2 * Math.PI) / 60;

// Round 4 (F5): the powertrain through one gear limits the drive at each speed; with it Grip only has no top-speed cap.
describe('powertrain', () => {
  it('electric: full torque up to its base speed, then constant power, nothing past its most rpm', () => {
    const e: Powertrain = { kind: 'electric', peakTorque: 300, peakPower: 150, maxRpm: 14000, ratio: 9, efficiency: 0.9 };
    const base = (150000 / 300) * (60 / (2 * Math.PI)); // ≈ 4775 rpm
    expect(motorTorque(e, 0)).toBe(300);
    expect(motorTorque(e, base * 0.9)).toBeCloseTo(300, 9);
    expect(motorTorque(e, 10000) * w(10000)).toBeCloseTo(150000, 6);
    expect(motorTorque(e, 14001)).toBe(0);
    // At the wheels: torque · ratio · efficiency ÷ radius.
    expect(wheelDrive(e, 1, 0.3).force).toBeCloseTo((300 * 9 * 0.9) / 0.3, 6);
  });

  it('gas: the peak torque at its rpm, the peak power at its rpm, 95 % at the redline; the clutch slips below its rpm', () => {
    const g: Powertrain = { kind: 'gas', peakTorque: 160, peakPower: 90, maxRpm: 6500, torqueRpm: 4000, powerRpm: 6000, idleRpm: 800, clutchRpm: 2000, ratio: 7.5, efficiency: 0.9 };
    expect(motorTorque(g, 4000)).toBeCloseTo(160, 9);
    expect(motorTorque(g, 6000) * w(6000) / 1000).toBeCloseTo(90, 6);
    expect(motorTorque(g, 6500) * w(6500) / 1000).toBeCloseTo(0.95 * 90, 6);
    expect(motorTorque(g, 800)).toBeCloseTo(0.7 * 160, 9);
    for (let r = 800; r < 6500; r += 100) expect(motorTorque(g, r)).toBeLessThanOrEqual(160 + 1e-9);
    // From standstill the clutch holds the engine at its rpm and its torque there pulls the car.
    const launch = wheelDrive(g, 0, 0.3);
    expect(launch.clutchSlip).toBe(true);
    expect(launch.rpm).toBe(2000);
    expect(launch.force).toBeCloseTo((motorTorque(g, 2000) * 7.5 * 0.9) / 0.3, 6);
    // Past the redline: the limiter.
    expect(wheelDrive(g, rpmTopSpeed(g, 0.3) * 1.01, 0.3).force).toBe(0);
    // The top speed: the redline, or where the drag and rolling resistance take all the push.
    expect(topSpeed(g, 0.3, 0, 100).by).toBe('rpm');
    const slow = topSpeed(g, 0.3, 5, 100);
    expect(slow.by).toBe('drag');
    expect(wheelDrive(g, slow.v, 0.3).force).toBeCloseTo(5 * slow.v ** 2 + 100, 0);
  });

  it('the planner: the push within the powertrain at each speed; Grip only with a powertrain has no top-speed cap', () => {
    const car: PlanCar = {
      muFront: 1, muRear: 1, frontShare: 0.5, cgHeight: 500, wheelbase: 2500, track: 1500, brakeBias: 0.65, driveSplit: 0,
      brakesFront: true, brakesRear: true, drivenFront: false, drivenRear: true, mass: 1000, rollingResistance: 0.01,
    };
    const segs: SegmentSpec[] = [{ distance: 5000, v0: 0, v1: 20, path: 'straight', radius: 0, grade: 0, bank: 0 }];
    const pt: Powertrain = { kind: 'electric', peakTorque: 200, peakPower: 60, maxRpm: 20000, ratio: 8, efficiency: 1 };
    const drive = (v: number) => wheelDrive(pt, v, 0.3).force;
    const free = planSpeeds(segs, { ...car, drive, dragArea: 0.4 }, [0.95], [], { gripOnly: { topSpeed: 20 } });
    const top = topSpeed(pt, 0.3, 0.4, 0.01 * 1000 * G);
    const vmax = Math.max(...free.plans[0]!.v);
    expect(vmax).toBeGreaterThan(20 + 5); // the 20 m/s top speed doesn't cap it…
    expect(vmax).toBeLessThanOrEqual(top.v + 0.05); // …the power and the drag do
    expect(vmax).toBeGreaterThan(top.v - 1.5);
    // Slower off the line than the tires alone allow (rear-drive traction ≈ 0.4 g here; the motor ≈ 0.54 g at
    // first, then less as the power runs out): never faster than without the powertrain.
    const tires = planSpeeds(segs, { ...car, dragArea: 0.4 }, [0.95], [], { gripOnly: { topSpeed: vmax } });
    for (let k = 0; k < tires.plans[0]!.v.length; k++) expect(free.plans[0]!.v[k]!).toBeLessThanOrEqual(tires.plans[0]!.v[k]! + 1e-6);
  });

  it('saved with the project (format 45); older files have none; the car profiles come with an engine', () => {
    const d = carProfileDesign('kart');
    expect(d.powertrain.kind).toBe('gas');
    expect(powertrainOf(d)!.ratio).toBeCloseTo(60 / 18, 2);
    expect(defaultDesign().powertrain.kind).toBe('none');
    expect(buildVehicleProblem(defaultDesign() as unknown as AppState).problem.powertrain).toBeUndefined();
    const file = JSON.parse(JSON.stringify(serializeProject(d, 'K')));
    expect(file.formatVersion).toBe(FORMAT_VERSION);
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(45);
    const back = importProject(file).design;
    expect(back.powertrain).toEqual(d.powertrain);
    delete file.powertrain;
    file.formatVersion = 44;
    const old = importProject(file);
    expect(old.design.powertrain.kind).toBe('none');
    expect(old.warnings).toEqual(['Upgraded from file format 44 to 45.', 'Upgraded from file format 45 to 46.', 'Upgraded from file format 46 to 47.', 'Upgraded from file format 47 to 48.', 'Upgraded from file format 48 to 49.', 'Upgraded from file format 49 to 50.', 'Upgraded from file format 50 to 51.']);
  });

  it('the kart on Balanced, grip only: never past its redline speed, and its gearing limits the straights', () => {
    const d = carProfileDesign('kart');
    const p = buildVehicleProblem(d as unknown as AppState).problem;
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, x]) => [r, x!.geometry]));
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Balanced'))!.make(), id: 'b' };
    const specs = t.segments.map((s) => segmentSpec(s, t));
    const run = runTest(p, geoms, specs, { onFail: 'report', ...planOption(t, false) });
    const vmax = Math.max(...run.segments.flatMap((s) => s.plan?.v ?? [0]));
    const radius = 0.279 / 2 * 0.97; // about the rear tire's loaded radius
    expect(vmax).toBeLessThanOrEqual(rpmTopSpeed(powertrainOf(d)!, radius) * 1.05);
    expect(vmax).toBeGreaterThan(10);
  }, 240000);
});
