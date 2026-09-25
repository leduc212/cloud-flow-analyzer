import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyseFlow } from '../src/analyse.ts';
import { runSamplesFromResponses, type RunSample } from '../src/runs.ts';

// Every real (anonymised) capture in fixtures/captures must parse cleanly and never crash a
// rule. This is the running check for spike S3.
const dir = join(import.meta.dirname, '../../../fixtures/captures');
const captures = readdirSync(dir).filter((name) => name.endsWith('.json'));

interface Capture {
  requests: {
    label: string;
    url: string;
    body?: { name?: string; properties?: { definition?: unknown } };
  }[];
}

const definitions = captures.flatMap((file) => {
  const capture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Capture;
  const runs = runSamplesFromResponses(capture.requests);
  return capture.requests
    .filter((r) => r.body?.properties?.definition)
    .map((r) => ({
      name: `${file} › ${r.label}`,
      body: r.body,
      runs: runs.get(r.body?.name ?? '') ?? ([] as RunSample[]),
    }));
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

  it('has recorded runs for most flows', () => {
    const withRuns = definitions.filter((d) => d.runs.length > 0);
    expect(withRuns.length).toBeGreaterThan(definitions.length / 2);
  });

  it.each(definitions)('$name analyses with its recorded runs', ({ body, runs }) => {
    const result = analyseFlow(body, { runs });
    expect(result.warnings).toEqual([]);
    for (const loop of result.runStats?.loops.values() ?? []) {
      expect(loop.iterationsP50).toBeGreaterThan(0);
      expect(loop.iterationsMax).toBeGreaterThanOrEqual(loop.iterationsP50);
    }
    for (const action of result.runStats?.actions.values() ?? []) {
      expect(action.timeSharePct ?? 0).toBeLessThanOrEqual(100);
    }
  });
});
