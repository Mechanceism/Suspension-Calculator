/**
 * Fit a tire model to measured data: load a table (CSV / tab-separated, e.g. TTC runs exported as text),
 * fit the Magic Formula 6.1 force coefficients in the worker, check the fit (error, R², data vs model),
 * then use it for both axles / the front / the rear, or download it as a .tir file.
 */
import { useRef, useState } from 'react';
import { create } from 'zustand';
import { parseTireTable, writeTir, type TireCsv, type TireFitResult } from '../../core/tire/fit';
import { tirFy0, tirFx0 } from '../../core/tire/tir';
import { useApp, type TireAxle } from '../store';
import { runTireFitJob } from '../optimizer';
import { download } from '../fileActions';
import { fmt } from './FieldRows';

interface FitState { name: string; csv: TireCsv | null; running: boolean; progress: string; result: TireFitResult | null; error: string | null; stop: (() => void) | null }
const useFit = create<FitState>(() => ({ name: '', csv: null, running: false, progress: '', result: null, error: null, stop: null }));

const W = 280, H = 140, PAD = 14;

/** Measured side force vs slip angle near the nominal load (level wheel), with the fitted curve. */
function FitPlot({ csv, r }: { csv: TireCsv; r: TireFitResult }) {
  const m = r.model;
  const lat = !!r.lateral;
  const rows = csv.samples.filter((s) => (lat ? s.fy !== undefined && Math.abs(s.sl) < 0.02 : s.fx !== undefined && Math.abs(s.sa) < 0.01)
    && Math.abs(s.fz - m.fnomin) < 0.15 * m.fnomin && Math.abs(s.ia) < 0.01);
  const pts = rows.filter((_, i) => i % Math.max(1, Math.ceil(rows.length / 600)) === 0);
  if (!pts.length) return null;
  const xOf = (s: (typeof pts)[number]) => (lat ? s.sa : s.sl);
  const yOf = (s: (typeof pts)[number]) => (lat ? s.fy! : s.fx!);
  const xMax = Math.max(...pts.map((s) => Math.abs(xOf(s)))) || 1;
  const curve = Array.from({ length: 81 }, (_, i) => -xMax + (2 * xMax * i) / 80).map((x) => [x, lat ? tirFy0(m, { fz: m.fnomin, kappa: 0, alpha: x, gamma: 0 }).fy : tirFx0(m, { fz: m.fnomin, kappa: x, alpha: 0, gamma: 0 }).fx] as const);
  const yMax = Math.max(...pts.map((s) => Math.abs(yOf(s))), ...curve.map((c) => Math.abs(c[1]))) || 1;
  const px = (x: number) => W / 2 + (x / xMax) * (W / 2 - PAD);
  const py = (y: number) => H / 2 - (y / yMax) * (H / 2 - PAD);
  return (
    <svg className="tire-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Measured vs fitted">
      <line x1={PAD} x2={W - PAD} y1={H / 2} y2={H / 2} className="grid-line" />
      <line x1={W / 2} x2={W / 2} y1={PAD / 2} y2={H - PAD / 2} className="grid-line" />
      {pts.map((s, i) => <circle key={i} cx={px(xOf(s))} cy={py(yOf(s))} r={1.2} fill="#7fd1c7" opacity={0.6} />)}
      <polyline points={curve.map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(' ')} fill="none" stroke="#ffd166" strokeWidth={1.6} />
      <text x={PAD} y={H - 3} className="axis-text">{lat ? `slip angle ±${fmt((xMax * 180) / Math.PI, 0)}°` : `slip ratio ±${fmt(xMax, 2)}`}</text>
      <text x={W - PAD} y={PAD} className="axis-text" textAnchor="end">{lat ? 'Fy' : 'Fx'} ±{fmt(yMax, 0)} N · near {fmt(m.fnomin, 0)} N, level</text>
    </svg>
  );
}

