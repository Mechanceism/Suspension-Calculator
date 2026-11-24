/**
 * Tire choice (round 3, R7; docs/MATH.md § Tire choice): try candidate tire sizes on the tests and rank
 * them. Each candidate is the current design with that tire on an axle (or both): its size, a measured
 * .tir approximated at that size (or the generic grip model, rescaled when both axles change), and the
 * unsprung mass changed by the tire + wheel's estimated mass. Candidates that don't fit (bigger than the
 * room allowed, or another rim when rims are fixed) are left out with the reason. Optionally the geometry is
 * re-optimized for each one first (the vehicle optimizer with its goals and free coordinates).
 */
import { create } from 'zustand';
import { useApp, mergedCorners, rootOf, type AppState, type CornerDesign, type Field } from './store';
import { buildVehicleProblem, runVehicleOptimizer, runTestJob } from './optimizer';
import { segmentSpec, rankWeight, type TestDesign } from './tests';
import { POOL_SIZE, runLimited } from './workerPool';
import { parseTireSize, type TireSize } from '../core/tire/size';
import { scaleTir, loadCapacityRatio, sizeChange, tireWheelMass, type TireDims } from '../core/tire/scale';
import { testScore } from '../core/tests/score';
import { CORNER_IDS, type CornerId } from '../core/vehicle/vehicle';
import type { TestRun } from '../core/tests/run';
import type { DoubleWishboneGeometry } from '../core/suspension/doubleWishbone';

export type TireAxleChoice = 'front' | 'rear' | 'both';

/** Common sizes to pick from (road, race / FSAE, off-road). */
export const TIRE_CATALOG: { group: string; sizes: string[] }[] = [
  { group: 'Road', sizes: ['185/65R15', '195/65R15', '205/55R16', '215/55R16', '225/45R17', '235/45R17', '225/40R18', '245/40R18', '255/35R19', '275/35R19'] },
  { group: 'Race / FSAE', sizes: ['16x6.0-10', '18x6.0-10', '18x7.5-10', '20.5x7.0-13', '20x7.5-13', '20.5x8.0-13'] },
  { group: 'Off-road', sizes: ['31x10.50R15', '33x12.50R15', '35x12.50R17', '37x12.50R17', '40x13.50R17'] },
];

export interface TireCandidate { text: string; size: TireSize }

export interface TireRank {
  text: string;
  /** Left out (doesn't fit, can't be read): why. */
  skipped?: string;
  /** How the grip model was made: a .tir approximated (and how far), or generic. */
  model?: string;
  /** Size change from the current tire (largest of width / diameter), and the unsprung mass change per corner (kg). */
  change?: number;
  massChange?: number;
  /** Priority-weighted test score (lower = better) and whether every test passed. */
  score?: number;
  passed?: boolean;
  error?: string;
}

export interface TireChoiceSettings {
  axle: TireAxleChoice;
  /** Most the tire may grow, mm: outer diameter and section width. */
  maxGrowDiameter: number;
  maxGrowWidth: number;
  /** Other rim diameters allowed (the wheels change too). */
  rimsMayChange: boolean;
  /** Re-optimize the geometry for each candidate first (slower). */
  reoptimize: boolean;
}

interface TireChoiceState {
  settings: TireChoiceSettings;
  picked: string[];
  running: boolean;
  progress: string;
  results: TireRank[];
  cancel: (() => void) | null;
}
export const useTireChoice = create<TireChoiceState>(() => ({
  settings: { axle: 'both', maxGrowDiameter: 25, maxGrowWidth: 25, rimsMayChange: false, reoptimize: false },
  picked: [], running: false, progress: '', results: [], cancel: null,
}));

const fld = (v: number): Field => ({ text: String(Number(v.toFixed(2))), value: v });
const dimsOf = (d: CornerDesign): TireDims => ({ outer: d.geom.scalars.tireDiameter.value, width: d.geom.scalars.tireWidth.value, rim: d.geom.scalars.rimDiameter.value });
const sizeDims = (z: TireSize): TireDims => ({ outer: z.outerDiameter, width: z.sectionWidth, rim: z.rimDiameter });
const axleIds = (axle: TireAxleChoice): CornerId[] => CORNER_IDS.filter((id) => axle === 'both' || (axle === 'front') === (id === 'FL' || id === 'FR'));

/** The current tire of an axle (its front corner's design). */
export function currentTire(s: AppState, axle: 'front' | 'rear'): { text: string; dims: TireDims } {
  const d = mergedCorners(s)[rootOf(axle === 'front' ? 'FL' : 'RL', s.links)];
  return { text: d.tireSizeText || '(dimensions)', dims: dimsOf(d) };
}

