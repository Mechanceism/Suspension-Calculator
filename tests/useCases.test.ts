import { describe, expect, it } from 'vitest';
import { USE_CASES, withUseCase } from '../src/app/useCases';
import { defaultDesign, SETUP_STEPS, type AppState } from '../src/app/store';
import { carProfileDesign } from '../src/app/carProfiles';
import { serializeProject, importProject } from '../src/app/project';
import { TEST_PRESETS, segmentSpec, planOption, driverSpeedOf } from '../src/app/tests';
import { buildVehicleProblem } from '../src/app/optimizer';
import { runTest } from '../src/core';

// Round 4 (F20): what the car is for sets the tests, their pass rules and what the optimizer counts.
describe('use cases', () => {
  it('six of them; the setup wizard asks first', () => {
    expect(USE_CASES.map((u) => u.id)).toEqual(['track', 'road', 'offroad', 'drift', 'towing', 'drag']);
    expect(SETUP_STEPS[0]).toBe('use');
  });

  it('applying one adds its tests (turned on, with its pass rules), turns the others off, sets the goals; saved with the design', () => {
    const d = defaultDesign();
    const track = withUseCase(d, 'track');
    expect(track.tests.filter((t) => t.enabled).map((t) => t.name).sort()).toEqual(['Autocross (complex)', 'Autocross (simple)', 'Balanced']);
    expect(track.tests.every((t) => t.speedMode === 'grip' && t.profile === 'track')).toBe(true);
    expect(track.vehicleOptimizer.goals.testTime.on).toBe(true);
    expect(track.vehicleOptimizer.goals.testTime.weight.value).toBe(1);
    // Then road: Balanced is kept (now at its set speeds, street rules), the autocrosses turned off, not deleted.
    const road = withUseCase({ ...d, ...track }, 'road');
    expect(road.tests.length).toBe(5);
    expect(road.tests.filter((t) => t.enabled).map((t) => t.name).sort()).toEqual(['Balanced', 'Hills', 'Pothole while braking in a turn']);
    expect(road.tests.find((t) => t.name === 'Balanced')!.speedMode).toBe('max');
    expect(road.tests.find((t) => t.name === 'Autocross (simple)')!.enabled).toBe(false);
    expect(road.vehicleOptimizer.goals.steeringEffort.on).toBe(true);
    expect(road.vehicleOptimizer.goals.testTime.weight.value).toBe(0.25);
    expect(withUseCase(d, 'towing').tow.on).toBe(true);
    const drag = withUseCase(d, 'drag');
    expect(drag.tests.map((t) => t.name)).toEqual(['Drag strip']);
    expect(drag.tests[0]!.checks.wheelLift.severity).toBe('pass');
    const back = importProject(JSON.parse(JSON.stringify(serializeProject({ ...d, ...drag }, 'U')))).design;
    expect(back.useCase).toBe('drag');
  });

  it('the drag strip: a quarter mile from standing, the FSAE car within its engine', () => {
    const d = carProfileDesign('fsae');
    const p = buildVehicleProblem(d as unknown as AppState).problem;
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, x]) => [r, x!.geometry]));
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Drag strip'))!.make(), id: 'd' };
    const run = runTest(p, geoms, t.segments.map((s) => segmentSpec(s, t)), { onFail: 'report', ride: true, handling: true, driverSpeed: driverSpeedOf(t), ...planOption(t) });
    expect(run.distance).toBeCloseTo(402.3, 1);
    // ≈ 60 kW on 300 kg, one gear topping out ≈ 100 km/h: a quarter mile in roughly 14–25 s.
    expect(run.time!).toBeGreaterThan(12);
    expect(run.time!).toBeLessThan(30);
  }, 240000);
});
