import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildSeedSql } from '../src/fleet.ts';
import { guessVendor, isValidZoomUrl, listProfiles, refreshProfiles, saveProfile } from '../src/profiles.ts';

async function seedFleet() {
  await env.DB.exec(
    buildSeedSql(
      [
        { macAddress: '80:5E:C0:00:00:01', rcDeviceId: '1', name: 'A', extension: null, model: 'Yealink T48S', rcStatus: null },
        { macAddress: '80:5E:C0:00:00:02', rcDeviceId: '2', name: 'B', extension: null, model: 'Yealink T48S', rcStatus: null },
        { macAddress: '64:16:7F:00:00:03', rcDeviceId: '3', name: 'C', extension: null, model: 'Polycom VVX411', rcStatus: null },
        { macAddress: '9C:AD:EF:00:00:04', rcDeviceId: '4', name: 'D', extension: null, model: 'Polycom OBi302', rcStatus: null },
        { macAddress: '9C:AD:EF:00:00:05', rcDeviceId: '5', name: 'E', extension: null, model: null, rcStatus: null },
      ],
      '2026-09-17T00:00:00.000Z',
    ),
  );
}

describe('guessVendor', () => {
  it('maps model strings to vendors', () => {
    expect(guessVendor('Yealink T48S')).toBe('yealink');
    expect(guessVendor('Yealink T48U Ultra-elegant Gigabit IP Phone')).toBe('yealink');
    expect(guessVendor('Polycom VVX411')).toBe('poly');
    expect(guessVendor('Polycom IP 5000 Conference Phone')).toBe('poly');
    expect(guessVendor('Polycom OBi302')).toBe('other');
    expect(guessVendor('Cisco SPA-122 ATA')).toBe('other');
  });
});

describe('isValidZoomUrl', () => {
  it('accepts only https URLs', () => {
    expect(isValidZoomUrl('https://provpp.zoom.us/api/v2/pbx/provisioning/yealink/t48s/')).toBe(true);
    expect(isValidZoomUrl('http://provpp.zoom.us/x')).toBe(false);
    expect(isValidZoomUrl('provpp.zoom.us/x')).toBe(false);
    expect(isValidZoomUrl('')).toBe(false);
  });

  it('rejects control and whitespace characters that new URL() would silently strip', () => {
    expect(isValidZoomUrl('https://provpp.zoom.us/x\r\nevil')).toBe(false);
    expect(isValidZoomUrl('https://provpp.zoom.us/x y')).toBe(false);
  });
});

describe('refreshProfiles / listProfiles / saveProfile', () => {
  it('creates one disabled profile per distinct expected model with a device count', async () => {
    await seedFleet();
    expect(await refreshProfiles(env.DB, '2026-09-17T00:00:00.000Z')).toBe(3);
    expect(await refreshProfiles(env.DB, '2026-09-17T00:00:00.000Z')).toBe(0);

    const profiles = await listProfiles(env.DB);
    expect(profiles.map((p) => [p.model, p.vendor, p.deviceCount, p.enabled, p.zoomUrl])).toEqual([
      ['Polycom OBi302', 'other', 1, false, null],
      ['Polycom VVX411', 'poly', 1, false, null],
      ['Yealink T48S', 'yealink', 2, false, null],
    ]);
  });

  it('saves vendor, url, and enabled for an existing model and keeps the count', async () => {
    await seedFleet();
    await refreshProfiles(env.DB, '2026-09-17T00:00:00.000Z');
    await saveProfile(env.DB, { model: 'Yealink T48S', vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true }, '2026-09-17T01:00:00.000Z');

    const t48s = (await listProfiles(env.DB)).find((p) => p.model === 'Yealink T48S');
    expect(t48s).toEqual({ model: 'Yealink T48S', vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true, deviceCount: 2, updatedAt: '2026-09-17T01:00:00.000Z' });
  });

  it('ignores saves for models that have no profile row', async () => {
    await saveProfile(env.DB, { model: 'Nope', vendor: 'other', zoomUrl: null, enabled: false }, '2026-09-17T01:00:00.000Z');
    expect(await listProfiles(env.DB)).toEqual([]);
  });
});