/** Does the candidate fit where the current tire is (room allowed, rim)? null = fits, else why not. */
export function fitProblem(s: AppState, set: TireChoiceSettings, z: TireSize): string | null {
  for (const a of set.axle === 'both' ? (['front', 'rear'] as const) : [set.axle]) {
    const cur = currentTire(s, a).dims;
    if (!set.rimsMayChange && Math.abs(z.rimDiameter - cur.rim) > 1) return `a ${(z.rimDiameter / 25.4).toFixed(0)}" rim (the ${a} wheels are ${(cur.rim / 25.4).toFixed(0)}"; allow other rims)`;
    if (z.outerDiameter - cur.outer > set.maxGrowDiameter + 1e-6) return `${(z.outerDiameter - cur.outer).toFixed(0)} mm taller than the ${a} tire (room: ${set.maxGrowDiameter} mm)`;
    if (z.sectionWidth - cur.width > set.maxGrowWidth + 1e-6) return `${(z.sectionWidth - cur.width).toFixed(0)} mm wider than the ${a} tire (room: ${set.maxGrowWidth} mm)`;
  }
  return null;
}

/**
 * The design with tire `z` on the axle(s), as a store patch (nothing is changed): sizes, the grip model
 * (a .tir approximated at the size; the generic one rescaled when both axles change) and the unsprung mass.
 */
export function withTire(s: AppState, axle: TireAxleChoice, text: string, z: TireSize): { patch: Partial<AppState>; model: string; change: number; massChange: number } {
  const merged = mergedCorners(s);
  const activeRoot = rootOf(s.activeCorner, s.links);
  const roots = [...new Set(axleIds(axle).map((id) => rootOf(id, s.links)))];
  const corners = { ...s.corners };
  let working: Partial<CornerDesign> = {};
  const to = sizeDims(z);
  let change = 0, massChange = 0;
  for (const root of roots) {
    const d = merged[root];
    const from = dimsOf(d);
    change = Math.max(change, sizeChange(from, to));
    const rimW = d.geom.scalars.rimWidth.value;
    const dm = tireWheelMass(to, rimW > 0 ? rimW : undefined) - tireWheelMass(from, rimW > 0 ? rimW : undefined);
    massChange = dm;
    const d1: CornerDesign = {
      ...d, tireSizeText: text,
      geom: { ...d.geom, scalars: { ...d.geom.scalars, tireDiameter: fld(to.outer), tireWidth: fld(to.width), rimDiameter: fld(to.rim) } },
      spring: { ...d.spring, unsprungMass: fld(Math.max(1, d.spring.unsprungMass.value + dm)) },
    };
    if (root === activeRoot) working = d1; else corners[root] = d1;
  }
  const patch: Partial<AppState> = { corners, ...working };
  // Grip model.
  const front = currentTire(s, 'front').dims, rear = currentTire(s, 'rear').dims;
  let model = 'generic grip model (relative to its nominal load)';
  const rearOwn = s.tireFileRear && s.tireFileRear !== 'simple' ? s.tireFileRear : null;
  if (axle !== 'rear' && s.tireFile) {
    const sc = scaleTir(s.tireFile, front, to, text);
    patch.tireFile = sc.model;
    // The rear keeps what it had (the front's own model unscaled, if it shared it).
    if (axle === 'front' && s.tireFileRear === null) patch.tireFileRear = s.tireFile;
    model = `${s.tireFile.name} approximated (${pct(sc.change)} size change)`;
  }
  if (axle !== 'front') {
    if (rearOwn) { const sc = scaleTir(rearOwn, rear, to, text); patch.tireFileRear = sc.model; model = `${rearOwn.name} approximated (${pct(sc.change)})`; }
    else if (axle === 'rear' && s.tireFile && s.tireFileRear === null) { const sc = scaleTir(s.tireFile, rear, to, text); patch.tireFileRear = sc.model; model = `${s.tireFile.name} approximated (${pct(sc.change)})`; }
  }
  if (!s.tireFile && axle === 'both') {
    // Generic: its nominal load with the load the size carries.
    const k = loadCapacityRatio(front, to);
    patch.tireGrip = { ...s.tireGrip, fz0: fld(s.tireGrip.fz0.value * k) };
    model = 'generic grip model, nominal load rescaled with the size';
  }
  return { patch, model, change, massChange };
}

const pct = (x: number) => `${(x * 100).toFixed(0)} %`;

/** Candidates from the user's text (one per line or comma) and the ticked catalog sizes. */
export function candidatesOf(texts: string[]): { ok: TireCandidate[]; bad: string[] } {
  const ok: TireCandidate[] = [], bad: string[] = [];
  for (const t of [...new Set(texts.map((x) => x.trim()).filter(Boolean))]) {
    const z = parseTireSize(t);
    if (z) ok.push({ text: t, size: z }); else bad.push(t);
  }
  return { ok, bad };
}

