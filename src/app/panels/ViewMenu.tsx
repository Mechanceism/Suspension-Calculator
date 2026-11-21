/**
 * View menu (top bar): what is drawn, in every viewport (Corner and Vehicle). Replaces the old
 * Browser tab. Stays open while you toggle; closes on a click outside or Esc.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp, type VisKey, type ComponentId } from '../store';
import { COLORS } from '../viewport/Scene';

const COMPONENTS: { key: VisKey; label: string; color: string; select: ComponentId }[] = [
  { key: 'chassis', label: 'Chassis pivots, frame & rack', color: COLORS.chassis, select: 'chassis' },
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
  { key: 'dimensions', label: 'Held dimensions', color: '#ffd60a' },
];

function Row({ label, color, checked, onToggle, onEdit }: { label: string; color: string; checked: boolean; onToggle: () => void; onEdit?: () => void }) {
  return (
    <div className="view-row">
      <label>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="swatch" style={{ background: color }} />
        <span>{label}</span>
      </label>
      {onEdit && <button className="icon-btn" title="Select and edit (Corner view)" onClick={onEdit}>✎</button>}
    </div>
  );
}

export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const vis = useApp((s) => s.visibility);
  const toggle = useApp((s) => s.toggleVisibility);
  const select = useApp((s) => s.select);
  const workspace = useApp((s) => s.workspace);
  const follow = useApp((s) => s.followFocus);
  const trails = useApp((s) => s.trails);
  const ghosts = useApp((s) => s.ghosts);
  const simpleTire = useApp((s) => s.simpleTire);
  const set = useApp((s) => s.set);
  const focusOn = useApp((s) => s.focusOn);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="file-menu view-menu" ref={root}>
      <button className={`menu-btn${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>View</button>
      {open && (
        <div className="menu view-menu-panel" role="menu">
          <div className="menu-head">Parts <span className="muted">(all views)</span></div>
          {COMPONENTS.map((c) => (
            <Row
              key={c.key} label={c.label} color={c.color} checked={vis[c.key]} onToggle={() => toggle(c.key)}
              onEdit={workspace === 'corner' ? () => { select({ kind: 'component', id: c.select }); setOpen(false); } : undefined}
            />
          ))}
          <div className="menu-sep" />
          <div className="menu-head">Construction</div>
          {CONSTRUCTION.map((c) => <Row key={c.key} label={c.label} color={c.color} checked={vis[c.key]} onToggle={() => toggle(c.key)} />)}
          <div className="menu-sep" />
          <div className="menu-head">Motion & display</div>
          <Row label="Motion trails (corner)" color="#ffffff" checked={trails} onToggle={() => set('trails', !trails)} />
          <Row label="Ghost at travel limits (corner)" color="#ffffff" checked={ghosts} onToggle={() => set('ghosts', !ghosts)} />
          <Row label="Camera follows focused part" color="#ffffff" checked={follow} onToggle={() => set('followFocus', !follow)} />
          <Row label="Plain cylinder tire (no shoulders)" color={COLORS.wheel} checked={simpleTire} onToggle={() => set('simpleTire', !simpleTire)} />
          <div className="menu-sep" />
          <button role="menuitem" onClick={() => { focusOn('corner'); setOpen(false); }}>Fit everything in view<kbd>double middle-click</kbd></button>
        </div>
      )}
    </div>
  );
}
