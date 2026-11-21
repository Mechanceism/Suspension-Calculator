import { useApp, type VisKey, type FocusKey } from '../store';
import { COLORS } from '../viewport/Scene';

const COMPONENTS: { key: VisKey; label: string; color: string; focus?: FocusKey }[] = [
  { key: 'chassis', label: 'Chassis pivots & rack', color: COLORS.chassis },
  { key: 'uca', label: 'Upper control arm (UCA)', color: COLORS.uca, focus: 'uca' },
  { key: 'lca', label: 'Lower control arm (LCA)', color: COLORS.lca, focus: 'lca' },
  { key: 'upright', label: 'Upright / knuckle', color: COLORS.upright, focus: 'upright' },
  { key: 'tieRod', label: 'Tie rod', color: COLORS.tieRod, focus: 'tieRod' },
  { key: 'spring', label: 'Coilover (spring/damper)', color: COLORS.spring, focus: 'spring' },
  { key: 'wheel', label: 'Wheel & tire', color: COLORS.wheel, focus: 'wheel' },
];

const CONSTRUCTION: { key: VisKey; label: string; color: string }[] = [
  { key: 'patch', label: 'Contact patch (loaded)', color: COLORS.patch },
  { key: 'steeringAxis', label: 'Steering axis', color: COLORS.steering },
  { key: 'icConstruction', label: 'Front-view IC lines', color: COLORS.ic },
  { key: 'rollCenter', label: 'Roll center', color: COLORS.rc },
  { key: 'ground', label: 'Ground plane', color: COLORS.ground },
  { key: 'datum', label: 'Origin axes', color: '#ffffff' },
  { key: 'labels', label: 'Point labels', color: '#ffffff' },
];

function Row({ label, color, checked, onToggle, onFocus, focused }: {
  label: string; color: string; checked: boolean; onToggle: () => void; onFocus?: () => void; focused?: boolean;
}) {
  return (
    <div className={`tree-row${focused ? ' focused' : ''}`}>
      <label>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="swatch" style={{ background: color }} />
        {label}
      </label>
      {onFocus && <button className="icon-btn" title="Focus camera" onClick={onFocus}>◎</button>}
    </div>
  );
}

export function Browser() {
  const vis = useApp((s) => s.visibility);
  const toggle = useApp((s) => s.toggleVisibility);
  const focus = useApp((s) => s.focus);
  const focusOn = useApp((s) => s.focusOn);
  const follow = useApp((s) => s.followFocus);
  const trails = useApp((s) => s.trails);
  const ghosts = useApp((s) => s.ghosts);
  const set = useApp((s) => s.set);
  return (
    <section className="panel">
      <h2>Browser</h2>
      <div className="tree-group">
        <div className="tree-head">
          FL corner · Double wishbone
          <button className="icon-btn" title="Focus whole corner" onClick={() => focusOn('corner')}>◎</button>
        </div>
        {COMPONENTS.map((c) => (
          <Row
            key={c.key} label={c.label} color={c.color} checked={vis[c.key]} onToggle={() => toggle(c.key)}
            onFocus={c.focus ? () => focusOn(c.focus!) : undefined} focused={c.focus === focus}
          />
        ))}
      </div>
      <div className="tree-group">
        <div className="tree-head">Construction</div>
        {CONSTRUCTION.map((c) => (
          <Row key={c.key} label={c.label} color={c.color} checked={vis[c.key]} onToggle={() => toggle(c.key)} />
        ))}
      </div>
      <div className="tree-group">
        <div className="tree-head">Motion</div>
        <Row label="Motion trails" color="#ffffff" checked={trails} onToggle={() => set('trails', !trails)} />
        <Row label="Ghost at travel limits" color="#ffffff" checked={ghosts} onToggle={() => set('ghosts', !ghosts)} />
        <Row label="Camera follows focus" color="#ffffff" checked={follow} onToggle={() => set('followFocus', !follow)} />
      </div>
    </section>
  );
}
