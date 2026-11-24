/**
 * drei's <Html> renders each label into its own React root. If the whole 3D view unmounts while
 * those roots are still mounted (e.g. switching Corner ↔ Vehicle), React reports an unmount-during-
 * render error. Labels are hidden for a frame before such a switch (see switchWorkspace), so they
 * unmount cleanly first.
 */
import { Html } from '@react-three/drei';
import { useMemo, type ComponentProps } from 'react';
import { useThree } from '@react-three/fiber';
import { useApp, type Workspace } from '../store';

export function SafeHtml(props: ComponentProps<typeof Html>) {
  const suspended = useApp((s) => s.suspendHtml);
  // One fixed container per canvas: drei otherwise mounts into whatever element receives the events, which
  // changes once the controls connect (the first label was lost, and later ones removed from the wrong node).
  const gl = useThree((st) => st.gl);
  const portal = useMemo(() => ({ current: gl.domElement.parentNode as HTMLElement }), [gl]);
  return suspended ? null : <Html wrapperClass="safe-html" portal={portal} {...props} />;
}

/**
 * Switch workspace after the 3D labels have unmounted: hide them, wait until none is left in the page (the
 * 3D view renders in its own root, so on a slow machine that takes more than a frame or two), then switch.
 */
export function switchWorkspace(w: Workspace): void {
  const s = useApp.getState();
  if (s.workspace === w) return;
  s.set('suspendHtml', true);
  let frames = 0;
  const go = () => {
    if (document.querySelector('.safe-html') && frames++ < 60) { requestAnimationFrame(go); return; }
    useApp.getState().set('workspace', w);
    requestAnimationFrame(() => requestAnimationFrame(() => useApp.getState().set('suspendHtml', false)));
  };
  requestAnimationFrame(go);
}
