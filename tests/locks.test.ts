import { describe, it, expect } from 'vitest';
import { serializeProject, importProject } from '../src/app/project';
import { defaultDesign, type CornerLinks } from '../src/app/store';
import { lockKeys, pointAxisLocked, pointLocked, describeLock, copyCornerLocks } from '../src/app/locks';

const ALL_LINKED: CornerLinks = { frontPair: true, rearPair: true, rearFromFront: true };

describe('locks', () => {
  it('a part lock locks every coordinate of its points; a point lock only its own axis', () => {
    const locks = { [lockKeys.part('FL', 'uca')]: true, [lockKeys.point('FL', 'trInner', 1)]: true } as Record<string, true>;
    expect(pointLocked(locks, 'FL', 'ucaFwd', 'lca')).toBe(true);
    expect(pointLocked(locks, 'FL', 'ucaOut', 'lca')).toBe(true);
    expect(pointAxisLocked(locks, 'FL', 'lcaOut', 0, 'lca')).toBe(false);
    expect(pointAxisLocked(locks, 'FL', 'trInner', 1, 'lca')).toBe(true);
    expect(pointAxisLocked(locks, 'FL', 'trInner', 0, 'lca')).toBe(false);
    // The coilover's arm mount belongs to the arm that carries it.
    expect(pointLocked(locks, 'FL', 'dmpArm', 'uca')).toBe(true);
    expect(pointLocked(locks, 'FL', 'dmpArm', 'lca')).toBe(false);
  });

  it('describes keys with a group, a label and where to find them', () => {
    const p = describeLock('FL.point.trInner.y', ALL_LINKED);
    expect(p.group).toMatch(/FL \(shared with FR, RL, RR\)/);
    expect(p.label).toMatch(/Y/);
    expect(p.target).toEqual({ workspace: 'corner', corner: 'FL', selection: { kind: 'point', id: 'trInner' } });
    const v = describeLock('vehicle.mass', ALL_LINKED);
    expect(v.group).toBe('Vehicle');
    expect(v.target.workspace).toBe('vehicle');
    expect(describeLock('shared.front.dropLink.x', ALL_LINKED).label).toMatch(/Front anti-roll bar drop-link mount X/);
    expect(describeLock('FL.derived.lca.length', ALL_LINKED).target.selection).toEqual({ kind: 'component', id: 'lca' });
  });

  it('copies a corner\'s locks when it is unlinked', () => {
    const out = copyCornerLocks({ 'FL.part.uca': true, 'vehicle.mass': true }, 'FL', 'RL');
    expect(Object.keys(out).sort()).toEqual(['FL.part.uca', 'RL.part.uca', 'vehicle.mass']);
  });

  it('saves and loads locks with the project', () => {
    const d = defaultDesign();
    d.locks = { 'FL.point.trInner.y': true, 'FL.part.lca': true, 'vehicle.cgY': true, 'shared.rear.arbRate': true };
    const f = JSON.parse(JSON.stringify(serializeProject(d, 'Locked')));
    expect(f.locks).toEqual(Object.keys(d.locks).sort());
    const r = importProject(f);
    expect(r.warnings).toEqual([]);
    expect(r.design.locks).toEqual(d.locks);
  });
});
