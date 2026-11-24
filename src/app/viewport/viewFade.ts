/**
 * Changing view (Corner, Vehicle, Tests static / dynamic): the new view fades in over the old one with its
 * camera's sweep (same time, same easing). The old view stays drawn underneath and its camera follows the new
 * one around the car (cameraMemory: the last camera, in the vehicle frame), so what both show — the car —
 * stays put and only what one of them has (the other corners, the road, the ground) fades in or out.
 * Changing again before a fade ends keeps the views under it (each frozen at how far it had faded in, the
 * bottom one opaque) until the newest has faded in.
 */
import { useEffect } from 'react';
import { addAfterEffect, advance, useThree, type RootState } from '@react-three/fiber';
import { create } from 'zustand';
import { ease } from './cameraMemory';

interface FadeState {
  /** The view shown (fading in, or in). */
  active: string;
  /** Views still drawn under it, bottom first, until it has faded in. */
  leaving: string[];
}
export const useViewFade = create<FadeState>(() => ({ active: '', leaving: [] }));

const slots = new Map<string, HTMLElement>();
const opacity = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

function setOpacity(key: string, v: number) {
  opacity.set(key, v);
  const el = slots.get(key);
  if (el) el.style.opacity = String(v);
}
function layer() {
  const { active, leaving } = useViewFade.getState();
  [...leaving, active].forEach((k, i) => { const el = slots.get(k); if (el) el.style.zIndex = String(i + 1); });
}

/** A view's slot (the element faded): its opacity and layer kept on it across re-renders. */
export function slotRef(key: string) {
  return (el: HTMLElement | null) => {
    if (!el) { slots.delete(key); return; }
    slots.set(key, el);
    el.style.opacity = String(opacity.get(key) ?? 0);
    layer();
  };
}

/** A view is shown: the first one at once; after that it starts hidden over the old ones and fades in with its sweep. */
export function showView(key: string) {
  const s = useViewFade.getState();
  if (s.active === key) return;
  clearTimeout(timer);
  if (!s.active) {
    setOpacity(key, 1);
    useViewFade.setState({ active: key, leaving: [] });
    layer();
    return;
  }
  const leaving = [...s.leaving.filter((k) => k !== key), s.active].filter((k) => (opacity.get(k) ?? 0) > 0.001);
  if (leaving[0]) setOpacity(leaving[0], 1); // the bottom one opaque (nothing shows through)
  setOpacity(key, 0);
  useViewFade.setState({ active: key, leaving });
  layer();
  // Should its camera never report (no car to show), show it anyway.
  timer = setTimeout(() => fadeIn(key, 1), 3500);
}

/** The shown view's camera sweep, 0 → 1 (called each frame of it; 1 straight away without a sweep). */
export function fadeIn(key: string, u: number) {
  const s = useViewFade.getState();
  if (s.active !== key) return;
  // Only ever up (a camera change within a view shown sweeps too, and must not fade it).
  const v = Math.max(ease(u), opacity.get(key) ?? 0);
  if (v === opacity.get(key) && !s.leaving.length) return;
  setOpacity(key, v);
  if (u >= 1) {
    clearTimeout(timer);
    if (s.leaving.length) { s.leaving.forEach((k) => setOpacity(k, 0)); useViewFade.setState({ leaving: [] }); }
  }
}

/** A view still drawn under the shown one (its camera follows the shown one's). */
export const isLeaving = (key: string) => useViewFade.getState().leaving.includes(key);

/**
 * The views under the shown one are drawn after it in the same frame, once it has moved its camera (they
 * don't draw on their own: a view drawn on its own frame would follow a frame late, and the car shown by
 * both would double up while they fade).
 */
const roots = new Map<string, () => RootState>();
addAfterEffect((timestamp) => {
  for (const k of useViewFade.getState().leaving) {
    const get = roots.get(k);
    if (get) advance(timestamp, false, get());
  }
});
/** Inside a view's Canvas: lets the fade draw it while it is under the one shown. */
export function FadeRoot({ viewKey }: { viewKey: string }) {
  const get = useThree((s) => s.get);
  useEffect(() => { roots.set(viewKey, get); return () => { if (roots.get(viewKey) === get) roots.delete(viewKey); }; }, [viewKey, get]);
  return null;
}
