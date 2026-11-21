/**
 * drei's <Html> renders each label into its own React root. If the whole 3D view unmounts while
 * those roots are still mounted (e.g. switching Corner ↔ Vehicle), React reports an unmount-during-
 * render error. Labels are hidden for a frame before such a switch (see switchWorkspace), so they
 * unmount cleanly first.
 */
import { Html } from '@react-three/drei';
import type { ComponentProps } from 'react';
import { useApp, type Workspace } from '../store';

export function SafeHtml(props: ComponentProps<typeof Html>) {
  const suspended = useApp((s) => s.suspendHtml);
  return suspended ? null : <Html {...props} />;
}

/** Switch workspace after the 3D labels have unmounted. */
export function switchWorkspace(w: Workspace): void {
  const s = useApp.getState();
  if (s.workspace === w) return;
  s.set('suspendHtml', true);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    useApp.getState().set('workspace', w);
    requestAnimationFrame(() => useApp.getState().set('suspendHtml', false));
  }));
}
