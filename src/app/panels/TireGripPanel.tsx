/**
 * Tire grip model editor (Magic Formula): the coefficients (basic first, the rest under Advanced), live
 * curves of force ÷ load vs slip angle and slip ratio, and what they mean at the nominal load (peak μ,
 * best lean, sliding share). The contact-patch pressure model below it only feeds the contact-area goal.
 */
import { useMemo } from 'react';
import { mfLateral, mfLongitudinal, mfPeaks, mfPeakSlips, type MFCoeffs } from '../../core/tire/magicFormula';
import { useApp, MF_KEYS, MF_META, GRIP_META, type MFKey } from '../store';
import { tireGripOf } from '../optimizer';
import { FieldRows, fmt } from './FieldRows';

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

function curves(m: MFCoeffs) {
  const n = 60;
  const lat: Series[] = LOADS.map(({ k, color }) => ({
    label: `${k} × Fz0, level`, color,
    pts: Array.from({ length: n + 1 }, (_, i) => { const a = (15 * i) / n; return [a, mfLateral(m, a * DEG, { fz: k * m.fz0 }) / (k * m.fz0)] as [number, number]; }),
  }));
  for (const [lean, dash, label] of [[2, '4 3', 'Fz0, leaning 2° into the turn'], [-2, '1 3', 'Fz0, leaning 2° out of the turn']] as const) {
    lat.push({
      label, color: '#ffd166', dash,
      pts: Array.from({ length: n + 1 }, (_, i) => { const a = (15 * i) / n; return [a, mfLateral(m, a * DEG, { fz: m.fz0, gamma: lean * DEG }) / m.fz0] as [number, number]; }),
    });
  }
  const lon: Series[] = LOADS.map(({ k, color }) => ({
    label: `${k} × Fz0`, color,
    pts: Array.from({ length: n + 1 }, (_, i) => { const s = (0.3 * i) / n; return [s, mfLongitudinal(m, s, { fz: k * m.fz0 }) / (k * m.fz0)] as [number, number]; }),
  }));
  return { lat, lon };
}

/** The best lean toward the turn (deg) at the nominal load, and the peak there. */
function bestLean(m: MFCoeffs) {
  let best = 0, peak = -Infinity;
  for (let g = -6; g <= 6; g += 0.05) {
    const y = mfPeaks(m, { fz: m.fz0, gamma: g * DEG }).y;
    if (y > peak) { peak = y; best = g; }
  }
  return { best, peak };
}

export function TireGripFields() {
  const tireGrip = useApp((s) => s.tireGrip);
  const grip = useApp((s) => s.grip);
  const setField = useApp((s) => s.setTireGripField);
  const setGripField = useApp((s) => s.setGripField);
  const reset = useApp((s) => s.resetTireGrip);
  const m = useMemo(() => tireGripOf(tireGrip), [tireGrip]);
  const plots = useMemo(() => curves(m), [m]);
  const info = useMemo(() => {
    const pk = mfPeaks(m, { fz: m.fz0 });
    const half = mfPeaks(m, { fz: 0.5 * m.fz0 });
    const slips = mfPeakSlips(m, { fz: m.fz0 });
    return { pk, half, slips, lean: bestLean(m) };
  }, [m]);
  const row = (k: MFKey) => ({ label: MF_META[k].label, field: tireGrip[k], unit: MF_META[k].unit, hint: MF_META[k].hint, onCommit: (t: string) => setField(k, t) });
  return (
    <div className="tire-grip">
      <p className="hint">
        <b>Magic Formula</b> (Pacejka). The coefficients are <b>generic</b>: a plausible tire, not fitted to a real one. Enter your
        tire's values when you have them (a .tir import / data fit comes later).
      </p>
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
        At Fz0: peak side μ <b>{fmt(info.pk.y / m.fz0, 2)}</b> (at half load {fmt(info.half.y / (0.5 * m.fz0), 2)}) at {fmt(info.slips.alpha / DEG, 1)}° slip
        {' '}· sliding keeps {fmt(info.pk.slideY * 100, 0)} % · best lean {fmt(info.lean.best, 1)}° into the turn (+{fmt((info.lean.peak / info.pk.y - 1) * 100, 1)} %)
        {' '}· peak braking μ {fmt(info.pk.x / m.fz0, 2)}, locked keeps {fmt(info.pk.slideX * 100, 0)} %
      </p>
      <FieldRows rows={MF_KEYS.filter((k) => MF_META[k].basic).map(row)} />
      <details className="tire-advanced">
        <summary>Advanced coefficients</summary>
        <FieldRows rows={MF_KEYS.filter((k) => !MF_META[k].basic).map(row)} />
      </details>
      <div className="jm-row">
        <button className="chip" onClick={() => { if (confirm('Reset every tire coefficient to the generic defaults?')) reset(); }}>Reset to generic</button>
      </div>
      <details className="tire-advanced">
        <summary>Contact patch (contact-area goal)</summary>
        <FieldRows rows={[{ label: GRIP_META.carcassShare.label, field: grip.carcassShare, unit: '', hint: GRIP_META.carcassShare.hint, onCommit: (t: string) => setGripField('carcassShare', t) }]} />
        <p className="hint">
          The patch shape and its pressure spread come from the tire geometry: they feed the <i>contact area</i> goal and the
          pressure readouts. Grip, slip and pass / fail use the Magic Formula above.
        </p>
      </details>
    </div>
  );
}
