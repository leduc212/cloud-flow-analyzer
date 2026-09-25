import { isObject } from './definition.ts';

/**
 * Best-effort anonymiser for flow definitions, API responses and capture files.
 *
 * - GUIDs (with or without dashes), emails, URLs and names are replaced consistently, so the
 *   same value maps to the same placeholder everywhere in one run.
 * - Signed links (`inputsLink`, `outputsLink`) and connector `metadata` (file paths) are removed.
 * - Literal values in action inputs, conditions and switch cases are replaced; expressions are
 *   kept, but their string literals are replaced except action names and property paths.
 * - Structural values the rules need (operation IDs, parameter names, `$select`, table names…)
 *   are kept.
 *
 * Always review the output before sharing it.
 */

const DROP_KEYS = new Set([
  'inputsLink',
  'outputsLink',
  'metadata',
  'authorization',
  'Authorization',
]);
const NAME_KEYS = new Set([
  'displayName',
  'friendlyName',
  'uniqueName',
  'domainName',
  'userDisplayName',
  'fullName',
  'givenName',
  'surname',
  'tenantDisplayName',
]);
const TEXT_KEYS = new Set([
  'description',
  'summary',
  'message',
  'title',
  'subject',
  'text',
  'comment',
  'notes',
  'errorMessage',
]);
/** Keys whose subtree holds user data inside a definition. */
const VALUE_ZONE_KEYS = new Set(['inputs', 'expression', 'conditions', 'case', 'foreach']);
/** Keys inside a value zone whose values are structure, not data. */
const STRUCTURAL_KEYS = new Set([
  'operationId',
  'apiId',
  'connectionName',
  'connection',
  'referenceName',
  'method',
  'name',
  'type',
  'entityName',
  'dataset',
  'table',
  'source',
  'drive',
  'file',
  'workflowReferenceName',
  'unit',
  'count',
  'frequency',
  'interval',
  'timeout',
  'schema',
]);
const QUERY_KEYS = new Set(['$filter', 'fetchXml', 'subscriptionRequest/filterexpression']);
const KEEP_HOSTS = [
  /(^|\.)flow\.microsoft\.com$/i,
  /(^|\.)api\.powerplatform\.com$/i,
  /(^|\.)schema\.management\.azure\.com$/i,
  /(^|\.)logic\.azure\.com$/i,
  /(^|\.)azure-apim\.net$/i,
  /(^|\.)learn\.microsoft\.com$/i,
];
const KEEP_QUERY_PARAMS = new Set(['api-version', '$top', '$expand', '$filter', '$select']);
const REFERENCE_FUNCTIONS =
  /^(body|outputs|actions|actionBody|actionOutputs|result|items|iterationIndexes|variables|parameters|triggerOutputs|triggerBody|workflow)\($/i;

const ENV_HOST = String.raw`\b([a-z0-9]+\.[a-z0-9]{2})(?=\.(?:environment|tenant)\.api\.powerplatform\.com)`;
const EMAIL = String.raw`[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`;
const URL_PATTERN = String.raw`https?://[^\s'"<>(){}\[\]\\]+`;
const GUID = String.raw`(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])`;
const HEX32 = String.raw`(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])`;
const TOKEN = new RegExp(`(${URL_PATTERN})|(${EMAIL})|${ENV_HOST}|(${GUID})|(${HEX32})`, 'gi');
const IDS = new RegExp(`${ENV_HOST}|(${GUID})|(${HEX32})`, 'gi');

const INTERPOLATION = /@\{((?:[^{}']|'(?:[^']|'')*')*)\}/g;

type Zone = 'none' | 'values';

export interface Anonymiser {
  /** Anonymises a whole JSON value (definitions, API responses, capture files). */
  value(input: unknown): unknown;
  /** Replaces only IDs, emails and URLs in a piece of text. */
  text(input: string): string;
}

export function createAnonymiser(): Anonymiser {
  const ids = new Map<string, number>();
  const emails = new Map<string, string>();
  const names = new Map<string, string>();
  const envHosts = new Map<string, string>();
  const origins = new Map<string, number>();
  const urls = new Map<string, string>();

  const fakeId = (raw: string): string => {
    const key = raw.replace(/-/g, '').toLowerCase();
    let n = ids.get(key);
    if (n === undefined) {
      n = ids.size + 1;
      ids.set(key, n);
    }
    const tail = n.toString(16).padStart(12, '0');
    return raw.includes('-') ? `00000000-0000-4000-8000-${tail}` : `00000000000040008000${tail}`;
  };

  const fakeEmail = (raw: string): string => {
    const key = raw.toLowerCase();
    let fake = emails.get(key);
    if (!fake) {
      fake = `user${emails.size + 1}@example.com`;
      emails.set(key, fake);
    }
    return fake;
  };

  const fakeEnvHost = (raw: string): string => {
    const key = raw.toLowerCase();
    let fake = envHosts.get(key);
    if (!fake) {
      fake = `envhost${envHosts.size + 1}.xx`;
      envHosts.set(key, fake);
    }
    return fake;
  };

  const fakeName = (raw: string): string => {
    let fake = names.get(raw);
    if (!fake) {
      fake = `Name ${names.size + 1}`;
      names.set(raw, fake);
    }
    return fake;
  };

  const replaceIds = (text: string): string =>
    text.replace(IDS, (match, envHost?: string) =>
      envHost ? fakeEnvHost(envHost) : fakeId(match),
    );

  const fakeUrl = (raw: string): string => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'https://host.example.com/redacted';
    }
    if (KEEP_HOSTS.some((pattern) => pattern.test(url.hostname))) {
      const query = [...url.searchParams]
        .filter(([key]) => KEEP_QUERY_PARAMS.has(key))
        .map(([key, value]) => `${key}=${replaceIds(value)}`)
        .join('&');
      return `${url.protocol}//${replaceIds(url.host)}${replaceIds(url.pathname)}${query ? `?${query}` : ''}`;
    }
    let fake = urls.get(raw);
    if (!fake) {
      let origin = origins.get(url.origin);
      if (origin === undefined) {
        origin = origins.size + 1;
        origins.set(url.origin, origin);
      }
      const path = url.pathname.length > 1 ? `/path${urls.size + 1}` : '';
      fake = `https://host${origin}.example.com${path}`;
      urls.set(raw, fake);
    }
    return fake;
  };

  const text = (input: string): string =>
    input.replace(TOKEN, (match, url?: string, email?: string, envHost?: string) => {
      if (url) return fakeUrl(url);
      if (email) return fakeEmail(email);
      if (envHost) return fakeEnvHost(envHost);
      return fakeId(match);
    });

  /** Replaces string literals in an expression, keeping action names and property paths. */
  const expressionLiterals = (expression: string): string =>
    expression.replace(
      /(\b[A-Za-z]+\(\s*|\[\s*)?'((?:[^']|'')*)'/g,
      (match, prefix: string | undefined, literal: string) => {
        if (literal === '') return match;
        if (
          prefix &&
          (prefix.startsWith('[') || REFERENCE_FUNCTIONS.test(prefix.replace(/\s+/g, '')))
        ) {
          return match;
        }
        return `${prefix ?? ''}'<v>'`;
      },
    );

  /**
   * Splits text around `@{…}` interpolations, mapping the plain text and the expressions
   * separately, so expressions inside filters and messages survive intact.
   */
  const mapInterpolated = (
    value: string,
    outside: (text: string) => string,
    inside: (expression: string) => string,
  ): string => {
    const parts: string[] = [];
    let last = 0;
    for (const m of value.matchAll(INTERPOLATION)) {
      if (m.index > last) parts.push(outside(value.slice(last, m.index)));
      parts.push(`@{${inside(m[1] ?? '')}}`);
      last = m.index + m[0].length;
    }
    if (last < value.length) parts.push(outside(value.slice(last)));
    return parts.join('');
  };

  const expression = (value: string): string => expressionLiterals(text(value));

  /** Replaces literals in a query (OData filter, FetchXML), keeping embedded expressions. */
  const queryLiterals = (query: string): string => {
    if (query.startsWith('@') && !query.startsWith('@{')) return expression(query);
    // Mask expressions first so quotes around and between them can't be misread as literals.
    const expressions: string[] = [];
    const masked = query.replace(INTERPOLATION, (_match, inner: string) => {
      expressions.push(inner);
      return `\uE000${expressions.length - 1}\uE000`;
    });
    return text(masked)
      .replace(/'((?:[^']|'')+)'/g, (match, literal: string) =>
        literal.includes('\uE000') ? match : "'<v>'",
      )
      .replace(/(value|uiname)="[^"]*"/gi, '$1="<v>"')
      .replace(/<value>[^<]*<\/value>/gi, '<value><v></value>')
      .replace(
        /\uE000(\d+)\uE000/g,
        (_match, index: string) => `@{${expression(expressions[Number(index)] ?? '')}}`,
      );
  };

  const dataValue = (value: string): string => {
    if (value.trim() === '') return value;
    if (value.startsWith('@') && !value.startsWith('@{')) return expression(value);
    // Text with interpolated expressions: keep the expressions, replace the text around them.
    if (value.includes('@{')) return mapInterpolated(value, () => '<text>', expression);
    return '<value>';
  };

  const walkString = (value: string, key: string | undefined, zone: Zone): string => {
    if (key !== undefined && NAME_KEYS.has(key)) return value.trim() ? fakeName(value) : value;
    if (key !== undefined && TEXT_KEYS.has(key)) return value.trim() ? '<text>' : value;
    if (key !== undefined && QUERY_KEYS.has(key)) return queryLiterals(value);
    if (zone === 'values') {
      const structural =
        key !== undefined &&
        (STRUCTURAL_KEYS.has(key) || key.startsWith('$') || key.startsWith('subscriptionRequest/'));
      if (!structural) return dataValue(value);
      return value.startsWith('@') ? expression(value) : text(value);
    }
    return text(value);
  };

  const walk = (value: unknown, key: string | undefined, zone: Zone): unknown => {
    if (typeof value === 'string') return walkString(value, key, zone);
    if (Array.isArray(value)) return value.map((item) => walk(item, key, zone));
    if (isObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) {
        if (DROP_KEYS.has(childKey)) continue;
        const childZone = zone === 'values' || VALUE_ZONE_KEYS.has(childKey) ? 'values' : 'none';
        result[text(childKey)] = walk(child, childKey, childZone);
      }
      return result;
    }
    return value;
  };

  return { value: (input) => walk(input, undefined, 'none'), text };
}

/** Anonymises one value with a fresh set of placeholders. */
export function anonymise<T>(input: T): unknown {
  return createAnonymiser().value(input);
}
