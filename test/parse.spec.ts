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

import { parseDevice, parseUserAgent } from '../src/parse.ts';

describe('parseUserAgent', () => {
  it('parses a Yealink User-Agent', () => {
    expect(parseUserAgent('Yealink SIP-T48U 66.85.0.15')).toEqual({
      manufacturer: 'Yealink',
      model: 'SIP-T48U',
      firmware: '66.85.0.15',
    });
  });

  it('parses a Yealink T48S User-Agent that carries the MAC', () => {
    expect(parseUserAgent('Yealink SIP-T48S 66.86.0.15 80:5e:c0:aa:bb:cc')).toEqual({
      manufacturer: 'Yealink',
      model: 'SIP-T48S',
      firmware: '66.86.0.15',
    });
  });

  it('parses a Poly VVX User-Agent (plan placeholder shape)', () => {
    expect(parseUserAgent('PolycomSoundPointIPPhone/VVX_411-UA/6.4.7.1181')).toEqual({
      manufacturer: 'Poly',
      model: 'VVX 411',
      firmware: '6.4.7.1181',
    });
  });

  it('parses a Poly UCS FileTransport User-Agent', () => {
    expect(parseUserAgent('FileTransport PolycomVVX-VVX_311-UA/5.9.6.2327 Type/Application')).toEqual({
      manufacturer: 'Poly',
      model: 'VVX 311',
      firmware: '5.9.6.2327',
    });
  });

  it('returns all nulls for an unrecognized or missing User-Agent', () => {
    expect(parseUserAgent('Mozilla/5.0 unknown device')).toEqual({
      manufacturer: null,
      model: null,
      firmware: null,
    });
    expect(parseUserAgent(null)).toEqual({ manufacturer: null, model: null, firmware: null });
  });
});

describe('parseDevice', () => {
  it('combines MAC extraction and User-Agent parsing', () => {
    expect(parseDevice('/aabbccddeeff.cfg', '', 'Yealink SIP-T48U 66.85.0.15')).toEqual({
      manufacturer: 'Yealink',
      model: 'SIP-T48U',
      firmware: '66.85.0.15',
      macAddress: 'AA:BB:CC:DD:EE:FF',
    });
  });

  it('falls back to the MAC embedded in a Yealink User-Agent', () => {
    expect(parseDevice('/y000000000028.cfg', '', 'Yealink SIP-T48S 66.86.0.15 80:5e:c0:aa:bb:cc')).toEqual({
      manufacturer: 'Yealink',
      model: 'SIP-T48S',
      firmware: '66.86.0.15',
      macAddress: '80:5E:C0:AA:BB:CC',
    });
  });

  it('prefers the path MAC over the User-Agent MAC', () => {
    const device = parseDevice('/aabbccddeeff.cfg', '', 'Yealink SIP-T48S 66.86.0.15 80:5e:c0:aa:bb:cc');
    expect(device.macAddress).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('returns null MAC when nothing carries one', () => {
    expect(parseDevice('/000000000000.cfg', '', 'FileTransport PolycomVVX-VVX_411-UA/6.4.7.1181').macAddress).toBeNull();
  });
});
