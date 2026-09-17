import { describe, expect, it } from 'vitest';
import { ipAllowed, parseAllowlist, parseIp } from '../src/ipallow.ts';

describe('parseIp', () => {
  it('parses IPv4 and IPv6, including :: compression and embedded dotted quads', () => {
    expect(parseIp('192.168.1.10')).toEqual({ family: 4, value: 3232235786n });
    expect(parseIp('::1')).toEqual({ family: 6, value: 1n });
    expect(parseIp('2001:db8::1')?.value).toBe(0x20010db8000000000000000000000001n);
    expect(parseIp('::ffff:192.168.1.10')).toEqual({ family: 4, value: 3232235786n });
  });

  it('rejects garbage', () => {
    for (const bad of ['', '1.2.3', '1.2.3.256', '1.2.3.4.5', 'abc', '2001:db8:::1', '2001:db8::zz', '1.2.3.4/24', ' 1.2.3.4']) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });
});

describe('parseAllowlist', () => {
  it('accepts one entry per line, comments, blank lines, and commas', () => {
    const result = parseAllowlist('# office\n203.0.113.5\n203.0.113.0/24, 2001:db8::/32\n\n  198.51.100.7  \n');
    expect(result.errors).toEqual([]);
    expect(result.entries.map((e) => `${e.text}`)).toEqual(['203.0.113.5', '203.0.113.0/24', '2001:db8::/32', '198.51.100.7']);
    expect(result.entries.map((e) => e.prefix)).toEqual([32, 24, 32, 32]);
  });

  it('reports every bad line with its line number and keeps the good ones', () => {
    const result = parseAllowlist('203.0.113.5\nnope\n10.0.0.0/33\n2001:db8::/129\n1.2.3.4/-1');
    expect(result.entries.map((e) => e.text)).toEqual(['203.0.113.5']);
    expect(result.errors).toEqual([
      { line: 2, text: 'nope', reason: 'not an IP address or CIDR' },
      { line: 3, text: '10.0.0.0/33', reason: 'prefix must be 0-32' },
      { line: 4, text: '2001:db8::/129', reason: 'prefix must be 0-128' },
      { line: 5, text: '1.2.3.4/-1', reason: 'not an IP address or CIDR' },
    ]);
  });

  it('returns no entries for an empty or comment-only list', () => {
    expect(parseAllowlist('')).toEqual({ entries: [], errors: [] });
    expect(parseAllowlist('# nothing yet\n')).toEqual({ entries: [], errors: [] });
  });
});

describe('ipAllowed', () => {
  const list = parseAllowlist('203.0.113.0/24\n198.51.100.7\n2001:db8:abcd::/48\n::ffff:10.0.0.0/104').entries;

  it('matches exact hosts and CIDR ranges, per family', () => {
    expect(ipAllowed('203.0.113.1', list)).toBe(true);
    expect(ipAllowed('203.0.113.255', list)).toBe(true);
    expect(ipAllowed('203.0.114.1', list)).toBe(false);
    expect(ipAllowed('198.51.100.7', list)).toBe(true);
    expect(ipAllowed('198.51.100.8', list)).toBe(false);
    expect(ipAllowed('2001:db8:abcd:1::9', list)).toBe(true);
    expect(ipAllowed('2001:db8:abce::1', list)).toBe(false);
    expect(ipAllowed('10.0.0.5', list)).toBe(true); // via the ::ffff: mapped range
  });

  it('never matches an unparseable or missing IP, and an empty list matches nothing', () => {
    expect(ipAllowed('garbage', list)).toBe(false);
    expect(ipAllowed(null, list)).toBe(false);
    expect(ipAllowed('203.0.113.1', [])).toBe(false);
  });

  it('treats /0 as everything in that family', () => {
    const any4 = parseAllowlist('0.0.0.0/0').entries;
    expect(ipAllowed('8.8.8.8', any4)).toBe(true);
    expect(ipAllowed('2001:db8::1', any4)).toBe(false);
  });
});
