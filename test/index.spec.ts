import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('provisioning capture endpoint', () => {
  it('responds 200 with an empty body for any path', async () => {
    const response = await SELF.fetch('https://example.com/aabbccddeeff.cfg');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toBe('text/plain');
  });
});
