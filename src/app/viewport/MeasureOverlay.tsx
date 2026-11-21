/** Measure tool: distance and ΔX/ΔY/ΔZ between two picked points, updating live with motion. */
import { Html } from '@react-three/drei';
import { sub, length, lerp } from '../../core/math/vec3';
import { useApp } from '../store';
import { anchorLabel, anchorPosition } from '../anchors';
import type { Current } from '../useModel';
import { Seg, Joint } from './primitives';

export function MeasureOverlay({ cur }: { cur: Current }) {
  const measure = useApp((s) => s.measure);
  const [a, b] = measure.map((id) => anchorPosition(id, cur));
  if (!a) return null;
  if (!b) return <Joint p={a} color="#ffffff" r={11} />;
  const d = sub(b, a);
  const mid = lerp(a, b, 0.5);
  const horiz = Math.hypot(d.x, d.z);
  return (
    <group>
      <Seg a={a} b={b} color="#ffffff" width={2} />
      <Joint p={a} color="#ffffff" r={8} />
      <Joint p={b} color="#ffffff" r={8} />
      <Html position={[mid.x, mid.y, mid.z]} style={{ pointerEvents: 'none' }}>
        <div className="measure-label">
          <b>{length(d).toFixed(2)} mm</b>
          <div>ΔX {d.x.toFixed(2)} · ΔY {d.y.toFixed(2)} · ΔZ {d.z.toFixed(2)}</div>
          <div>Angle from horizontal {((Math.atan2(d.y, horiz) * 180) / Math.PI).toFixed(2)}°</div>
          <div className="muted">{anchorLabel(measure[0]!)} → {anchorLabel(measure[1]!)}</div>
        </div>
      </Html>
    </group>
  );
}
