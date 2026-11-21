import { describe, it, expect } from 'vitest';
import { parseValue, formatValue } from '../src/core';

const len = (t: string) => {
  const r = parseValue(t, 'length');
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('parseValue', () => {
  it('uses the default unit when none is given', () => {
    expect(len('1')).toBe(1);
    expect(len('-12.5')).toBe(-12.5);
  });
  it('converts unit suffixes', () => {
    expect(len('5in')).toBeCloseTo(127, 12);
    expect(len('2 cm')).toBeCloseTo(20, 12);
    expect(len('1ft')).toBeCloseTo(304.8, 12);
  });
  it('adds terms', () => {
    expect(len('5in + 3mm')).toBeCloseTo(130, 12);
    expect(len('1ft 2in')).toBeCloseTo(355.6, 12);
    expect(len('10 - 2.5')).toBeCloseTo(7.5, 12);
  });
  it('honours a different default unit', () => {
    const r = parseValue('2', 'length', 'in');
    expect(r.ok && r.value).toBeCloseTo(50.8, 12);
  });
  it('parses angles', () => {
    const r = parseValue('0.1rad', 'angle');
    expect(r.ok && r.value).toBeCloseTo(5.7295779513, 9);
  });
  it('parses pressure, force, rate, altitude, ratio and temperature', () => {
    const v = (t: string, q: Parameters<typeof parseValue>[1]) => { const r = parseValue(t, q); return r.ok ? r.value : NaN; };
    expect(v('12psi', 'pressure')).toBeCloseTo(82.737, 3);
    expect(v('2.2bar', 'pressure')).toBeCloseTo(220, 9);
    expect(v('200lbf', 'force')).toBeCloseTo(889.644, 3);
    expect(v('700lbf/in', 'rate')).toBeCloseTo(122.589, 3);
    expect(v('5000ft', 'altitude')).toBeCloseTo(1524, 9);
    expect(v('50%', 'ratio')).toBeCloseTo(0.5, 12);
    expect(v('68F', 'temperature')).toBeCloseTo(20, 9);
    expect(v('293.15K', 'temperature')).toBeCloseTo(20, 9);
    expect(v('-5', 'temperature')).toBe(-5);
  });
  it('rejects bad input', () => {
    expect(parseValue('', 'length').ok).toBe(false);
    expect(parseValue('5 furlongs', 'length').ok).toBe(false);
    expect(parseValue('abc', 'length').ok).toBe(false);
    expect(parseValue('13in320', 'length').ok).toBe(false);
    expect(parseValue('10 20', 'length').ok).toBe(false);
    expect(parseValue('1ft2in', 'length').ok).toBe(true);
  });
});

describe('formatValue', () => {
  it('formats in the requested unit', () => {
    expect(formatValue(127, 'length', 'in')).toBe('5in');
    expect(formatValue(12.3456, 'length')).toBe('12.346');
  });
});
