import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyseFlow } from '../src/analyse.ts';

// Every real (anonymised) capture in fixtures/captures must parse cleanly and never crash a
// rule. This is the running check for spike S3.
const dir = join(import.meta.dirname, '../../../fixtures/captures');
const captures = readdirSync(dir).filter((name) => name.endsWith('.json'));

interface Capture {
  requests: { label: string; body?: { properties?: { definition?: unknown } } }[];
}

const definitions = captures.flatMap((file) => {
  const capture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Capture;
  return capture.requests
    .filter((r) => r.body?.properties?.definition)
    .map((r) => ({ name: `${file} › ${r.label}`, body: r.body }));
});

describe('captured flows', () => {
  it('has captures to check', () => {
    expect(definitions.length).toBeGreaterThan(0);
  });

  it.each(definitions)('$name parses and analyses without warnings', ({ body }) => {
    const result = analyseFlow(body);
    expect(result.tree.actionCount).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });
});
