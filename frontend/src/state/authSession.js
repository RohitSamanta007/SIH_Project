export const SESSION_EXPIRED_EVENT = 'auth:session-expired';

export function clearStoredAuthSession() {
  sessionStorage.removeItem('auth_token');
  sessionStorage.removeItem('auth_user');
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export function isJwtExpired(token, now = Date.now()) {
  const payload = decodeJwtPayload(token);
  return !payload || typeof payload.exp !== 'number' || now >= payload.exp * 1000;
}

export function getStoredAuthSession() {
  const token = sessionStorage.getItem('auth_token');
  if (!token || isJwtExpired(token)) {
    clearStoredAuthSession();
    return { token: null, user: null };
  }

  try {
    const storedUser = sessionStorage.getItem('auth_user');
    return { token, user: storedUser ? JSON.parse(storedUser) : null };
  } catch {
    clearStoredAuthSession();
    return { token: null, user: null };
  }
}
