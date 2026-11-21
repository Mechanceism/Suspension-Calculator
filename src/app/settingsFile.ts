/**
 * Settings file: every user preference that isn't part of a project — display units, view options
 * (parts shown, labels, trails, ghosts, projection, force arrows, snapping) and custom pass-rule
 * profiles — so they can be moved to another browser or shared.
 */
import { useApp, VIS_KEYS } from './store';
import { useUnits, DISPLAY_UNITS, type DisplayQuantity, type UnitSystem } from './units';
import { useProfiles } from './settings';
import { APP_VERSION } from './project';

export const SETTINGS_FORMAT = 'suspension-calculator-settings';

const VIEW_KEYS = ['visibility', 'simpleTire', 'trails', 'ghosts', 'followFocus', 'projection', 'forceVis', 'forceScale', 'forceValues', 'snapToGrid', 'gridSize', 'nudgeStep'] as const;

export function exportSettingsFile() {
  const s = useApp.getState();
  const u = useUnits.getState();
  return {
    format: SETTINGS_FORMAT, version: 1, appVersion: APP_VERSION, savedAt: new Date().toISOString(),
    units: { system: u.system, custom: u.custom },
    view: Object.fromEntries(VIEW_KEYS.map((k) => [k, s[k]])),
    profiles: useProfiles.getState().profiles,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Apply a settings file; returns notes about anything skipped. */
export function applySettingsFile(data: unknown): string[] {
  if (!isObj(data) || data.format !== SETTINGS_FORMAT) throw new Error('Not a Suspension Calculator settings file');
  const notes: string[] = [];
  if (isObj(data.units)) {
    const sys = data.units.system;
    const custom = isObj(data.units.custom) ? data.units.custom : {};
    const u = useUnits.getState();
    for (const [q, unit] of Object.entries(custom)) {
      if (q in DISPLAY_UNITS && typeof unit === 'string' && DISPLAY_UNITS[q as DisplayQuantity][unit]) u.setCustom(q as DisplayQuantity, unit);
      else notes.push(`unit ${q}=${String(unit)} not known, skipped`);
    }
    if (sys === 'metric' || sys === 'imperial' || sys === 'custom') useUnits.getState().setSystem(sys as UnitSystem);
  }
  if (isObj(data.view)) {
    const s = useApp.getState();
    const v = data.view;
    if (isObj(v.visibility)) {
      const vis = { ...s.visibility };
      for (const k of VIS_KEYS) if (typeof v.visibility[k] === 'boolean') vis[k] = v.visibility[k] as boolean;
      s.set('visibility', vis);
    }
    for (const k of ['simpleTire', 'trails', 'ghosts', 'followFocus', 'forceValues', 'snapToGrid'] as const) if (typeof v[k] === 'boolean') s.set(k, v[k] as never);
    for (const k of ['forceScale', 'gridSize', 'nudgeStep'] as const) if (typeof v[k] === 'number' && Number.isFinite(v[k])) s.set(k, v[k] as never);
    if (v.projection === 'orthographic' || v.projection === 'perspective') s.set('projection', v.projection);
    if (isObj(v.forceVis)) s.set('forceVis', { ...s.forceVis, ...Object.fromEntries(Object.entries(v.forceVis).filter(([k, b]) => k in s.forceVis && typeof b === 'boolean')) });
  }
  if (Array.isArray(data.profiles)) {
    const ok = data.profiles.filter((p): p is { name: string; checks: never } => isObj(p) && typeof p.name === 'string' && isObj(p.checks));
    const mine = useProfiles.getState();
    for (const p of ok) mine.saveProfile({ name: p.name, checks: p.checks });
    if (ok.length < data.profiles.length) notes.push(`${data.profiles.length - ok.length} profile(s) not readable, skipped`);
  }
  return notes;
}
