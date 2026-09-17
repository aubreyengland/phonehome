import { describe, expect, it } from 'vitest';
import { checkBasicAuth, unauthorizedResponse } from '../src/auth.ts';

function basicAuthHeader(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

describe('checkBasicAuth', () => {
  it('accepts correct credentials', () => {
    const request = new Request('https://example.com/admin', {
      headers: { Authorization: basicAuthHeader('admin', 'secret') },
    });
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(true);
  });

  it('rejects incorrect credentials', () => {
    const request = new Request('https://example.com/admin', {
      headers: { Authorization: basicAuthHeader('admin', 'wrong') },
    });
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    const request = new Request('https://example.com/admin');
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(false);
  });

  it('rejects a malformed Authorization header', () => {
    const request = new Request('https://example.com/admin', {
      headers: { Authorization: 'Bearer sometoken' },
    });
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(false);
  });

  it('rejects invalid base64', () => {
    const request = new Request('https://example.com/admin', {
      headers: { Authorization: 'Basic %%%not-base64%%%' },
    });
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(false);
  });
});

describe('unauthorizedResponse', () => {
  it('returns 401 with a WWW-Authenticate header', () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic');
  });
});
