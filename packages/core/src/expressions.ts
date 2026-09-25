import { isObject } from './definition.ts';

const ACTION_REF =
  /\b(?:body|outputs|actions|actionBody|actionOutputs|result|iterationIndexes)\(\s*'((?:[^']|'')+)'\s*\)/g;
const LOOP_ITEM_REF = /\bitems\(\s*'((?:[^']|'')+)'\s*\)/g;
const CURRENT_ITEM_REF = /\bitem\(\s*\)/;
const VARIABLE_REF = /\bvariables\(\s*'((?:[^']|'')+)'\s*\)/g;

export interface References {
  actions: string[];
  loopItems: string[];
  usesItem: boolean;
  variables: string[];
}

/** Every string inside a JSON value (object keys excluded). */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (isObject(value)) for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function unquote(name: string): string {
  return name.replace(/''/g, "'");
}

function matchAll(pattern: RegExp, text: string, into: Set<string>): void {
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) into.add(unquote(match[1]));
  }
}

/** Finds the actions, loop items and variables an expression-bearing value refers to. */
export function scanReferences(value: unknown): References {
  const actions = new Set<string>();
  const loopItems = new Set<string>();
  const variables = new Set<string>();
  let usesItem = false;
  for (const text of collectStrings(value)) {
    if (!text.includes('(')) continue;
    matchAll(ACTION_REF, text, actions);
    matchAll(LOOP_ITEM_REF, text, loopItems);
    matchAll(VARIABLE_REF, text, variables);
    if (CURRENT_ITEM_REF.test(text)) usesItem = true;
  }
  return {
    actions: [...actions],
    loopItems: [...loopItems],
    usesItem,
    variables: [...variables],
  };
}

const LOOSE_CALL =
  /\b(?:body|outputs|actions|actionBody|actionOutputs|result|iterationIndexes|items|variables)\s*\(/g;
const STRICT_CALL = new RegExp(
  `${ACTION_REF.source}|${LOOP_ITEM_REF.source}|${VARIABLE_REF.source}`,
  'g',
);

/**
 * True when a value mentions a reference function whose argument can't be read (not a plain
 * quoted name), so the references found by `scanReferences` may be incomplete.
 */
export function hasUnreadableReferences(value: unknown): boolean {
  return collectStrings(value).some(
    (text) => (text.match(LOOSE_CALL)?.length ?? 0) > (text.match(STRICT_CALL)?.length ?? 0),
  );
}
