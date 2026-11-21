/**
 * Road layer of a test segment: grade, bank, rough surface (seeded height map) with a preview, placed
 * bumps / potholes, and held offsets under a wheel.
 */
import { useEffect, useMemo, useRef } from 'react';
import { parseValue, type Quantity } from '../../core/units/units';
import { CORNER_IDS } from '../../core/vehicle/vehicle';
import { roadHeight } from '../../core/tests/road';
import { useApp, mergedCorners, rootOf, toGeometry, type Field } from '../store';
import { newFeature, newSeed, roadSpecOf, type TestSegment } from '../tests';
import { ValueInput } from './ValueInput';
import { useDisplay } from '../units';

const parse = (text: string, q: Quantity, prev: Field): Field => {
  const r = parseValue(text, q);
  return r.ok ? { text, value: r.value } : { ...prev, text, error: r.error };
};

/** Car wheelbase and half track (m) for drawing the wheel paths. */
function useCarDims() {
  const wheelbase = useApp((s) => s.vehicle.wheelbase.value);
  const geom = useApp((s) => mergedCorners(s)[rootOf('FL', s.links)].geom);
  return useMemo(() => ({ wheelbase: wheelbase / 1000, halfTrack: Math.abs(toGeometry(geom).wheel.center.x) / 1000 }), [wheelbase, geom]);
}

/** Top view of the segment's road (height map) with the wheel paths, and the profile under each wheel. */
function RoadPreview({ seg }: { seg: TestSegment }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const disp = useDisplay();
  const dims = useCarDims();
  const road = roadSpecOf(seg);
  const L = Math.max(seg.distance.value, 1);
  const W = Math.max(2 * dims.halfTrack + 1, 2.5);
  const maxH = Math.max(1, seg.rough.on ? seg.rough.maxHeight.value : 0, ...seg.features.map((f) => f.height.value));
  const key = JSON.stringify(road) + L;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !road) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width, h = c.height;
    const img = ctx.createImageData(w, h);
    for (let px = 0; px < w; px++) {
      const s = (px / (w - 1)) * L;
      for (let py = 0; py < h; py++) {
        const y = W / 2 - (py / (h - 1)) * W;
        const v = Math.max(-1, Math.min(1, roadHeight(road, s, y) / maxH));
        // Pothole blue, flat grey, bump orange.
        const r = v > 0 ? 70 + 185 * v : 70 * (1 + v);
        const g = v > 0 ? 70 + 90 * v : 70 + 40 * -v;
        const b = v > 0 ? 70 - 40 * v : 70 + 185 * -v;
        const i = (py * w + px) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([4, 3]);
    for (const y of [dims.halfTrack, -dims.halfTrack]) {
      const py = ((W / 2 - y) / W) * (h - 1);
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
    }
  }, [key, W, maxH, dims.halfTrack]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!road) return null;
  const N = 160;
  const prof = (y: number) => Array.from({ length: N }, (_, i) => { const s = (i / (N - 1)) * L; return [s, roadHeight(road, s, y)] as const; });
  const toPath = (pts: readonly (readonly [number, number])[]) => pts.map(([s, v], i) => `${i ? 'L' : 'M'}${((s / L) * 260).toFixed(1)},${(30 - (v / maxH) * 26).toFixed(1)}`).join('');
  return (
    <div className="road-preview" title="Top view (left of the car at the top); dashed lines = wheel paths. Orange = bump, blue = pothole.">
      <canvas ref={canvas} width={260} height={56} />
      <svg viewBox="0 0 260 60" className="road-profile">
        <line x1={0} x2={260} y1={30} y2={30} className="zero" />
        <path d={toPath(prof(dims.halfTrack))} className="prof-left" />
        <path d={toPath(prof(-dims.halfTrack))} className="prof-right" />
      </svg>
      <div className="small-text muted">
        <span className="prof-left-key">— left wheels</span> · <span className="prof-right-key">— right wheels</span> · ± {disp.format(maxH, 'mm', 0)} · {disp.format(L, 'm', 0)} long
      </div>
    </div>
  );
}

