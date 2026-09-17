import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SETTING, setSetting } from '../src/db.ts';
import { buildSeedSql } from '../src/fleet.ts';
import { refreshProfiles, saveProfile } from '../src/profiles.ts';
import { replaceZoomDevices } from '../src/zoom.ts';
import { classifyRequest, decideResponse, loadServeContext, type ServeContext } from '../src/serve.ts';

describe('classifyRequest', () => {
  it('recognizes the per-MAC files and nothing else', () => {
    expect(classifyRequest('/805ec0aabbcc.cfg')).toEqual({ type: 'mac_cfg', mac: '80:5E:C0:AA:BB:CC', macLower: '805ec0aabbcc' });
    expect(classifyRequest('/805EC0AABBCC.cfg')).toEqual({ type: 'mac_cfg', mac: '80:5E:C0:AA:BB:CC', macLower: '805ec0aabbcc' });
    expect(classifyRequest('/805ec0aabbcc-zoom.cfg')).toEqual({ type: 'poly_device_cfg', mac: '80:5E:C0:AA:BB:CC', macLower: '805ec0aabbcc' });
    for (const p of ['/y000000000065.cfg', '/000000000000.cfg', '/805ec0aabbcc-phone.cfg', '/805ec0aabbcc.boot', '/', '/dir/805ec0aabbcc.cfg']) {
      expect(classifyRequest(p)).toEqual({ type: 'other', mac: null, macLower: null });
    }
  });
});

const ready: ServeContext = {
  servingEnabled: true,
  expectedModel: 'Yealink T48S',
  inZoom: true,
  profile: { vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true },
};
const macCfg = classifyRequest('/805ec0aabbcc.cfg');
const polyCfg = classifyRequest('/64167f4b6be7-zoom.cfg');

describe('decideResponse', () => {
  it('accepts PUT/POST uploads with 200 regardless of anything else', () => {
    expect(decideResponse('PUT', classifyRequest('/64167f4b6be7-phone.cfg'), null)).toMatchObject({ status: 200, kind: 'accepted', reason: 'upload', body: '' });
    expect(decideResponse('POST', macCfg, null)).toMatchObject({ status: 200, kind: 'accepted' });
  });

  it('404s unknown files and unsupported methods', () => {
    expect(decideResponse('GET', classifyRequest('/y000000000065.cfg'), null)).toMatchObject({ status: 404, kind: 'not_found', reason: 'unknown-file' });
    expect(decideResponse('DELETE', macCfg, ready)).toMatchObject({ status: 404, kind: 'not_found', reason: 'unsupported-method' });
  });

  it('serves the Yealink redirect when everything lines up', () => {
    const d = decideResponse('GET', macCfg, ready);
    expect(d).toMatchObject({ status: 200, kind: 'redirect', reason: null, contentType: 'text/plain' });
    expect(d.body).toContain('static.auto_provision.server.url = https://provpp.zoom.us/y/');
  });

  it('serves both Poly files', () => {
    const poly: ServeContext = { ...ready, expectedModel: 'Polycom VVX411', profile: { vendor: 'poly', zoomUrl: 'https://provpp.zoom.us/p/', enabled: true } };
    const master = decideResponse('GET', classifyRequest('/64167f4b6be7.cfg'), poly);
    expect(master).toMatchObject({ status: 200, kind: 'redirect', contentType: 'application/xml' });
    expect(master.body).toContain('CONFIG_FILES="64167f4b6be7-zoom.cfg"');
    const device = decideResponse('GET', polyCfg, poly);
    expect(device.body).toContain('device.prov.serverName="provpp.zoom.us/p/"');
  });

  it('gives each gate its own reason, in order', () => {
    const cases: [Partial<ServeContext> | null, string][] = [
      [{ servingEnabled: false }, 'serving-off'],
      [{ expectedModel: null }, 'not-expected'],
      [{ inZoom: false }, 'not-in-zoom'],
      [{ profile: null }, 'no-profile'],
      [{ profile: { ...ready.profile!, enabled: false } }, 'profile-disabled'],
      [{ profile: { ...ready.profile!, zoomUrl: null } }, 'no-zoom-url'],
      [{ profile: { ...ready.profile!, vendor: 'other' } }, 'vendor-other'],
    ];
    for (const [override, reason] of cases) {
      const d = decideResponse('GET', macCfg, { ...ready, ...override });
      expect(d, reason).toMatchObject({ status: 404, kind: 'not_found', reason, body: '' });
    }
    expect(decideResponse('GET', macCfg, { servingEnabled: true, expectedModel: null, inZoom: false, profile: null })).toMatchObject({ status: 404, reason: 'not-expected' });
  });

  it('does not serve the Poly device file to a Yealink profile', () => {
    expect(decideResponse('GET', polyCfg, ready)).toMatchObject({ status: 404, reason: 'unknown-file' });
  });

  it('answers HEAD like GET but with an empty body', () => {
    expect(decideResponse('HEAD', macCfg, ready)).toMatchObject({ status: 200, kind: 'redirect', body: '' });
  });

  it('degrades to a logged 404 instead of throwing when the stored zoomUrl is malformed', () => {
    const bad: ServeContext = { ...ready, profile: { ...ready.profile!, zoomUrl: 'https://x/\nstatic.security.user_password = pwn' } };
    expect(decideResponse('GET', macCfg, bad)).toEqual({ status: 404, kind: 'not_found', reason: 'bad-zoom-url', body: '', contentType: 'text/plain' });
  });
});

describe('loadServeContext', () => {
  it('joins the expected device, the Zoom mirror, the profile, and the switch', async () => {
    await env.DB.exec(buildSeedSql([{ macAddress: '80:5E:C0:AA:BB:CC', rcDeviceId: '1', name: 'A', extension: null, model: 'Yealink T48S', rcStatus: null }], 't'));
    await refreshProfiles(env.DB, 't');
    await saveProfile(env.DB, { model: 'Yealink T48S', vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true }, 't');
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:AA:BB:CC', zoomDeviceId: 'z', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    await setSetting(env.DB, SETTING.servingEnabled, '1');

    expect(await loadServeContext(env.DB, '80:5E:C0:AA:BB:CC')).toEqual(ready);
    expect(await loadServeContext(env.DB, '80:5E:C0:00:00:00')).toEqual({ servingEnabled: true, expectedModel: null, inZoom: false, profile: null });
  });
});
