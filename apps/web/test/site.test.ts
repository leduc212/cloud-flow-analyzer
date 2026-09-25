import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import good from '../../../fixtures/flows/sync-contacts-good.json' with { type: 'json' };
import { RULES, analyseFlow } from '@cfa/core';
import { renderReport, ruleLink } from '../src/report.ts';
import { renderRules } from '../src/rules-page.ts';
import { SAMPLES } from '../src/samples.ts';

describe('report', () => {
  it('shows the grade, the category scores and every finding with its rule link', () => {
    const analysis = analyseFlow(bad);
    const report = renderReport(analysis);
    expect(report.querySelector('h2')?.textContent).toBe('Sync account contacts (before)');
    expect(report.querySelector('.grade')?.textContent).toBe(analysis.score.grade);
    expect(report.querySelector('.scores')?.textContent).toContain('Security 100');
    const findings = report.querySelectorAll('.finding');
    expect(findings).toHaveLength(analysis.findings.length);
    const spd03 = [...findings].find((f) => f.textContent?.includes('SPD03'));
    expect(spd03?.querySelector('a.rule-title')?.getAttribute('href')).toBe(ruleLink('SPD03'));
    expect(spd03?.querySelector('.path')?.textContent).toBe('Apply to each › Get primary contact');
    expect(spd03?.querySelector('details pre')).not.toBeNull();
  });

  it('says so when a flow follows every rule', () => {
    expect(renderReport(analyseFlow(good)).querySelector('.ok')?.textContent).toContain(
      'No problems found',
    );
  });

  it('has samples that all analyse', () => {
    for (const sample of SAMPLES) expect(() => analyseFlow(sample.flow)).not.toThrow();
  });
});

describe('rules page', () => {
  it('lists every rule under its category, with an anchor per rule', () => {
    const target = document.createElement('div');
    const toc = document.createElement('nav');
    renderRules(target, toc);
    expect(target.querySelectorAll('article.rule')).toHaveLength(RULES.length);
    for (const rule of RULES) expect(target.querySelector(`#${rule.id}`)).not.toBeNull();
    expect(toc.textContent).toContain('Security (3)');
    expect(target.querySelector('#SPD01 .meta')?.textContent).toContain('📊');
  });
});
