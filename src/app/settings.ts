/**
 * User settings (not part of a project): custom pass-rule profiles. Saved in this browser and
 * exportable / importable with the other preferences (see fileActions: settings export).
 */
import { create } from 'zustand';
import type { CheckProfile } from '../core/tests/checks';

export interface CustomProfile { name: string; checks: CheckProfile }

const KEY = 'suspension-calculator.profiles';
function load(): CustomProfile[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const v = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(v) ? v.filter((p): p is CustomProfile => !!p && typeof (p as CustomProfile).name === 'string' && typeof (p as CustomProfile).checks === 'object') : [];
  } catch { return []; }
}
const save = (p: CustomProfile[]) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } };

export const useProfiles = create<{ profiles: CustomProfile[]; saveProfile(p: CustomProfile): void; removeProfile(name: string): void; setAll(p: CustomProfile[]): void }>((set, get) => ({
  profiles: load(),
  saveProfile: (p) => { const next = [...get().profiles.filter((x) => x.name !== p.name), p]; set({ profiles: next }); save(next); },
  removeProfile: (name) => { const next = get().profiles.filter((x) => x.name !== name); set({ profiles: next }); save(next); },
  setAll: (p) => { set({ profiles: p }); save(p); },
}));