/** Rank the candidates on the tests (lower score = better; passing first). */
export async function rankTires(tests: TestDesign[], texts: string[]): Promise<void> {
  const st = useTireChoice.getState();
  if (st.running || !tests.length) return;
  const set = st.settings;
  const s0 = useApp.getState() as AppState;
  const { ok, bad } = candidatesOf(texts);
  const results: TireRank[] = bad.map((t) => ({ text: t, skipped: 'not a tire size (225/45R17, 31x10.50R15, 20.5x7.0-13…)' }));
  const todo: { c: TireCandidate; r: TireRank; state: AppState }[] = [];
  // The current tire as the reference.
  const cur = currentTire(s0, set.axle === 'rear' ? 'rear' : 'front');
  todo.push({ c: { text: `${cur.text} (now)`, size: { format: 'metric', outerDiameter: cur.dims.outer, sectionWidth: cur.dims.width, rimDiameter: cur.dims.rim, sidewallHeight: (cur.dims.outer - cur.dims.rim) / 2 } }, r: { text: `${cur.text} (now)`, model: 'as it is', change: 0, massChange: 0 }, state: s0 });
  for (const c of ok) {
    const why = fitProblem(s0, set, c.size);
    if (why) { results.push({ text: c.text, skipped: `doesn't fit: ${why}` }); continue; }
    const w = withTire(s0, set.axle, c.text, c.size);
    todo.push({ c, r: { text: c.text, model: w.model, change: w.change, massChange: w.massChange }, state: { ...s0, ...w.patch } as AppState });
  }
  let stopped = false;
  const cancels = new Set<() => void>();
  useTireChoice.setState({ running: true, results: [], progress: `0 of ${todo.length}`, cancel: () => { stopped = true; for (const c of cancels) c(); } });
  const w = (t: TestDesign) => (tests.length > 1 ? rankWeight(t.rank, tests.length) : 1);
  const tw = tests.reduce((a, t) => a + w(t), 0) || 1;
  let done = 0;
  try {
    // Re-optimizing uses every core per candidate: one candidate at a time then; else several at once.
    await runLimited(todo, set.reoptimize ? 1 : Math.max(1, Math.floor(POOL_SIZE / Math.max(1, tests.length))), async ({ r, state }) => {
      try {
        const built = buildVehicleProblem(state, { caseSource: tests.length > 1 ? 'all' : tests[0]!.id });
        let problem = built.problem;
        if (set.reoptimize && problem.variables.length && problem.goals.length && !built.blockers.length) {
          const h = runVehicleOptimizer({ ...problem, maxIterations: 20 }, () => {});
          cancels.add(h.stop);
          const { result } = await h.done;
          cancels.delete(h.stop);
          const g = result.geometries as Partial<Record<CornerId, DoubleWishboneGeometry>>;
          problem = { ...problem, designs: Object.fromEntries(Object.entries(problem.designs).map(([k, d]) => [k, { ...d!, geometry: g[k as CornerId] ?? d!.geometry }])) };
        }
        const runs = await runLimited(tests, tests.length, async (t) => {
          const job = runTestJob(problem, t.segments.map((sg) => segmentSpec(sg, t)), { onFail: t.onFail, speedLimits: false, ride: t.ride !== false, handling: t.ride !== false && t.handling !== false, driverSpeed: !!t.driverSpeed });
          let stop = () => {};
          const cancelled = new Promise<null>((res) => { stop = () => { job.cancel(); res(null); }; });
          cancels.add(stop);
          try { return await Promise.race([job.done, cancelled]); } finally { cancels.delete(stop); }
        }, () => stopped);
        if (runs.some((x) => !x)) return;
        const rs = runs as TestRun[];
        r.score = tests.reduce((a, t, i) => a + w(t) * testScore(rs[i]!, 'improve'), 0) / tw;
        r.passed = rs.every((x) => x.passed);
      } catch (e) {
        r.error = e instanceof Error ? e.message : String(e);
      } finally {
        done++;
        useTireChoice.setState({ progress: `${done} of ${todo.length}` });
      }
    }, () => stopped);
  } finally {
    const ranked = todo.map((t) => t.r).sort((a, b) => Number(!!b.passed) - Number(!!a.passed) || (a.score ?? Infinity) - (b.score ?? Infinity));
    useTireChoice.setState({ running: false, cancel: null, results: [...ranked, ...results] });
  }
}

/** Put a candidate on the car (one undo step). */
export function applyTire(text: string): boolean {
  const z = parseTireSize(text);
  if (!z) return false;
  const s = useApp.getState() as AppState;
  useApp.setState(withTire(s, useTireChoice.getState().settings.axle, text, z).patch);
  return true;
}
