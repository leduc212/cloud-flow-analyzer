// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { analyseFlow } from '@cfa/core';
import { ApiError, NoTokenError } from '../src/api/client.ts';
import { HOST_ID, Pane, type DismissalStore } from '../src/content/pane.ts';
import { findingKey, markdownReport, scoreWithout } from '../src/content/report.ts';
import { friendlyError } from '../src/shared/errors.ts';
import { buildPaneResult } from '../src/shared/pane-result.ts';

const result = buildPaneResult(
  { environment: 'env', flowId: 'flow-1' },
  analyseFlow(bad),
  new Date(0),
);

afterEach(() => document.getElementById(HOST_ID)?.remove());

describe('report', () => {
  it('scores the same as the analysis when nothing is dismissed', () => {
    const score = scoreWithout(result, new Set());
    expect(score.overall).toBe(result.overall);
    expect(score.grade).toBe(result.grade);
  });

  it('leaves dismissed findings out of the score and the report', () => {
    const rel02 = result.findings.find((f) => f.ruleId === 'REL02')!;
    const dismissed = new Set([findingKey(rel02)]);
    expect(scoreWithout(result, dismissed).categories.reliability.score).toBe(100);
    const report = markdownReport(result, dismissed);
    expect(report).toContain('# Flow analysis: Sync account contacts (before)');
    expect(report).toContain('## High · SPD03 Data read one item at a time inside a loop');
    expect(report).toContain('**Where:** Get primary contact');
    expect(report).not.toContain('REL02');
    expect(report).toContain('_1 dismissed finding not shown._');
  });

  it('keys findings by rule and position', () => {
    expect(findingKey(result.findings.find((f) => f.ruleId === 'REL02')!)).toBe('REL02|flow');
    expect(findingKey(result.findings.find((f) => f.ruleId === 'SPD03')!)).toBe(
      'SPD03|Apply_to_each/Get_primary_contact',
    );
  });
});

describe('dismissing in the pane', () => {
  function memoryStore(initial: string[] = []) {
    const saved = new Map<string, string[]>([['flow-1', initial]]);
    const store: DismissalStore = {
      load: async (flowId) => saved.get(flowId) ?? [],
      save: vi.fn(async (flowId, keys) => {
        saved.set(flowId, keys);
      }),
    };
    return { store, saved };
  }
  const shadow = () => document.getElementById(HOST_ID)!.shadowRoot!;
  const button = (text: string) =>
    [...shadow().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.startsWith(text),
    )!;

  it('hides a dismissed finding, rescores, remembers it and can restore it', async () => {
    const { store, saved } = memoryStore();
    const pane = new Pane(() => {}, store);
    await pane.showResult(result);
    const before = shadow().querySelectorAll('.finding').length;
    shadow().querySelector<HTMLButtonElement>('.dismiss')!.click();
    await Promise.resolve();
    expect(shadow().querySelectorAll('.finding')).toHaveLength(before - 1);
    expect(saved.get('flow-1')).toHaveLength(1);
    button('Dismissed 1').click();
    expect(shadow().querySelectorAll('.finding')).toHaveLength(1);
    shadow().querySelector<HTMLButtonElement>('.dismiss')!.click();
    await Promise.resolve();
    expect(saved.get('flow-1')).toEqual([]);
    pane.close();
  });

  it('applies dismissals saved earlier', async () => {
    const rel02 = result.findings.find((f) => f.ruleId === 'REL02')!;
    const { store } = memoryStore([findingKey(rel02)]);
    const pane = new Pane(() => {}, store);
    await pane.showResult(result);
    expect(shadow().querySelectorAll('.finding')).toHaveLength(result.findings.length - 1);
    expect(shadow().querySelector('.grade')?.textContent).toBe(
      scoreWithout(result, new Set([findingKey(rel02)])).grade,
    );
    pane.close();
  });
});

describe('friendlyError', () => {
  it.each([
    [new NoTokenError('flow'), 'Refresh this page'],
    [new ApiError('x', 401, ''), 'sign-in has expired'],
    [new ApiError('x', 403, ''), "don't have access"],
    [new ApiError('x', 429, ''), 'Wait a minute'],
    [new ApiError('x', 503, ''), 'error (503)'],
    [new TypeError('Failed to fetch'), "Couldn't reach Power Automate"],
  ])('explains %s', (error, text) => {
    expect(friendlyError(error)).toContain(text);
  });
});
