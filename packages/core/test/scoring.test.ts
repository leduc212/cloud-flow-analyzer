import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { analyseFlow } from '../src/analyse.ts';
import { estimateActionsPerRun } from '../src/estimate.ts';
import { parseFlow } from '../src/parser.ts';
import { deduction, grade, scoreFindings } from '../src/scoring.ts';
import type { Finding } from '../src/types.ts';
import { compose, condition, flow, foreach, until } from './builders.ts';

const finding = (overrides: Partial<Finding>): Finding => ({
  ruleId: 'X',
  category: 'speed',
  severity: 'high',
  confidence: 1,
  target: { kind: 'flow', path: [] },
  message: '',
  ...overrides,
});

describe('scoring', () => {
  it('maps scores to grades', () => {
    expect([100, 90, 89, 80, 79, 65, 64, 50, 49, 0].map(grade)).toEqual([
      'A',
      'A',
      'B',
      'B',
      'C',
      'C',
      'D',
      'D',
      'F',
      'F',
    ]);
  });

  it('deducts severity × confidence, scaled by measured time share', () => {
    expect(deduction(finding({ severity: 'medium', confidence: 0.5 }))).toBe(5);
    expect(deduction(finding({ evidence: { timeSharePct: 80 } }))).toBeCloseTo(25 * 1.3);
    expect(deduction(finding({ evidence: { timeSharePct: 100 } }))).toBe(25 * 1.5);
  });

  it('weights categories 35 / 25 / 25 / 15 and floors at zero', () => {
    const score = scoreFindings([
      finding({ category: 'speed' }),
      finding({ category: 'speed' }),
      ...Array.from({ length: 5 }, () => finding({ category: 'reliability' })),
      finding({ category: 'maintainability' }),
    ]);
    expect(score.categories.speed).toEqual({ score: 50, grade: 'D', findings: 2 });
    expect(score.categories.resources.score).toBe(100);
    expect(score.categories.reliability.score).toBe(0);
    expect(score.categories.security.score).toBe(100);
    expect(score.overall).toBe(Math.round(50 * 0.35 + 100 * 0.25 + 0 * 0.25 + 100 * 0.15));
    expect(score.capped).toBeUndefined();
  });

  it('caps the grade at C while a high security finding is open', () => {
    const high = finding({ category: 'security' });
    const capped = scoreFindings([high]);
    expect(capped.categories.security.score).toBe(75);
    expect(capped.overall).toBe(79);
    expect(capped.grade).toBe('C');
    expect(capped.capped).toBe(true);
    // Accepted, or only medium: no cap.
    expect(scoreFindings([high], () => true).overall).toBe(100);
    expect(scoreFindings([finding({ category: 'security', severity: 'medium' })]).capped).toBe(
      undefined,
    );
  });

  it('leaves accepted findings out', () => {
    const f = finding({});
    expect(scoreFindings([f], (x) => x === f).overall).toBe(100);
  });

  it('scores the bad fixture below B', () => {
    expect(['C', 'D', 'F']).toContain(analyseFlow(bad).score.grade);
  });
});

describe('estimateActionsPerRun', () => {
  it('counts the trigger and every action once without loops', () => {
    expect(estimateActionsPerRun(parseFlow(flow({ A: compose(1), B: compose(2) })))).toEqual({
      total: 3,
      assumed: false,
    });
  });

  it('multiplies loops by assumed or measured iterations', () => {
    const tree = parseFlow(flow({ L: foreach('@x', { A: compose(1), B: compose(2) }) }));
    expect(estimateActionsPerRun(tree)).toEqual({ total: 1 + 1 + 50 * 2, assumed: true });
    expect(estimateActionsPerRun(tree, { iterations: { L: 10 } })).toEqual({
      total: 1 + 1 + 10 * 2,
      assumed: false,
    });
    const polling = parseFlow(flow({ U: until({ A: compose(1) }) }));
    expect(estimateActionsPerRun(polling, { untilIterations: 3 }).total).toBe(1 + 1 + 3);
  });

  it('counts only the larger branch of a condition', () => {
    const tree = parseFlow(
      flow({ If: condition({ A: compose(1) }, { B: compose(1), C: compose(2) }) }),
    );
    expect(estimateActionsPerRun(tree).total).toBe(1 + 1 + 2);
  });
});
