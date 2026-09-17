import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto.ts';

// 32 random bytes, base64-encoded — same shape as a real `wrangler secret put ENCRYPTION_KEY` value.
const TEST_KEY = 'l7GJ2Q6f1n9mYkX3wZ4pC8dT5rV0sB1eH2iJ6kL9mN0=';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a plaintext secret', async () => {
    const encrypted = await encryptSecret('super-secret-client-secret', TEST_KEY);
    const decrypted = await decryptSecret(encrypted, TEST_KEY);
    expect(decrypted).toBe('super-secret-client-secret');
  });

  it('produces different ciphertext for the same plaintext each time', async () => {
    const first = await encryptSecret('same-plaintext', TEST_KEY);
    const second = await encryptSecret('same-plaintext', TEST_KEY);
    expect(first).not.toBe(second);
  });

  it('fails to decrypt with the wrong key', async () => {
    const encrypted = await encryptSecret('secret', TEST_KEY);
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await expect(decryptSecret(encrypted, otherKey)).rejects.toThrow();
  });
});