export function TireFit() {
  const st = useFit();
  const input = useRef<HTMLInputElement>(null);
  const [angles, setAngles] = useState<'deg' | 'rad'>('deg');
  const [text, setText] = useState<string | null>(null);
  const load = async (f: File) => {
    const t = await f.text();
    setText(t);
    useFit.setState({ name: f.name.replace(/\.[^.]+$/, ''), csv: parseTireTable(t, angles), result: null, error: null });
  };
  const fit = () => {
    if (!st.csv?.samples.length) return;
    const R0 = useApp.getState().geom.scalars.tireDiameter.value / 2 / 1000; // the design's tire, m (aligning moment)
    const job = runTireFitJob(st.csv.samples, `${st.name} (fitted).tir`, (p) => useFit.setState({ progress: `${p.stage}, iteration ${p.iteration}` }), R0 > 0 ? R0 : undefined);
    useFit.setState({ running: true, progress: 'starting…', error: null, result: null, stop: job.stop });
    job.done
      .then((result) => useFit.setState({ running: false, result, stop: null }))
      .catch((e: unknown) => useFit.setState({ running: false, stop: null, error: e instanceof Error && e.message === 'stopped' ? null : e instanceof Error ? e.message : String(e) }));
  };
  const use = (axle: TireAxle) => {
    if (!st.result) return;
    useApp.getState().setTireFile(st.result.model, axle);
    useApp.getState().notify(`Using the fitted tire model for ${axle === 'both' ? 'all four tires' : `the ${axle} tires`}.`);
  };
  const r = st.result;
  const csv = st.csv;
  const q = (x: TireFitResult['lateral'], what: string) => (x ? `${what}: ${x.rows} rows, error ${fmt(x.rmsN, 0)} N RMS, R² ${fmt(x.r2, 3)}` : `${what}: not fitted`);
  return (
    <details className="tire-advanced tire-fit">
      <summary>Fit a tire model to measured data</summary>
      <p className="hint">
        A table of measurements, one row each: slip angle <b>SA</b>, slip ratio <b>SL</b>, load <b>FZ</b>, inclination <b>IA</b>, pressure <b>P</b>, forces <b>FX</b> / <b>FY</b>, and optionally the aligning moment <b>MZ</b> (N·m)
        (CSV or tab-separated, a header row naming the columns; a units row under it is understood). Rows with slip ratio near 0 fit the cornering
        coefficients, rows with slip angle near 0 the braking / driving ones, rows with both the combined-slip ones, and MZ the aligning moment (with the design's tire radius). Your data stays on this computer.
      </p>
      <div className="jm-row">
        <button className="chip" onClick={() => input.current?.click()}>Load data</button>
        <span className="muted small-text">Angles</span>
        <select value={angles} onChange={(e) => { const a = e.target.value as 'deg' | 'rad'; setAngles(a); if (text) useFit.setState({ csv: parseTireTable(text, a), result: null }); }}>
          <option value="deg">degrees</option>
          <option value="rad">radians</option>
        </select>
        <input ref={input} type="file" accept=".csv,.txt,.dat,.tsv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ''; }} />
      </div>
      {csv && (
        <>
          {csv.errors.map((x) => <p key={x} className="hint warn-text">{x}</p>)}
          {!csv.errors.length && (
            <p className="small-text">
              <b>{st.name}</b>: {csv.samples.length} rows · columns {csv.columns.join(', ')} · load {fmt(Math.min(...csv.samples.map((s) => s.fz)), 0)}–{fmt(Math.max(...csv.samples.map((s) => s.fz)), 0)} N
            </p>
          )}
          {csv.warnings.map((x) => <p key={x} className="small-text muted">{x}</p>)}
          {!csv.errors.length && (
            <div className="jm-row">
              {!st.running
                ? <button className="wide-btn primary" onClick={fit}>▶ Fit</button>
                : <button className="wide-btn" onClick={() => st.stop?.()}>■ Stop</button>}
            </div>
          )}
        </>
      )}
      {st.running && <p className="small-text run-line"><span className="spinner" /> Fitting: {st.progress}</p>}
      {st.error && <p className="hint warn-text">{st.error}</p>}
      {r && csv && (
        <div className="opt-result">
          <p className="small-text">
            {q(r.lateral, 'Cornering')}<br />{q(r.longitudinal, 'Braking / driving')}
            {r.combinedLateral !== undefined && <><br />{q(r.combinedLateral ?? null, 'Combined slip, side force')}</>}
            {r.combinedLongitudinal !== undefined && <><br />{q(r.combinedLongitudinal ?? null, 'Combined slip, braking / driving force')}</>}
            {r.moment && <><br />{`Aligning moment: ${r.moment.rows} rows, error ${fmt(r.moment.rmsN, 1)} N·m RMS, R² ${fmt(r.moment.r2, 3)}`}</>}
          </p>
          <p className="small-text">
            Nominal load {fmt(r.model.fnomin, 0)} N{r.model.nompres > 0 ? `, pressure ${fmt(r.model.nompres, 0)} kPa` : ''} · peak side μ {fmt(r.model.p.PDY1, 2)}, braking μ {fmt(r.model.p.PDX1, 2)} at the nominal load
          </p>
          {r.warnings.map((x) => <p key={x} className="small-text muted">{x}</p>)}
          <FitPlot csv={csv} r={r} />
          <div className="jm-row">
            <button className="chip on" onClick={() => use('both')}>Use for all tires</button>
            <button className="chip" onClick={() => use('front')}>Front only</button>
            <button className="chip" onClick={() => use('rear')}>Rear only</button>
            <button className="chip" onClick={() => download(writeTir(r.model), r.model.name)}>Download .tir</button>
          </div>
        </div>
      )}
    </details>
  );
}
