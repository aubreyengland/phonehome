/** IPv4/IPv6 allowlist matching. Addresses are compared as BigInts under a prefix mask. */

export type IpFamily = 4 | 6;

export interface ParsedIp {
  family: IpFamily;
  value: bigint;
}

export interface AllowEntry {
  text: string;
  family: IpFamily;
  network: bigint;
  prefix: number;
}

export interface AllowlistParseResult {
  entries: AllowEntry[];
  errors: { line: number; text: string; reason: string }[];
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(text: string): bigint | null {
  const m = text.match(IPV4_RE);
  if (!m) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (text.includes(':::') || text.split('::').length > 2) return null;
  // Expand an embedded dotted quad (e.g. ::ffff:1.2.3.4) into two hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [headText, tailText] = text.split('::') as [string, string | undefined];
  const head = headText === '' ? [] : headText.split(':');
  const rest = tailText === undefined ? [] : tailText === '' ? [] : tailText.split(':');
  const missing = 8 - head.length - rest.length;
  if (tailText === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(tailText === undefined ? 0 : missing).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

const V4_MAPPED_PREFIX = 0xffffn; // ::ffff:a.b.c.d has the upper 96 bits == 0x0000...ffff

/** Parses a bare address. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is returned as IPv4. */
export function parseIp(text: string): ParsedIp | null {
  if (text !== text.trim() || text === '') return null;
  const v4 = parseIpv4(text);
  if (v4 !== null) return { family: 4, value: v4 };
  if (!text.includes(':')) return null;
  const v6 = parseIpv6(text);
  if (v6 === null) return null;
  if (v6 >> 32n === V4_MAPPED_PREFIX) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

function maskFor(family: IpFamily, prefix: number): bigint {
  const bits = family === 4 ? 32 : 128;
  return prefix === 0 ? 0n : ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
}

function parseEntry(text: string): { entry?: AllowEntry; reason?: string } {
  const slash = text.indexOf('/');
  const ipText = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? null : text.slice(slash + 1);
  const ip = parseIp(ipText);
  if (!ip || (prefixText !== null && !/^\d{1,3}$/.test(prefixText))) {
    return { reason: 'not an IP address or CIDR' };
  }
  const bits = ip.family === 4 ? 32 : 128;
  // A mapped IPv4 written with an IPv6 prefix (e.g. ::ffff:10.0.0.0/104) is re-based to IPv4.
  const rawPrefix = prefixText === null ? bits : Number(prefixText);
  const prefix = ip.family === 4 && ipText.includes(':') && prefixText !== null ? rawPrefix - 96 : rawPrefix;
  if (prefix < 0 || prefix > bits) {
    return { reason: `prefix must be 0-${ip.family === 4 && ipText.includes(':') ? 128 : bits}` };
  }
  return { entry: { text, family: ip.family, network: ip.value & maskFor(ip.family, prefix), prefix } };
}

/** One entry per line or comma; `#` starts a comment. Bad lines are reported, good ones kept. */
export function parseAllowlist(text: string): AllowlistParseResult {
  const result: AllowlistParseResult = { entries: [], errors: [] };
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/#.*$/, '');
    for (const piece of line.split(',')) {
      const item = piece.trim();
      if (!item) continue;
      const { entry, reason } = parseEntry(item);
      if (entry) result.entries.push(entry);
      else result.errors.push({ line: index + 1, text: item, reason: reason! });
    }
  });
  return result;
}

export function ipAllowed(ip: string | null, entries: AllowEntry[]): boolean {
  if (!ip) return false;
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return entries.some((e) => e.family === parsed.family && (parsed.value & maskFor(e.family, e.prefix)) === e.network);
}
