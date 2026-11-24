import { describe, it, expect } from 'vitest';
import { exportSettingsFile, applySettingsFile } from '../src/app/settingsFile';
import { useApp, VIS_KEYS } from '../src/app/store';

describe('labels: one switch', () => {
  it('one Labels flag (on by default); older settings with marker / point labels carry over', () => {
    expect(VIS_KEYS).toContain('labels');
    expect((VIS_KEYS as readonly string[]).includes('markerLabels')).toBe(false);
    expect(useApp.getState().visibility.labels).toBe(true);
    const file = JSON.parse(JSON.stringify(exportSettingsFile()));
    // An older file: marker labels on, point labels off → Labels on.
    const old = JSON.parse(JSON.stringify(file));
    const vis = old.view?.visibility ?? old.visibility;
    vis.labels = false;
    vis.markerLabels = true;
    useApp.getState().set('visibility', { ...useApp.getState().visibility, labels: false });
    applySettingsFile(old);
    expect(useApp.getState().visibility.labels).toBe(true);
    // Both off → off.
    vis.markerLabels = false;
    applySettingsFile(old);
    expect(useApp.getState().visibility.labels).toBe(false);
  });
});
