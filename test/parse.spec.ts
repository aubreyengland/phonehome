import { describe, expect, it } from 'vitest';
import { extractMacAddress, normalizeMac } from '../src/parse.ts';

describe('normalizeMac', () => {
  it('normalizes bare, colon, and dash forms to uppercase colon-delimited', () => {
    expect(normalizeMac('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('returns null for anything that is not 12 hex digits', () => {
    expect(normalizeMac('CCQ224502A7')).toBeNull(); // Cisco ATA serial
    expect(normalizeMac('VDI-CATTECH13')).toBeNull(); // softphone host name
    expect(normalizeMac('aabbccddeef')).toBeNull();
    expect(normalizeMac('')).toBeNull();
  });
});

describe('extractMacAddress', () => {
  it('extracts a MAC from a filename that is exactly 12 hex chars', () => {
    expect(extractMacAddress('/aabbccddeeff.cfg', '')).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('extracts a MAC from a Poly per-phone file with a suffix', () => {
    expect(extractMacAddress('/aabbccddeeff-phone.cfg', '')).toBe('AA:BB:CC:DD:EE:FF');
    expect(extractMacAddress('/aabbccddeeff-directory.xml', '')).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('extracts a MAC from a mac= query parameter', () => {
    expect(extractMacAddress('/boot.cfg', '?mac=aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(extractMacAddress('/boot.cfg', '?mac=aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('does not false-positive on a common boot filename that happens to be all digits', () => {
    // Yealink's shared boot file is named like y000000000028.cfg — 13 chars including
    // the leading "y", not a MAC, and must not be misidentified as one.
    expect(extractMacAddress('/y000000000028.cfg', '')).toBeNull();
  });

  it('does not treat the Poly all-zero master config name as a MAC', () => {
    expect(extractMacAddress('/000000000000.cfg', '')).toBeNull();
  });

  it('returns null when no MAC is present anywhere', () => {
    expect(extractMacAddress('/unknown.cfg', '')).toBeNull();
  });
});
