/**
 * Records which API endpoints the maker portal calls (method, host, path shape, api-version),
 * so the spikes can confirm the real API without guessing. IDs and names are replaced by
 * placeholders; no bodies or tokens are kept.
 */
export interface EndpointRecord {
  method: string;
  host: string;
  path: string;
  query: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export const ENDPOINTS_KEY = 'portal-endpoints';
export const MAX_ENDPOINTS = 500;

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const LONG_NUMBER = /^\d{12,}[A-Z0-9]*$/i;
const NAME_AFTER = new Set([
  'actions',
  'triggers',
  'repetitions',
  'connections',
  'users',
  'groups',
]);
const KEEP_VALUES = new Set(['api-version', '$expand']);
const SEARCH_FILTER = /^search\('\w+'\)$/;

export function normaliseHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^[a-z0-9]+\.[a-z0-9]{2}(?=\.environment\.api\.powerplatform\.com$)/, '{env}')
    .replace(/^[a-z0-9]+\.[a-z0-9]{2}(?=\.tenant\.api\.powerplatform\.com$)/, '{tenant}');
}

export function normalisePath(path: string): string {
  const segments = path.split('/');
  return segments
    .map((segment, i) => {
      if (segment === '') return segment;
      const previous = segments[i - 1]?.toLowerCase();
      if (previous && NAME_AFTER.has(previous)) return '{name}';
      if (LONG_NUMBER.test(segment)) return '{run}';
      return segment.replace(GUID, '{id}').replace(HEX32, '{id}');
    })
    .join('/');
}

export function normaliseQuery(params: URLSearchParams): string {
  return [...params]
    .map(([key, value]) =>
      KEEP_VALUES.has(key) || (key === '$filter' && SEARCH_FILTER.test(value))
        ? `${key}=${value}`
        : key,
    )
    .sort()
    .join('&');
}

export function endpointKey(
  method: string,
  url: URL,
): Omit<EndpointRecord, 'count' | 'firstSeen' | 'lastSeen'> & { key: string } {
  const host = normaliseHost(url.host);
  const path = normalisePath(url.pathname);
  const query = normaliseQuery(url.searchParams);
  return { key: `${method} ${host}${path}?${query}`, method, host, path, query };
}

/** Adds one observation; returns false when the table is full and the endpoint is new. */
export function addEndpoint(
  table: Record<string, EndpointRecord>,
  method: string,
  url: URL,
  now = Date.now(),
): boolean {
  const { key, ...fields } = endpointKey(method, url);
  const existing = table[key];
  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    return true;
  }
  if (Object.keys(table).length >= MAX_ENDPOINTS) return false;
  table[key] = { ...fields, count: 1, firstSeen: now, lastSeen: now };
  return true;
}
