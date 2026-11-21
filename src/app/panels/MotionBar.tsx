import { useEffect, useRef } from 'react';
import { useApp } from '../store';

export function MotionBar() {
  const travel = useApp((s) => s.travel);
  const rack = useApp((s) => s.rack);
  const driver = useApp((s) => s.driver);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const rackRange = useApp((s) => s.rackRange);
  const playing = useApp((s) => s.playing);
  const set = useApp((s) => s.set);

  // Play: sweep travel droop ↔ bump.
  const t0 = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    t0.current = performance.now();
    const tick = (now: number) => {
      const phase = ((now - t0.current) / 4000) * Math.PI * 2;
      const s = Math.sin(phase);
      set('travel', s >= 0 ? s * bump : s * droop);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, bump, droop, set]);

  return (
    <div className="motion-bar">
      <button className={playing ? 'active' : ''} onClick={() => set('playing', !playing)}>
        {playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <label className="slider">
        <span>Travel <b>{travel.toFixed(1)}</b> mm</span>
        <input
          type="range" min={-droop} max={bump} step={0.5} value={travel}
          onChange={(e) => { set('playing', false); set('travel', Number(e.target.value)); }}
          onDoubleClick={() => set('travel', 0)}
        />
      </label>
      <label className="slider">
        <span>Rack <b>{rack.toFixed(1)}</b> mm</span>
        <input
          type="range" min={-rackRange} max={rackRange} step={0.5} value={rack}
          onChange={(e) => set('rack', Number(e.target.value))}
          onDoubleClick={() => set('rack', 0)}
        />
      </label>
      <label className="small">
        Droop
        <input type="number" value={droop} min={1} max={300} onChange={(e) => set('droop', Math.max(1, Number(e.target.value)))} />
      </label>
      <label className="small">
        Bump
        <input type="number" value={bump} min={1} max={300} onChange={(e) => set('bump', Math.max(1, Number(e.target.value)))} />
      </label>
      <label className="small">
        Travel measured at
        <select value={driver} onChange={(e) => set('driver', e.target.value as typeof driver)}>
          <option value="wheelCenter">Wheel center</option>
          <option value="contactPatch">Contact patch</option>
        </select>
      </label>
    </div>
  );
}
