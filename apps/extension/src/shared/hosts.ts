export type HostKind = 'flow' | 'powerplatform';

/** Request URLs the background worker watches. Must match `host_permissions` in the manifest. */
export const API_URL_PATTERNS = [
  'https://*.api.flow.microsoft.com/*',
  'https://*.api.powerplatform.com/*',
];

/** Maker portals whose requests carry a token worth capturing (commercial cloud only). */
export const PORTAL_ORIGINS: readonly string[] = [
  'https://make.powerautomate.com',
  'https://make.preview.powerautomate.com',
  'https://make.powerapps.com',
  'https://make.preview.powerapps.com',
];

export const HOST_LABELS: Record<HostKind, string> = {
  flow: 'Power Automate API (api.flow.microsoft.com)',
  powerplatform: 'Power Platform API (api.powerplatform.com)',
};

function isHostOf(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Which API a host belongs to, or undefined for anything else. */
export function hostKind(hostname: string): HostKind | undefined {
  const host = hostname.toLowerCase();
  if (isHostOf(host, 'api.flow.microsoft.com')) return 'flow';
  if (isHostOf(host, 'api.powerplatform.com')) return 'powerplatform';
  return undefined;
}

export function isPortalOrigin(origin: string | undefined): boolean {
  return origin !== undefined && PORTAL_ORIGINS.includes(origin);
}
