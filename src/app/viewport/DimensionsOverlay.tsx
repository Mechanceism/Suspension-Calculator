/**
 * Held dimensions drawn in the corner view: a dashed line between the two points (at their current,
 * moving positions) with the held value. Amber = met, red = not met. Values held at ride height or a
 * travel position show where they apply.
 */
import { lerp } from '../../core/math/vec3';
import { isAngleMeasure } from '../../core/suspension/dimensions';
import { useApp, rootOf } from '../store';
import { anchorPosition } from '../anchors';
import { MEASURE_LABELS } from '../heldDimensions';
import type { Current } from '../useModel';
import { useDisplay } from '../units';
import { SafeHtml as Html } from './SafeHtml';
import { Seg } from './primitives';

export function DimensionsOverlay({ cur }: { cur: Current }) {
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const dims = useApp((s) => s.dimensions);
  const violations = useApp((s) => s.dimViolations);
  const startMeasure = useApp((s) => s.startMeasure);
  const disp = useDisplay();
  const mine = dims.filter((d) => d.root === root);
  if (!mine.length) return null;
  return (
    <group>
      {mine.map((d) => {
        const a = anchorPosition(d.a, cur);
        const b = anchorPosition(d.b, cur);
        if (!a || !b) return null;
        const bad = violations.includes(d.id);
        const color = bad ? '#ff5c5c' : '#ffd60a';
        const mid = lerp(a, b, 0.5);
        const value = isAngleMeasure(d.measure) ? `${d.value.toFixed(2)}°` : disp.format(d.value, 'mm', 1);
        const where = d.travel === null ? '' : d.travel === 0 ? ' @ride' : ` @${d.travel}`;
        return (
          <group key={d.id}>
            <Seg a={a} b={b} color={color} width={1.5} dashed />
            <Html position={[mid.x, mid.y, mid.z]} style={{ pointerEvents: 'auto' }}>
              <button className={`dim-label${bad ? ' bad' : ''}`} onClick={() => startMeasure([d.a, d.b])}
                title={`Held ${MEASURE_LABELS[d.measure]}${d.travel === null ? ' (permanent)' : d.travel === 0 ? ' at ride height' : ` at ${d.travel} mm travel`}${bad ? ' — NOT MET' : ''}. Click to edit.`}>
                🔒 {d.measure === 'distance' ? '' : `${MEASURE_LABELS[d.measure]} `}{value}{where}
              </button>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
