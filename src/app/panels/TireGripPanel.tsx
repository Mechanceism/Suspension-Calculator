/**
 * Tire grip model editor (Magic Formula): the simple model's coefficients (basic first, the rest under
 * Advanced) or a model imported from a .tir file (with its grip scales), live
 * curves of force ÷ load vs slip angle and slip ratio, and what they mean at the nominal load (peak μ,
 * best lean, sliding share). The contact-patch pressure model below it only feeds the contact-area goal.
 */
import { useMemo, useRef, useState } from 'react';
import { mfLateral, mfLongitudinal, mfPeaks, mfPeakSlips, nominalLoad, type TireGrip } from '../../core/tire/magicFormula';
import type { TirModel } from '../../core/tire/tir';
import { useApp, MF_KEYS, MF_META, GRIP_META, type MFKey, type TireAxle } from '../store';
import { tireGripFor } from '../optimizer';
import { importTireFile, tirDimensions } from '../tireActions';
import { TireFit } from './TireFitPanel';
import { FieldRows, fmt } from './FieldRows';
import { Local, Val } from './UnitText';

const DEG = Math.PI / 180;
const W = 280, H = 140, PAD = { l: 30, r: 8, t: 8, b: 22 };

interface Series { label: string; color: string; dash?: string; pts: [number, number][] }

function Plot({ series, xMax, xLabel, xFmt }: { series: Series[]; xMax: number; xLabel: string; xFmt: (x: number) => string }) {
  const yMax = Math.max(0.5, ...series.flatMap((s) => s.pts.map((p) => p[1]))) * 1.1;
  const px = (x: number) => PAD.l + (x / xMax) * (W - PAD.l - PAD.r);
  const py = (y: number) => H - PAD.b - (y / yMax) * (H - PAD.t - PAD.b);
  const yTicks = [0, 0.5, 1, 1.5, 2, 2.5, 3].filter((v) => v <= yMax);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * xMax);
  return (
    <svg className="tire-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Force ÷ load vs ${xLabel}`}>
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={py(v)} y2={py(v)} className="grid-line" />
          <text x={PAD.l - 4} y={py(v) + 3} className="axis-text" textAnchor="end">{v}</text>
        </g>
      ))}
      {xTicks.map((v) => <text key={v} x={px(v)} y={H - 8} className="axis-text" textAnchor="middle">{xFmt(v)}</text>)}
      <text x={W - PAD.r} y={H - 1} className="axis-text" textAnchor="end">{xLabel}</text>
      <text x={4} y={PAD.t + 2} className="axis-text">F/Fz</text>
      {series.map((s) => (
        <polyline key={s.label} points={s.pts.map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(' ')}
          fill="none" stroke={s.color} strokeWidth={1.6} strokeDasharray={s.dash}><title>{s.label}</title></polyline>
      ))}
    </svg>
  );
}

const LOADS = [{ k: 0.5, color: '#7fd1c7' }, { k: 1, color: '#e4e7ec' }, { k: 1.5, color: '#c3a6ff' }];

function curves(m: TireGrip) {
  const fz0 = nominalLoad(m);
  const n = 60;
  const lat: Series[] = LOADS.map(({ k, color }) => ({
    label: `${k} × Fz0, level`, color,
    pts: Array.from({ length: n + 1 }, (_, i) => { const a = (15 * i) / n; return [a, mfLateral(m, a * DEG, { fz: k * fz0 }) / (k * fz0)] as [number, number]; }),
  }));
  for (const [lean, dash, label] of [[2, '4 3', 'Fz0, leaning 2° into the turn'], [-2, '1 3', 'Fz0, leaning 2° out of the turn']] as const) {
    lat.push({
      label, color: '#ffd166', dash,
      pts: Array.from({ length: n + 1 }, (_, i) => { const a = (15 * i) / n; return [a, mfLateral(m, a * DEG, { fz: fz0, gamma: lean * DEG }) / fz0] as [number, number]; }),
    });
  }
  const lon: Series[] = LOADS.map(({ k, color }) => ({
    label: `${k} × Fz0`, color,
    pts: Array.from({ length: n + 1 }, (_, i) => { const s = (0.3 * i) / n; return [s, mfLongitudinal(m, s, { fz: k * fz0 }) / (k * fz0)] as [number, number]; }),
  }));
  return { lat, lon };
}

