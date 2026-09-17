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
