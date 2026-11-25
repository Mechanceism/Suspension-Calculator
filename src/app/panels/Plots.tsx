import { deg } from '../../core/suspension/characteristics';
import { useDisplay, toDisplay, digitsFor } from '../units';
import type { Model, Sample, SteerSample } from '../useModel';
import { Section } from './FieldRows';
import { useApp } from '../store';

const W = 300;
const H = 120;
const PAD = { l: 44, r: 8, t: 10, b: 22 };

function niceRange(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
  if (hi - lo < 1e-6) { const m = Math.max(Math.abs(lo) * 0.1, 0.05); return [lo - m, hi + m]; }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

function Chart({ title, unit: baseUnit, data: raw, current: rawCurrent, digits: baseDigits = 2, xUnit: baseX = 'mm', other: rawOther }: {
  title: string; unit: string; data: { x: number; y: number }[]; current: { x: number; y: number } | null; digits?: number; xUnit?: string;
  /** Compare: the other design's curve, drawn dashed over this one (both in the same scale). */
  other?: { x: number; y: number }[];
}) {
  // Display units (Units menu): convert both axes.
  const disp = useDisplay();
  const cy = disp.conv(baseUnit);
  const cx = disp.conv(baseX);
  const unit = cy.unit;
  const xUnit = cx.unit;
  const digits = digitsFor(baseDigits, cy);
  const data = raw.map((d) => ({ x: toDisplay(d.x, cx), y: toDisplay(d.y, cy) }));
  const current = rawCurrent ? { x: toDisplay(rawCurrent.x, cx), y: toDisplay(rawCurrent.y, cy) } : null;
  const pts = data.filter((d) => Number.isFinite(d.y));
  const opts = (rawOther ?? []).map((d) => ({ x: toDisplay(d.x, cx), y: toDisplay(d.y, cy) })).filter((d) => Number.isFinite(d.y));
  if (pts.length < 2 && opts.length < 2) return null;
  const xs = [...pts, ...opts].map((d) => d.x);
  const ys = [...pts, ...opts].map((d) => d.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = niceRange(Math.min(...ys), Math.max(...ys));
  const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (y: number) => H - PAD.b - ((y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
  const line = (ps: { x: number; y: number }[]) => ps.map((d, i) => `${i ? 'L' : 'M'}${sx(d.x).toFixed(1)},${sy(d.y).toFixed(1)}`).join('');
  const path = line(pts);
  const zeroY = y0 < 0 && y1 > 0 ? sy(0) : null;
  return (
    <figure className="chart">
      <figcaption>
        {title} <span className="muted">({unit})</span>
        {current && Number.isFinite(current.y) && <b className="chart-value">{current.y.toFixed(digits)}</b>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} vs travel`}>
        <line className="axis" x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} />
        {zeroY !== null && <line className="zero" x1={PAD.l} x2={W - PAD.r} y1={zeroY} y2={zeroY} />}
        <line className="zero" x1={sx(0)} x2={sx(0)} y1={PAD.t} y2={H - PAD.b} />
        <text className="tick" x={PAD.l - 4} y={sy(y1) + 4} textAnchor="end">{y1.toFixed(digits)}</text>
        <text className="tick" x={PAD.l - 4} y={sy(y0)} textAnchor="end">{y0.toFixed(digits)}</text>
        <text className="tick" x={PAD.l} y={H - 6} textAnchor="start">{x0.toFixed(digitsFor(0, cx))}</text>
        <text className="tick" x={W - PAD.r} y={H - 6} textAnchor="end">{x1.toFixed(digitsFor(0, cx))} {xUnit}</text>
        {pts.length > 1 && <path className="series" d={path} />}
        {opts.length > 1 && <path className="series other" d={line(opts)} />}
        {current && Number.isFinite(current.y) && (
          <>
            <line className="cursor" x1={sx(current.x)} x2={sx(current.x)} y1={PAD.t} y2={H - PAD.b} />
            <circle className="dot" cx={sx(current.x)} cy={sy(current.y)} r={3.5} />
          </>
        )}
      </svg>
    </figure>
  );
}

type Getter = (s: Sample) => number;

/** `other` (Compare): the snapshot's corner, its curves drawn dashed over the current design's. */
export function Plots({ model, other }: { model: Model; other?: Model }) {
  // The current travel from the model given (during a play, its snapshot), not the store: the plots needn't redraw every step.
  const cur = model.current;
  const travel = cur?.travel ?? 0;
  const base = model.sweep.reduce<Sample | null>((b, q) => (!b || Math.abs(q.travel) < Math.abs(b.travel) ? q : b), null);
  const baseTrack = base?.chars.halfTrack ?? 0;
  const otherBase = other?.sweep.reduce<Sample | null>((b, q) => (!b || Math.abs(q.travel) < Math.abs(b.travel) ? q : b), null);
  // Half-track change is from each design's own static half track.
  const otherOf = (get: Getter, title: string) => other?.sweep.map((q) => ({ x: q.travel, y: title === 'Half track change' ? q.chars.halfTrack - (otherBase?.chars.halfTrack ?? 0) : get(q) }));
  const series: { title: string; unit: string; get: Getter; digits?: number }[] = [
    { title: 'Camber', unit: '°', get: (s) => deg(s.chars.camber), digits: 3 },
    { title: 'Toe (bump steer)', unit: '°', get: (s) => deg(s.chars.toe), digits: 3 },
    { title: 'Roll center height', unit: 'mm', get: (s) => s.chars.rollCenterHeight ?? NaN, digits: 1 },
    { title: 'Half track change', unit: 'mm', get: (s) => s.chars.halfTrack - baseTrack, digits: 2 },
    { title: 'Caster', unit: '°', get: (s) => deg(s.chars.caster), digits: 2 },
    { title: 'KPI', unit: '°', get: (s) => deg(s.chars.kpi), digits: 2 },
    { title: 'Mechanical trail', unit: 'mm', get: (s) => s.chars.mechanicalTrail, digits: 1 },
    { title: 'Scrub radius', unit: 'mm', get: (s) => s.chars.scrubRadius, digits: 1 },
  ];
  if (model.sweep.some((s) => s.spring)) {
    series.push(
      { title: 'Motion ratio', unit: 'spring/wheel', get: (s) => s.spring?.motionRatio ?? NaN, digits: 3 },
      { title: 'Wheel rate', unit: 'N/mm', get: (s) => s.spring?.wheelRate ?? NaN, digits: 1 },
    );
  }
  if (cur?.loaded) {
    series.splice(1, 0,
      { title: 'Contact patch area (static load)', unit: 'cm²', get: (s) => (s.loaded ? s.loaded.patch.area / 100 : NaN), digits: 1 },
      { title: 'Patch centroid offset from wheel plane (static load)', unit: 'mm', get: (s) => (s.loaded ? s.loaded.patch.centroidS : NaN), digits: 1 },
    );
    series.push({ title: 'Effective scrub radius', unit: 'mm', get: (s) => (s.loaded ? s.loaded.effectiveScrubRadius : NaN), digits: 1 });
  }
  const curTravel = cur?.travel ?? travel;
  const sw = cur?.steering?.steeringWheelAngle ?? 0;
  const steerSeries: { title: string; unit: string; get: (s: SteerSample) => number; digits?: number; now?: number }[] = [
    { title: 'Road-wheel angle', unit: '°', get: (s) => deg(s.roadWheelAngle), digits: 2, now: cur?.steering ? deg(cur.steering.roadWheelAngle) : undefined },
    { title: 'Camber vs steer', unit: '°', get: (s) => deg(s.camber), digits: 3 },
    { title: 'Ackermann (with the mirrored corner)', unit: '%', get: (s) => s.ackermann, digits: 0 },
    { title: 'Steering jacking (body rise)', unit: 'mm', get: (s) => s.jacking, digits: 2 },
    { title: 'Self-centering wheel torque (vertical load)', unit: 'N·m', get: (s) => s.centeringTorque, digits: 2 },
  ];
  const nearestSteer = (x: number) => model.steerSweep.reduce<SteerSample | null>((b, q) => (!b || Math.abs(q.steeringWheelAngle - x) < Math.abs(b.steeringWheelAngle - x) ? q : b), null);
  const ns = nearestSteer(sw);
  return (
    <section className="panel">
      <h2>Curves{other && <span className="muted small-text"> — current · <span className="dash-key">- - -</span> snapshot</span>}</h2>
      <Section title="Through travel">
        {series.map((s) => (
          <Chart
            key={s.title} title={s.title} unit={s.unit} digits={s.digits}
            data={model.sweep.map((q) => ({ x: q.travel, y: s.get(q) }))}
            current={cur ? { x: curTravel, y: s.get(cur) } : null}
            other={otherOf(s.get, s.title)}
          />
        ))}
      </Section>
      {model.steerSweep.length > 1 && (
        <Section title="Through steering (at current travel)">
          {steerSeries.map((s) => (
            <Chart
              key={s.title} title={s.title} unit={s.unit} digits={s.digits} xUnit="° sw"
              data={model.steerSweep.map((q) => ({ x: q.steeringWheelAngle, y: s.get(q) }))}
              other={other?.steerSweep.map((q) => ({ x: q.steeringWheelAngle, y: s.get(q) }))}
              current={ns ? { x: sw, y: s.now ?? s.get(ns) } : null}
            />
          ))}
        </Section>
      )}
    </section>
  );
}