/** The best lean toward the turn (deg) at the nominal load, and the peak there. */
function bestLean(m: TireGrip) {
  const fz0 = nominalLoad(m);
  let best = 0, peak = -Infinity;
  for (let g = -6; g <= 6; g += 0.1) {
    const y = mfPeaks(m, { fz: fz0, gamma: g * DEG }).y;
    if (y > peak) { peak = y; best = g; }
  }
  return { best, peak };
}

export function TireGripFields() {
  const tireGrip = useApp((s) => s.tireGrip);
  const tireFile = useApp((s) => s.tireFile);
  const tireFileRear = useApp((s) => s.tireFileRear);
  const grip = useApp((s) => s.grip);
  const setField = useApp((s) => s.setTireGripField);
  const setGripField = useApp((s) => s.setGripField);
  const setTireFile = useApp((s) => s.setTireFile);
  const setRearTireSame = useApp((s) => s.setRearTireSame);
  const setTireScale = useApp((s) => s.setTireScale);
  const reset = useApp((s) => s.resetTireGrip);
  const fileInput = useRef<HTMLInputElement>(null);
  const split = tireFileRear !== null;
  const [tab, setTab] = useState<'front' | 'rear'>('front');
  const axle: 'front' | 'rear' = split ? tab : 'front';
  const importAxle: TireAxle = split ? axle : 'both';
  const file = axle === 'rear' ? (tireFileRear && tireFileRear !== 'simple' ? tireFileRear : null) : tireFile;
  const [lastFile, setLastFile] = useState<Record<'front' | 'rear', TirModel | null>>({ front: null, rear: null });
  const m = useMemo(() => tireGripFor({ tireGrip, tireFile, tireFileRear }, axle), [tireGrip, tireFile, tireFileRear, axle]);
  const fz0 = nominalLoad(m);
  const plots = useMemo(() => curves(m), [m]);
  const info = useMemo(() => {
    const pk = mfPeaks(m, { fz: fz0 });
    const half = mfPeaks(m, { fz: 0.5 * fz0 });
    const slips = mfPeakSlips(m, { fz: fz0 });
    return { pk, half, slips, lean: bestLean(m) };
  }, [m, fz0]);
  const row = (k: MFKey) => ({ label: MF_META[k].label, field: tireGrip[k], unit: MF_META[k].unit, hint: MF_META[k].hint, onCommit: (t: string) => setField(k, t) });
  const scaleRow = (key: 'LMUY' | 'LMUX', label: string, hint: string) => {
    const v = file?.p[key] ?? 1;
    return { label, field: { text: String(v), value: v }, unit: '×', hint, onCommit: (t: string) => { const n = Number(t); if (n > 0) setTireScale(key, n, axle); } };
  };
  const leanGain = (info.lean.peak / info.pk.y - 1) * 100;
  const shown = file ?? lastFile[axle];
  const useSimple = () => {
    if (!file) return;
    setLastFile((l) => ({ ...l, [axle]: file }));
    setTireFile(null, importAxle);
  };
  return (
    <div className="tire-grip">
      <div className="jm-row" title="Front and rear can use different tires (e.g. different sizes or compounds)">
        <span className="muted">Tires</span>
        {!split
          ? <>
              <span className="small-text">same front and rear</span>
              <button className="chip" onClick={() => { setTireFile(tireFile, 'front'); setTab('rear'); }} title="Give the rear tires their own model (starts as a copy of the front)">Different rear tire</button>
            </>
          : <>
              <button className={`chip${tab === 'front' ? ' on' : ''}`} onClick={() => setTab('front')}>Front</button>
              <button className={`chip${tab === 'rear' ? ' on' : ''}`} onClick={() => setTab('rear')}>Rear</button>
              <button className="chip" onClick={() => { if (confirm('Use the front tire model for the rear too?')) { setRearTireSame(); setTab('front'); } }}>Same as front</button>
            </>}
      </div>
      <div className="jm-row" title="The simple model has generic, editable coefficients. A .tir file is a fitted Magic Formula model of a real tire (MF 6.1 / 6.2 or 5.2).">
        <span className="muted">Model{split ? ` (${axle})` : ''}</span>
        <button className={`chip${!file ? ' on' : ''}`} onClick={useSimple}>Simple (generic)</button>
        {shown && (
          <button className={`chip${file ? ' on' : ''}`} onClick={() => { if (!file && lastFile[axle]) setTireFile(lastFile[axle], importAxle); }}>{shown.name}</button>
        )}
        <button className="chip" onClick={() => fileInput.current?.click()} title="Load a .tir file (Magic Formula tire property file)">Import .tir</button>
        <input ref={fileInput} type="file" accept=".tir,.TIR,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importTireFile(f, importAxle); e.target.value = ''; }} />
      </div>
      {file ? (
        <p className="hint">
          <b>{file.name}</b>: Magic Formula {file.version} (FITTYP {file.fittyp || '—'}), nominal load {fmt(file.fnomin, 0)} N
          {file.nompres > 0 ? <Local text={`, nominal pressure ${fmt(file.nompres, 0)} kPa`} /> : ''}, {Object.keys(file.p).length} values. Saved in your project.
          Forces use the full model; the car uses each tire&apos;s peak in the direction it pushes (both directions averaged, since left and right tires are mirror images).
          {tirDimensions(file) && <> <button className="link-btn" onClick={() => useApp.getState().applyTireDims(importAxle, tirDimensions(file)!)}>Use the file&apos;s tire size</button></>}
        </p>
      ) : (
        <p className="hint">
          <b>Magic Formula</b> (Pacejka), simple form. The coefficients are <b>generic</b>: a plausible tire, not fitted to a real one.
          Enter your tire&apos;s values, or <b>Import .tir</b> to use a fitted model of your tire.{split ? ' (The simple coefficients are shared by both axles.)' : ''}
        </p>
      )}
      <div className="tire-plots">
        <div>
          <div className="small-text muted">Side force ÷ load vs slip angle</div>
          <Plot series={plots.lat} xMax={15} xLabel="α °" xFmt={(x) => x.toFixed(0)} />
        </div>
        <div>
          <div className="small-text muted">Braking / drive force ÷ load vs slip ratio</div>
          <Plot series={plots.lon} xMax={0.3} xLabel="κ" xFmt={(x) => x.toFixed(2)} />
        </div>
      </div>
      <p className="small-text tire-legend">
        {LOADS.map((l) => <span key={l.k}><i style={{ background: l.color }} />{l.k} × Fz0</span>)}
        <span><i className="dash" />Fz0 leaning 2° into / out of the turn</span>
      </p>
      <p className="small-text">
        At Fz0 (<Val v={fz0} unit="N" digits={0} />): peak side μ <b>{fmt(info.pk.y / fz0, 2)}</b> (at half load {fmt(info.half.y / (0.5 * fz0), 2)}) at {fmt(info.slips.alpha / DEG, 1)}° slip
        {' '}· sliding keeps {fmt(info.pk.slideY * 100, 0)} % · best lean {fmt(Math.abs(info.lean.best), 1)}° {info.lean.best >= 0 ? 'into' : 'away from'} the turn ({leanGain >= 0 ? '+' : ''}{fmt(leanGain, 1)} %)
        {' '}· peak braking μ {fmt(info.pk.x / fz0, 2)}, locked keeps {fmt(info.pk.slideX * 100, 0)} %
      </p>
      {file ? (
        <>
          <FieldRows rows={[
            scaleRow('LMUY', 'Side grip scale (λμy)', 'Scales the peak side force (a test rig belt grips more than a road: try 0.6–0.8 for real surfaces). 1 = as fitted.'),
            scaleRow('LMUX', 'Braking / drive grip scale (λμx)', 'Scales the peak braking / drive force. 1 = as fitted.'),
          ]} />
          <div className="jm-row">
            <button className="chip" onClick={() => { if (confirm(`Stop using ${file.name} and go back to the simple model?`)) { setLastFile((l) => ({ ...l, [axle]: null })); setTireFile(null, importAxle); } }}>Remove the file</button>
          </div>
        </>
      ) : (
        <>
          <FieldRows rows={MF_KEYS.filter((k) => MF_META[k].basic).map(row)} />
          <details className="tire-advanced">
            <summary>Advanced coefficients</summary>
            <FieldRows rows={MF_KEYS.filter((k) => !MF_META[k].basic).map(row)} />
          </details>
          <div className="jm-row">
            <button className="chip" onClick={() => { if (confirm('Reset every tire coefficient to the generic defaults?')) reset(); }}>Reset to generic</button>
          </div>
        </>
      )}
      <details className="tire-advanced">
        <summary>Contact patch (contact-area goal)</summary>
        <FieldRows rows={[{ label: GRIP_META.carcassShare.label, field: grip.carcassShare, unit: '', hint: GRIP_META.carcassShare.hint, onCommit: (t: string) => setGripField('carcassShare', t) }]} />
        <p className="hint">
          The patch shape and its pressure spread come from the tire geometry: they feed the <i>contact area</i> goal and the
          pressure readouts. Grip, slip and pass / fail use the tire grip model above.
        </p>
      </details>
      <TireFit />
    </div>
  );
}
