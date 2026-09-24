/**
 * Bulk-repoint Yealink phones at this provisioning server, over each phone's web interface.
 *
 * Why this exists: RingCentral's build sets `static.auto_provision.dhcp_option.enable = 0` and
 * `pnp_enable = 0`, so DHCP option 66 and PnP can never reach these phones. The only remaining
 * remote channel is each phone's own web UI, which is reachable across the voice VLAN.
 *
 * What it changes on a phone: the provisioning server URL, and nothing else. SIP accounts, line
 * keys, and every other setting are untouched. A phone that fails keeps working on RingCentral,
 * so a bad run is re-runnable rather than destructive.
 *
 * Why it points phones here rather than straight at Zoom: one identical value for all 349 phones,
 * and this server then resolves the correct per-model Zoom URL, clears the stale RingCentral
 * provisioning credentials, and logs the check-in so the fleet page shows real progress. If a
 * model's Zoom URL turns out wrong, it is fixed here instead of re-pushing to hundreds of phones.
 *
 * No provisioning trigger is sent. RingCentral leaves `repeat.enable = 1` at 180 minutes, so once
 * the URL is changed every phone arrives here on its own within three hours, naturally staggered,
 * with no reboot during business hours.
 *
 * Usage:
 *   PHONE_ADMIN_USER=admin PHONE_ADMIN_PASSWORD=... \
 *     node scripts/repoint-phones.ts --file leases.csv --limit 1
 *   ...add --apply once a dry run looks right.
 */

export interface PhoneTarget {
  ip: string;
  mac: string | null;
}

export interface RepointResult {
  target: PhoneTarget;
  ok: boolean;
  detail: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(text: string): boolean {
  const m = text.match(IPV4);
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

function normalizeMac(raw: string): string | null {
  const hex = raw.replace(/[:\-.]/g, '');
  return /^[0-9a-fA-F]{12}$/.test(hex) ? hex.toUpperCase().match(/.{2}/g)!.join(':') : null;
}

/**
 * Accepts a CSV of `ip` or `mac,ip` or `ip,mac` in any column order, one phone per line.
 * Blank lines and `#` comments are skipped. A header line is detected and ignored.
 * Unparseable lines are reported rather than silently dropped, and duplicate IPs collapse
 * to one target so a re-exported lease table cannot double-push to the same phone.
 */
export function parseTargets(text: string): { targets: PhoneTarget[]; errors: { line: number; text: string }[] } {
  const targets: PhoneTarget[] = [];
  const errors: { line: number; text: string }[] = [];
  const seen = new Set<string>();

  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;

    const fields = line.split(/[,;\t]/).map((f) => f.trim().replace(/^"|"$/g, ''));
    const ip = fields.find(isIpv4);
    const mac = fields.map(normalizeMac).find((m): m is string => m !== null) ?? null;

    if (!ip) {
      // A header row names its columns and carries no address; not an error worth reporting.
      if (!(index === 0 && /\b(ip|address|mac|hardware)\b/i.test(line))) {
        errors.push({ line: index + 1, text: line });
      }
      return;
    }
    if (seen.has(ip)) return;
    seen.add(ip);
    targets.push({ ip, mac });
  });

  return { targets, errors };
}

/** Staged rollout: prove it on one phone, then ten, then the rest. `limit` of 0 means everything. */
export function selectBatch(targets: PhoneTarget[], limit: number): PhoneTarget[] {
  return limit > 0 ? targets.slice(0, limit) : targets;
}

export function summarize(results: RepointResult[]): { ok: number; failed: number; lines: string[] } {
  const ok = results.filter((r) => r.ok).length;
  const lines = results.map((r) => {
    const status = r.ok ? 'ok  ' : 'FAIL';
    return `${status} ${r.target.ip.padEnd(15)} ${r.target.mac ?? '-'} ${r.detail}`;
  });
  return { ok, failed: results.length - ok, lines };
}

/** Runs `worker` over `items` with at most `concurrency` in flight, preserving input order. */
export async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

/**
 * CALIBRATION REQUIRED — deliberately throws until the real request is filled in.
 *
 * Yealink does not publish the web UI form endpoint, and it differs across firmware. Capture it
 * once from a real phone (browser devtools, Network tab, perform the change by hand, then Copy as
 * cURL) and translate it here. Leaving this unimplemented is intentional: a half-guessed request
 * sent to 349 phones is far worse than a tool that refuses to run.
 */
export async function setProvisioningUrl(
  _target: PhoneTarget,
  _creds: { user: string; password: string },
  _provisioningUrl: string,
): Promise<RepointResult> {
  throw new Error(
    'setProvisioningUrl is not calibrated yet. Capture the web UI request from one phone ' +
      '(devtools > Network > Copy as cURL) and implement it here before running with --apply.',
  );
}
