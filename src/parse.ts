import type { ParsedDevice } from './types.ts';

const MAC_HEX_RE = /^[0-9a-fA-F]{12}$/;
const ALL_ZERO_MAC = '00:00:00:00:00:00';

/**
 * Normalizes a MAC in bare (`aabbccddeeff`), colon, or dash form to
 * `AA:BB:CC:DD:EE:FF`. Returns null when the input is not exactly 12 hex digits.
 */
export function normalizeMac(raw: string): string | null {
  const hex = raw.replace(/[:-]/g, '');
  if (!MAC_HEX_RE.test(hex)) {
    return null;
  }
  return hex.toUpperCase().match(/.{2}/g)!.join(':');
}

function candidateToMac(candidate: string): string | null {
  const mac = normalizeMac(candidate);
  // Poly phones request a shared `000000000000.cfg` master file — not a device.
  return mac === ALL_ZERO_MAC ? null : mac;
}

export function extractMacAddress(path: string, query: string): string | null {
  const queryMac = new URLSearchParams(query).get('mac');
  if (queryMac) {
    const mac = candidateToMac(queryMac);
    if (mac) {
      return mac;
    }
  }

  const filename = path.split('/').pop() ?? '';
  const basename = filename.replace(/\.[^.]+$/, '');
  // Poly per-phone files carry a suffix: `{mac}-phone.cfg`, `{mac}-directory.xml`, ...
  const prefix = basename.split('-')[0] ?? '';
  return candidateToMac(prefix);
}


export interface ParsedUserAgent {
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
}

const NO_USER_AGENT: ParsedUserAgent = { manufacturer: null, model: null, firmware: null };

export function parseUserAgent(userAgent: string | null): ParsedUserAgent {
  if (!userAgent) {
    return NO_USER_AGENT;
  }

  if (/yealink/i.test(userAgent)) {
    const modelMatch = userAgent.match(/Yealink\s+([A-Za-z0-9-]+)/i);
    const firmwareMatch = userAgent.match(/(\d+\.\d+\.\d+\.\d+)/);
    return {
      manufacturer: 'Yealink',
      model: modelMatch ? modelMatch[1] : null,
      firmware: firmwareMatch ? firmwareMatch[1] : null,
    };
  }

  if (/poly(com)?/i.test(userAgent)) {
    const modelMatch = userAgent.match(/VVX[\s_-]?(\d{3})/i);
    const firmwareMatch = userAgent.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
    return {
      manufacturer: 'Poly',
      model: modelMatch ? `VVX ${modelMatch[1]}` : null,
      firmware: firmwareMatch ? firmwareMatch[1] : null,
    };
  }

  return NO_USER_AGENT;
}

const UA_MAC_RE = /\b([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/i;

function macFromUserAgent(userAgent: string | null): string | null {
  const match = userAgent?.match(UA_MAC_RE);
  return match ? candidateToMac(match[1]) : null;
}

export function parseDevice(path: string, query: string, userAgent: string | null): ParsedDevice {
  const { manufacturer, model, firmware } = parseUserAgent(userAgent);
  const macAddress = extractMacAddress(path, query) ?? macFromUserAgent(userAgent);
  return { manufacturer, model, firmware, macAddress };
}
