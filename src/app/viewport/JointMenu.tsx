/** Floating menu at a selected joint: nudge in steps, move by an amount, or type coordinates. */
import { Html } from '@react-three/drei';
import type { Vec3 } from '../../core/math/vec3';
import { useApp, POINT_NAMES, type PointKey } from '../store';
import { POINT_LABELS } from '../components';
import { STATE_KEY } from '../anchors';
import type { Current } from '../useModel';
import { PointEditor } from '../panels/PointEditor';

export function JointMenu({ id, cur }: { id: PointKey; cur: Current }) {
  const select = useApp((s) => s.select);
  const pos = cur.state.points[STATE_KEY[id]] as Vec3 | undefined;
  if (!pos) return null;
  const moved = cur.travel !== 0 || cur.state.inputs.rack !== 0;
  return (
    <Html position={[pos.x, pos.y, pos.z]} style={{ pointerEvents: 'auto' }} zIndexRange={[20, 10]}>
      <div className="joint-menu" onPointerDown={(e) => e.stopPropagation()}>
        <div className="jm-head">
          <div>
            <b>{POINT_LABELS[id]}</b>
            <div className="mono muted">{POINT_NAMES[id]}</div>
          </div>
          <button className="icon-btn" onClick={() => select(null)} title="Close (Esc)">✕</button>
        </div>
        <PointEditor id={id} />
        {moved && <p className="hint">Values are the design (static) position; the joint is drawn moved by travel/steer.</p>}
      </div>
    </Html>
  );
}