export function RoadEditor({ seg, upd }: { seg: TestSegment; upd: (fn: (s: TestSegment) => TestSegment) => void }) {
  const disp = useDisplay();
  const r = seg.rough;
  const setRough = (patch: Partial<TestSegment['rough']>) => upd((s) => ({ ...s, rough: { ...s.rough, ...patch } }));
  const setFeat = (id: string, patch: Partial<TestSegment['features'][number]>) =>
    upd((s) => ({ ...s, features: s.features.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
  return (
    <>
      <tr title="+ = uphill (incline), − = downhill (decline)">
        <td>Grade</td>
        <td><ValueInput field={seg.grade} unit="%" width={56} onCommit={(t) => upd((s) => ({ ...s, grade: parse(t, 'percent', s.grade) }))} /></td>
        <td className="unit">%</td><td />
      </tr>
      <tr title="+ = left side lower">
        <td>Bank</td>
        <td><ValueInput field={seg.bank} unit="°" width={56} onCommit={(t) => upd((s) => ({ ...s, bank: parse(t, 'angle', s.bank) }))} /></td>
        <td className="unit">°</td><td />
      </tr>
      <tr title="A random rough surface: the same seed always gives the same road">
        <td>Rough surface</td>
        <td colSpan={3}>
          <label className="check-inline"><input type="checkbox" checked={r.on} onChange={() => setRough({ on: !r.on })} /> on</label>
          {r.on && (
            <span className="nowrap"> · seed <input className="value-input small" value={r.seed} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setRough({ seed: Math.round(n) }); }} />
              <button className="icon-btn" title="New random road" onClick={() => setRough({ seed: newSeed() })}>🎲</button>
            </span>
          )}
        </td>
      </tr>
      {r.on && (
        <>
          <tr title="Largest bump height / pothole depth">
            <td>Max height</td>
            <td><ValueInput field={r.maxHeight} unit="mm" width={56} onCommit={(t) => setRough({ maxHeight: parse(t, 'length', r.maxHeight) })} /></td>
            <td className="unit">{disp.conv('mm').unit}</td><td />
          </tr>
          <tr title="Typical bump size and spacing: smaller = more, closer bumps">
            <td>Scale</td>
            <td><ValueInput field={r.scale} unit="m" width={56} onCommit={(t) => setRough({ scale: parse(t, 'distance', r.scale) })} /></td>
            <td className="unit">{disp.conv('m').unit}</td><td />
          </tr>
          <tr title="Share of the road that is rough (the rest is smooth patches)">
            <td>Coverage</td>
            <td><ValueInput field={r.coverage} unit="%" width={56} onCommit={(t) => setRough({ coverage: parse(t, 'percent', r.coverage) })} /></td>
            <td className="unit">%</td><td />
          </tr>
        </>
      )}
      <tr>
        <td>Bumps / potholes</td>
        <td colSpan={3}>
          <button className="chip" onClick={() => upd((s) => ({ ...s, features: [...s.features, newFeature('bump', Math.min(10, s.distance.value / 2))] }))}>+ Bump</button>
          <button className="chip" onClick={() => upd((s) => ({ ...s, features: [...s.features, newFeature('pothole', Math.min(20, s.distance.value / 2))] }))}>+ Pothole</button>
        </td>
      </tr>
      {seg.features.map((f) => (
        <tr key={f.id} className="feature-row">
          <td>
            <select value={f.kind} onChange={(e) => setFeat(f.id, { kind: e.target.value as 'bump' | 'pothole' })}>
              <option value="bump">Bump</option><option value="pothole">Pothole</option>
            </select>
          </td>
          <td colSpan={3}>
            <span className="feature-fields">
              <label title="Start, from the segment start">at <ValueInput field={f.at} unit="m" width={40} onCommit={(t) => setFeat(f.id, { at: parse(t, 'distance', f.at) })} /></label>
              <label title="Length along the road">len <ValueInput field={f.length} unit="m" width={36} onCommit={(t) => setFeat(f.id, { length: parse(t, 'distance', f.length) })} /></label>
              <label title={f.kind === 'bump' ? 'Height' : 'Depth'}>{f.kind === 'bump' ? 'h' : 'd'} <ValueInput field={f.height} unit="mm" width={36} onCommit={(t) => setFeat(f.id, { height: parse(t, 'length', f.height) })} /></label>
              <select value={f.side} onChange={(e) => setFeat(f.id, { side: e.target.value as 'left' | 'right' | 'both' })} title="Under which wheels">
                <option value="both">both</option><option value="left">left</option><option value="right">right</option>
              </select>
              <button className="icon-btn" title="Remove" onClick={() => upd((s) => ({ ...s, features: s.features.filter((x) => x.id !== f.id) }))}>✕</button>
            </span>
          </td>
        </tr>
      ))}
      <tr><td colSpan={4}><RoadPreview seg={seg} /></td></tr>
      <tr title="Older style: a ground offset held under a wheel for the whole segment (+ bump, − pothole)">
        <td>Held under a wheel</td>
        <td colSpan={3}>
          <div className="bump-grid">
            {CORNER_IDS.map((id) => (
              <label key={id}>
                <span className="muted">{id}</span>
                <ValueInput field={seg.bumps[id]} unit="mm" width={44} onCommit={(t) => upd((s) => ({ ...s, bumps: { ...s.bumps, [id]: parse(t, 'length', s.bumps[id]) } }))} />
              </label>
            ))}
          </div>
        </td>
      </tr>
    </>
  );
}
