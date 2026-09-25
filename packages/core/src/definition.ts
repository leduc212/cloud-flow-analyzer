/** Loose helpers for walking untyped definition JSON. */
export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** True for a parameter that has a real value (not missing, null or blank). */
export function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export class FlowParseError extends Error {
  override name = 'FlowParseError';
}

export interface FlowInput {
  displayName?: string;
  definition: JsonObject;
  connectionReferences: JsonObject;
}

/**
 * Accepts any of the shapes a flow definition arrives in and returns the definition:
 * - a flow resource from the Power Automate API or an export package (`properties.definition`)
 * - Dataverse `workflow.clientdata`, as a JSON string or object
 * - a Dataverse workflow row (`{ clientdata: "…" }`)
 * - a bare definition (`{ triggers, actions }`)
 */
export function readFlow(input: unknown): FlowInput {
  if (typeof input === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new FlowParseError('The text is not valid JSON.');
    }
    return readFlow(parsed);
  }
  if (!isObject(input)) throw new FlowParseError('Expected a flow definition object.');

  if (typeof input.clientdata === 'string') {
    const inner = readFlow(input.clientdata);
    const name = asString(input.name);
    return name && !inner.displayName ? { ...inner, displayName: name } : inner;
  }

  const properties = asObject(input.properties);
  if (isObject(properties.definition)) {
    const displayName = asString(properties.displayName);
    return {
      ...(displayName ? { displayName } : {}),
      definition: properties.definition,
      connectionReferences: asObject(properties.connectionReferences),
    };
  }

  if (isObject(input.definition)) {
    return readFlow({ properties: input });
  }

  if (isObject(input.triggers) || isObject(input.actions)) {
    return { definition: input, connectionReferences: {} };
  }

  throw new FlowParseError(
    'No flow definition found. Expected `properties.definition`, `clientdata`, or `triggers`/`actions`.',
  );
}
