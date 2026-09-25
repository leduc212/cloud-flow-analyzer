import { describe, expect, it } from 'vitest';
import { MAX_ENDPOINTS, addEndpoint, endpointKey, normalisePath } from '../src/shared/endpoints.ts';
import { hostKind, isPortalOrigin } from '../src/shared/hosts.ts';
import { decodeJwt, isExpired, makeTokenRecord } from '../src/shared/token.ts';

const b64 = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;

describe('hosts', () => {
  it.each([
    ['api.flow.microsoft.com', 'flow'],
    ['emea.api.flow.microsoft.com', 'flow'],
    ['api.powerplatform.com', 'powerplatform'],
    ['abc123.45.environment.api.powerplatform.com', 'powerplatform'],
    ['evilapi.flow.microsoft.com', undefined],
    ['api.flow.microsoft.com.evil.com', undefined],
    ['graph.microsoft.com', undefined],
  ])('%s → %s', (host, kind) => {
    expect(hostKind(host)).toBe(kind);
  });

  it('only trusts the maker portals', () => {
    expect(isPortalOrigin('https://make.powerautomate.com')).toBe(true);
    expect(isPortalOrigin('https://make.powerapps.com')).toBe(true);
    expect(isPortalOrigin('chrome-extension://abc')).toBe(false);
    expect(isPortalOrigin(undefined)).toBe(false);
  });
});

describe('token', () => {
  const token = jwt({
    aud: 'https://service.flow.microsoft.com/',
    exp: 2_000_000_000,
    tid: 't',
    upn: 'josé@contoso.com',
  });

  it('decodes claims, including non-ASCII text', () => {
    expect(decodeJwt(token)).toMatchObject({ exp: 2_000_000_000, upn: 'josé@contoso.com' });
    expect(decodeJwt('not-a-jwt')).toBeUndefined();
    expect(decodeJwt('a.@@@.c')).toBeUndefined();
  });

  it('keeps the most recent origin first, without duplicates', () => {
    const first = makeTokenRecord(
      'flow',
      token,
      'https://emea.api.flow.microsoft.com',
      undefined,
      1,
    );
    const second = makeTokenRecord('flow', token, 'https://api.flow.microsoft.com', first, 2);
    const third = makeTokenRecord('flow', token, 'https://emea.api.flow.microsoft.com', second, 3);
    expect(third.origins).toEqual([
      'https://emea.api.flow.microsoft.com',
      'https://api.flow.microsoft.com',
    ]);
    expect(third).toMatchObject({
      account: 'josé@contoso.com',
      tenantId: 't',
      expiresAt: 2_000_000_000_000,
    });
  });

  it('knows when a token has expired', () => {
    const record = makeTokenRecord('flow', token, 'https://x.api.flow.microsoft.com');
    expect(isExpired(record, 1_999_999_999_000)).toBe(false);
    expect(isExpired(record, 2_000_000_000_000)).toBe(true);
  });
});

describe('endpoints', () => {
  it('replaces IDs, run names and action names', () => {
    expect(
      normalisePath(
        '/providers/Microsoft.ProcessSimple/environments/Default-a1b2c3d4-1111-2222-3333-444455556666/flows/a1b2c3d4-1111-2222-3333-444455556666/runs/08584620683726134939219408413CU04/actions/Get_a_row/repetitions',
      ),
    ).toBe(
      '/providers/Microsoft.ProcessSimple/environments/Default-{id}/flows/{id}/runs/{run}/actions/{name}/repetitions',
    );
  });

  it('keeps api-version, $expand and search filters but drops other values', () => {
    const { key, host } = endpointKey(
      'GET',
      new URL(
        "https://0123456789abcdef.ab.environment.api.powerplatform.com/powerautomate/flows?api-version=1&$top=50&$filter=search('team')&$skiptoken=abc",
      ),
    );
    expect(host).toBe('{env}.environment.api.powerplatform.com');
    expect(key).toBe(
      "GET {env}.environment.api.powerplatform.com/powerautomate/flows?$filter=search('team')&$skiptoken&$top&api-version=1",
    );
  });

  it('hides tenant hosts', () => {
    const { host } = endpointKey(
      'GET',
      new URL(
        'https://0123456789abcdef0123456789abcd.05.tenant.api.powerplatform.com/powerapps/features',
      ),
    );
    expect(host).toBe('{tenant}.tenant.api.powerplatform.com');
  });

  it('counts repeats and stops adding new endpoints when full', () => {
    const table = {};
    const url = new URL('https://api.flow.microsoft.com/a?api-version=1');
    addEndpoint(table, 'GET', url, 1);
    addEndpoint(table, 'GET', url, 2);
    expect(Object.values(table)).toEqual([
      expect.objectContaining({ count: 2, firstSeen: 1, lastSeen: 2 }),
    ]);
    for (let i = 0; i < MAX_ENDPOINTS; i++)
      addEndpoint(table, 'GET', new URL(`https://api.flow.microsoft.com/p${i}`));
    expect(Object.keys(table)).toHaveLength(MAX_ENDPOINTS);
  });
});
