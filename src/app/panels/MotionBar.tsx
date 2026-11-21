import { useEffect, useRef } from 'react';
import { useApp, type CornerMode } from '../store';
import type { Model } from '../useModel';

export function MotionBar({ model }: { model: Model }) {
  const travel = useApp((s) => s.travel);
  const rack = useApp((s) => s.rack);
  const driver = useApp((s) => s.driver);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const rackRange = useApp((s) => s.rackRange);
  const playing = useApp((s) => s.playing);
  const mode = useApp((s) => s.mode);
  const loadFactor = useApp((s) => s.loadFactor);
  const set = useApp((s) => s.set);
  const loaded = mode === 'loaded';
  const shownTravel = loaded ? model.current?.travel ?? 0 : travel;

  // Play: kinematic → sweep travel droop ↔ bump; loaded → sweep load factor 0.4 ↔ 1.8.
  const t0 = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    t0.current = performance.now();
    const tick = (now: number) => {
      const s = Math.sin(((now - t0.current) / 4000) * Math.PI * 2);
      if (loaded) set('loadFactor', 1.1 + 0.7 * s);
      else set('travel', s >= 0 ? s * bump : s * droop);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, bump, droop, set, loaded]);

  return (
    <div className="motion-bar">
      <label className="small">
        Mode
        <select value={mode} onChange={(e) => { set('playing', false); set('mode', e.target.value as CornerMode); }}>
          <option value="kinematic">Kinematic (set travel)</option>
          <option value="loaded">Loaded (settle on spring)</option>
        </select>
      </label>
      <button className={playing ? 'active' : ''} onClick={() => set('playing', !playing)}>
        {playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      {loaded ? (
        <label className="slider">
          <span>Load factor <b>{loadFactor.toFixed(2)}</b>× static · travel <b>{shownTravel.toFixed(1)}</b> mm</span>
          <input
            type="range" min={0} max={3} step={0.01} value={loadFactor}
            onChange={(e) => { set('playing', false); set('loadFactor', Number(e.target.value)); }}
            onDoubleClick={() => set('loadFactor', 1)}
          />
        </label>
      ) : (
        <label className="slider">
          <span>Travel <b>{shownTravel.toFixed(1)}</b> mm</span>
          <input
            type="range" min={-droop} max={bump} step={0.5} value={travel}
            onChange={(e) => { set('playing', false); set('travel', Number(e.target.value)); }}
            onDoubleClick={() => set('travel', 0)}
          />
        </label>
      )}
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
      {!loaded && (
        <label className="small">
          Travel measured at
          <select value={driver} onChange={(e) => set('driver', e.target.value as typeof driver)}>
            <option value="wheelCenter">Wheel center</option>
            <option value="contactPatch">Contact patch</option>
          </select>
        </label>
      )}
    </div>
  );
}
