import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/dashboard.ts';
import type { FleetRow } from '../src/db.ts';

const seen: FleetRow = {
  macAddress: '80:5E:C0:00:00:01',
  status: 'seen',
  expectedName: 'Jessie Christy',
  expectedExtension: '53265',
  expectedModel: 'Yealink T48S',
  rcStatus: 'Online',
  manufacturer: 'Yealink',
  model: 'SIP-T48S',
  firmware: '66.86.0.15',
  sourceIp: '203.0.113.5',
  lastSeenAt: '2026-09-17T01:00:00.000Z',
  checkInCount: 2,
};
const notSeen: FleetRow = {
  ...seen,
  macAddress: '80:5E:C0:00:00:02',
  status: 'not-seen',
  expectedName: 'Quiet Phone',
  manufacturer: null,
  model: null,
  firmware: null,
  sourceIp: null,
  lastSeenAt: null,
  checkInCount: 0,
};
const unexpected: FleetRow = {
  ...seen,
  macAddress: 'AA:AA:AA:00:00:03',
  status: 'unexpected',
  expectedName: null,
  expectedExtension: null,
  expectedModel: null,
  rcStatus: null,
  checkInCount: 1,
};
const rows = [seen, notSeen, unexpected];

describe('renderDashboard', () => {
  it('includes each field of a seen device', () => {
    const html = renderDashboard([seen], 'all', null);
    for (const value of ['80:5E:C0:00:00:01', 'Jessie Christy', '53265', 'Yealink T48S', 'SIP-T48S', '66.86.0.15', '203.0.113.5', '2026-09-17T01:00:00.000Z']) {
      expect(html).toContain(value);
    }
  });

  it('shows summary counts over the full fleet regardless of filter', () => {
    const html = renderDashboard(rows, 'unexpected', null);
    expect(html).toMatch(/Expected[^0-9]*2/);
    expect(html).toMatch(/Seen[^0-9]*1/);
    expect(html).toMatch(/Not seen[^0-9]*1/);
    expect(html).toMatch(/Unexpected[^0-9]*1/);
  });

  it('filters rows by status', () => {
    const html = renderDashboard(rows, 'not-seen', null);
    expect(html).toContain('Quiet Phone');
    expect(html).not.toContain('Jessie Christy');
    expect(html).not.toContain('AA:AA:AA:00:00:03');
  });

  it('links each status filter', () => {
    const html = renderDashboard(rows, 'all', null);
    for (const status of ['all', 'seen', 'not-seen', 'unexpected']) {
      expect(html).toContain(`href="/admin?status=${status}"`);
    }
  });

  it('renders a settings form for Zoom S2S credentials and never echoes the secret', () => {
    const html = renderDashboard([], 'all', {
      clientId: 'client-123',
      clientSecretEncrypted: 'CIPHERTEXT',
      accountId: 'account-456',
      updatedAt: '2026-09-17T00:00:00.000Z',
    });
    expect(html).toContain('action="/admin/settings"');
    expect(html).toContain('name="clientId"');
    expect(html).toContain('name="clientSecret"');
    expect(html).toContain('name="accountId"');
    expect(html).toContain('client-123');
    expect(html).toContain('account-456');
    expect(html).not.toContain('CIPHERTEXT');
  });

  it('escapes HTML in device fields', () => {
    const malicious: FleetRow = { ...seen, expectedName: '<script>alert(1)</script>' };
    const html = renderDashboard([malicious], 'all', null);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
