import type { HostKind } from './hosts.ts';

/**
 * A captured access token. Lives only in `chrome.storage.session` (memory, never on disk,
 * readable only by the extension's own pages and worker).
 */
export interface TokenRecord {
  kind: HostKind;
  token: string;
  audience?: string;
  tenantId?: string;
  account?: string;
  /** Milliseconds since epoch, from the `exp` claim. */
  expiresAt?: number;
  capturedAt: number;
  /** API origins the portal used this token on, most recent first. */
  origins: string[];
}

export const TOKEN_KEYS: Record<HostKind, string> = {
  flow: 'token:flow',
  powerplatform: 'token:powerplatform',
};

interface JwtClaims {
  aud?: string;
  exp?: number;
  tid?: string;
  upn?: string;
  preferred_username?: string;
  unique_name?: string;
}

/** Reads a JWT's claims without validating it (the API does that). */
export function decodeJwt(token: string): JwtClaims | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims === 'object' && claims !== null ? (claims as JwtClaims) : undefined;
  } catch {
    return undefined;
  }
}

export function makeTokenRecord(
  kind: HostKind,
  token: string,
  origin: string,
  previous?: TokenRecord,
  now = Date.now(),
): TokenRecord {
  const claims = decodeJwt(token) ?? {};
  const account = claims.upn ?? claims.preferred_username ?? claims.unique_name;
  return {
    kind,
    token,
    ...(claims.aud !== undefined ? { audience: claims.aud } : {}),
    ...(claims.tid !== undefined ? { tenantId: claims.tid } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp * 1000 } : {}),
    capturedAt: now,
    origins: [origin, ...(previous?.origins ?? []).filter((o) => o !== origin)].slice(0, 10),
  };
}

export function isExpired(record: TokenRecord, now = Date.now()): boolean {
  return record.expiresAt !== undefined && record.expiresAt <= now;
}

/** Reads every captured token from session storage. */
export async function loadTokens(): Promise<Partial<Record<HostKind, TokenRecord>>> {
  const stored = await chrome.storage.session.get(Object.values(TOKEN_KEYS));
  const result: Partial<Record<HostKind, TokenRecord>> = {};
  for (const [kind, key] of Object.entries(TOKEN_KEYS) as [HostKind, string][]) {
    const record = stored[key] as TokenRecord | undefined;
    if (record) result[kind] = record;
  }
  return result;
}
