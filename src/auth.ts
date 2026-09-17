function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

export function checkBasicAuth(request: Request, expectedUser: string, expectedPassword: string): boolean {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Basic ')) {
    return false;
  }

  let decoded: string;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return false;
  }

  const user = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  // Evaluate both so a wrong username doesn't short-circuit before the password check.
  const userOk = timingSafeEqual(user, expectedUser);
  const passwordOk = timingSafeEqual(password, expectedPassword);
  return userOk && passwordOk;
}

export function unauthorizedResponse(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="admin"' },
  });
}
