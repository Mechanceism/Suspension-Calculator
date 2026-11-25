/**
 * The motion plays (Corner: travel / load, steering; Vehicle: cornering, braking / accelerating, steering) step
 * through a fixed set of positions, about 30 a second and the same ones every cycle, and only set the store when
 * the step changes. The models keep each step's result while a play runs (useModel / useVehicle), so after the
 * first cycle a play only shows results already worked out (round 4: a new value every animation frame meant
 * a new solve and a redraw of every panel each frame — a slide show).
 */
import { useEffect, useRef } from 'react';

export const PLAY_STEPS_PER_SECOND = 30;

/** Calls `onPhase` with sin(2π · step / steps) each time the step changes while `active`. */
export function usePlayLoop(active: boolean, period: number, onPhase: (s: number) => void) {
  const cb = useRef(onPhase);
  cb.current = onPhase;
  useEffect(() => {
    if (!active) return;
    const steps = Math.max(8, Math.round((period / 1000) * PLAY_STEPS_PER_SECOND));
    let raf = 0, last = -1;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.floor(((now - t0) / period) * steps) % steps;
      if (k !== last) { last = k; cb.current(Math.round(Math.sin((k / steps) * Math.PI * 2) * 1e6) / 1e6); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, period]);
}

/**
 * The value the panels show while a play runs: refreshed about four times a second (the 3D view gets every
 * step); otherwise always the latest. Panels that take it are memoized, so in between they don't redraw.
 */
export function useCalm<T>(value: T, calm: boolean, ms = 250): T {
  const held = useRef<{ v: T; t: number }>({ v: value, t: 0 });
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!calm || now - held.current.t >= ms) held.current = { v: value, t: now };
  return held.current.v;
}
