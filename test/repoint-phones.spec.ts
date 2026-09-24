import { describe, expect, it } from 'vitest';
import { mapLimit, parseTargets, selectBatch, setProvisioningUrl, summarize } from '../scripts/repoint-phones.ts';

describe('parseTargets', () => {
  it('reads a mac,ip lease export', () => {
    const { targets, errors } = parseTargets('80:5e:0c:1f:0d:d7,10.20.30.41\n80:5e:0c:1e:9c:cd,10.20.30.42\n');
    expect(errors).toEqual([]);
    expect(targets).toEqual([
      { ip: '10.20.30.41', mac: '80:5E:0C:1F:0D:D7' },
      { ip: '10.20.30.42', mac: '80:5E:0C:1E:9C:CD' },
    ]);
  });

  it('accepts either column order and bare hex MACs', () => {
    const { targets } = parseTargets('10.20.30.41,805e0c1f0dd7');
    expect(targets).toEqual([{ ip: '10.20.30.41', mac: '80:5E:0C:1F:0D:D7' }]);
  });

  it('accepts a bare IP with no MAC', () => {
    expect(parseTargets('10.20.30.41').targets).toEqual([{ ip: '10.20.30.41', mac: null }]);
  });

  it('skips blank lines, comments, and a header row', () => {
    const { targets, errors } = parseTargets('MAC Address,IP Address\n\n# site A\n80:5e:0c:1f:0d:d7,10.20.30.41\n');
    expect(errors).toEqual([]);
    expect(targets).toEqual([{ ip: '10.20.30.41', mac: '80:5E:0C:1F:0D:D7' }]);
  });

  it('collapses a duplicate IP so one phone is never pushed to twice', () => {
    const { targets } = parseTargets('10.20.30.41,805e0c1f0dd7\n10.20.30.41,805e0c1f0dd7\n');
    expect(targets).toHaveLength(1);
  });

  // A dropped phone must be visible. Silently skipping a malformed lease line would leave
  // a phone un-migrated with nothing in the report to explain why.
  it('reports an unparseable line instead of dropping it silently', () => {
    const { targets, errors } = parseTargets('80:5e:0c:1f:0d:d7,10.20.30.41\nnot-a-phone\n');
    expect(targets).toHaveLength(1);
    expect(errors).toEqual([{ line: 2, text: 'not-a-phone' }]);
  });

  it('rejects an octet above 255 rather than treating it as an address', () => {
    expect(parseTargets('10.20.30.999').errors).toHaveLength(1);
  });
});

describe('selectBatch', () => {
  const targets = [
    { ip: '10.0.0.1', mac: null },
    { ip: '10.0.0.2', mac: null },
    { ip: '10.0.0.3', mac: null },
  ];

  it('limits the batch for a staged rollout', () => {
    expect(selectBatch(targets, 2)).toHaveLength(2);
  });

  it('treats a limit of 0 as the whole fleet', () => {
    expect(selectBatch(targets, 0)).toHaveLength(3);
  });
});

describe('summarize', () => {
  it('counts successes and failures and names every phone', () => {
    const summary = summarize([
      { target: { ip: '10.0.0.1', mac: '80:5E:0C:1F:0D:D7' }, ok: true, detail: 'url set' },
      { target: { ip: '10.0.0.2', mac: null }, ok: false, detail: 'HTTP 401' },
    ]);
    expect(summary.ok).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.lines[0]).toContain('10.0.0.1');
    expect(summary.lines[0]).toContain('80:5E:0C:1F:0D:D7');
    expect(summary.lines[1]).toContain('HTTP 401');
    expect(summary.lines[1]).toContain('FAIL');
  });
});

describe('mapLimit', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapLimit([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });
    expect(peak).toBe(2);
  });
});

describe('setProvisioningUrl', () => {
  // The web UI endpoint differs across Yealink firmware and Yealink does not publish it.
  // Refusing to run is the correct behaviour until it is captured from a real phone: a
  // half-guessed request sent to 349 phones is far worse than a tool that stops.
  it('refuses to run until it has been calibrated against a real phone', async () => {
    await expect(
      setProvisioningUrl({ ip: '10.0.0.1', mac: null }, { user: 'admin', password: 'x' }, 'https://example.com'),
    ).rejects.toThrow(/not calibrated/i);
  });
});
