import { useApp, type VisKey, type ComponentId } from '../store';
import { COLORS } from '../viewport/Scene';

const COMPONENTS: { key: VisKey; label: string; color: string; select: ComponentId }[] = [
  { key: 'chassis', label: 'Chassis pivots & rack', color: COLORS.chassis, select: 'chassis' },
  { key: 'uca', label: 'Upper control arm (UCA)', color: COLORS.uca, select: 'uca' },
  { key: 'lca', label: 'Lower control arm (LCA)', color: COLORS.lca, select: 'lca' },
  { key: 'upright', label: 'Upright / knuckle', color: COLORS.upright, select: 'upright' },
  { key: 'tieRod', label: 'Tie rod', color: COLORS.tieRod, select: 'tieRod' },
  { key: 'spring', label: 'Coilover (spring/damper)', color: COLORS.spring, select: 'spring' },
  { key: 'wheel', label: 'Wheel & tire', color: COLORS.wheel, select: 'wheel' },
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

function Row({ label, color, checked, onToggle, onSelect, selected }: {
  label: string; color: string; checked: boolean; onToggle: () => void; onSelect?: () => void; selected?: boolean;
}) {
  return (
    <div className={`tree-row${selected ? ' focused' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} title="Show / hide" />
      <span className="swatch" style={{ background: color }} />
      {onSelect
        ? <button className="link-btn grow" onClick={onSelect} title="Select and edit">{label}</button>
        : <span className="grow clickable" onClick={onToggle}>{label}</span>}
    </div>
  );
}

export function Browser() {
  const vis = useApp((s) => s.visibility);
  const toggle = useApp((s) => s.toggleVisibility);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const focusOn = useApp((s) => s.focusOn);
  const follow = useApp((s) => s.followFocus);
  const trails = useApp((s) => s.trails);
  const ghosts = useApp((s) => s.ghosts);
  const simpleTire = useApp((s) => s.simpleTire);
  const set = useApp((s) => s.set);
  return (
    <section className="panel">
      <div className="tree-group">
        <div className="tree-head">
          FL corner · Double wishbone
          <button className="icon-btn" title="Fit whole corner in view" onClick={() => focusOn('corner')}>◎</button>
        </div>
        {COMPONENTS.map((c) => (
          <Row
            key={c.key} label={c.label} color={c.color} checked={vis[c.key]} onToggle={() => toggle(c.key)}
            onSelect={() => select({ kind: 'component', id: c.select })}
            selected={selection?.kind === 'component' && selection.id === c.select}
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
        <div className="tree-head">Motion & display</div>
        <Row label="Motion trails" color="#ffffff" checked={trails} onToggle={() => set('trails', !trails)} />
        <Row label="Ghost at travel limits" color="#ffffff" checked={ghosts} onToggle={() => set('ghosts', !ghosts)} />
        <Row label="Camera follows focused part" color="#ffffff" checked={follow} onToggle={() => set('followFocus', !follow)} />
        <Row label="Plain cylinder tire (no shoulders)" color={COLORS.wheel} checked={simpleTire} onToggle={() => set('simpleTire', !simpleTire)} />
      </div>
    </section>
  );
}
