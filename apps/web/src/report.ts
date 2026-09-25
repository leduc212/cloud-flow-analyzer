import { docLabel, getRule, label, type Finding, type FlowAnalysis, type Rule } from '@cfa/core';
import { h } from './dom.ts';

const SEVERITY: Record<Finding['severity'], string> = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

const CATEGORIES = [
  ['speed', 'Speed'],
  ['resources', 'Resources'],
  ['reliability', 'Reliability'],
  ['security', 'Security'],
] as const;

/** Link to a rule's section on the rules page. */
export function ruleLink(ruleId: string): string {
  return `./rules.html#${ruleId}`;
}

/** Before and after, why it matters and Microsoft's docs: shared by the report and rules page. */
export function ruleDetails(rule: Rule, fix = rule.fix): HTMLElement[] {
  return [
    h('div', { class: 'label' }, 'How to fix'),
    h('p', {}, fix),
    h('div', { class: 'label' }, 'Why it matters'),
    h('p', {}, rule.why),
    ...(rule.example
      ? [
          h('div', { class: 'label' }, 'Before'),
          h('pre', {}, rule.example.before),
          h('div', { class: 'label' }, 'After'),
          h('pre', {}, rule.example.after),
        ]
      : []),
    h('div', { class: 'label' }, 'Microsoft docs'),
    h(
      'ul',
      { class: 'docs' },
      ...rule.docs.map((url) =>
        h('li', {}, h('a', { href: url, rel: 'noreferrer' }, docLabel(url))),
      ),
    ),
  ];
}

function renderFinding(finding: Finding): HTMLElement {
  const rule = getRule(finding.ruleId);
  const where =
    finding.target.kind === 'flow' ? 'Whole flow' : finding.target.path.map(label).join(' › ');
  return h(
    'article',
    { class: 'finding' },
    h(
      'div',
      { class: 'finding-head' },
      h('span', { class: `severity ${finding.severity}` }, SEVERITY[finding.severity]),
      h(
        'a',
        { href: ruleLink(finding.ruleId), class: 'rule-title' },
        rule?.title ?? finding.ruleId,
      ),
      h('span', { class: 'where' }, finding.ruleId),
    ),
    h('div', { class: 'where path' }, where),
    h('p', {}, finding.message),
    rule
      ? h('details', {}, h('summary', {}, 'How to fix'), ...ruleDetails(rule, finding.fix))
      : null,
  );
}

/** The analysis as the site shows it: grade, category scores, then every finding. */
export function renderReport(analysis: FlowAnalysis): HTMLElement {
  const { score, tree, estimate, findings, warnings } = analysis;
  return h(
    'div',
    {},
    h('h2', {}, tree.displayName ?? 'Your flow'),
    h(
      'div',
      { class: 'summary' },
      h(
        'div',
        {
          class: `grade ${score.grade}`,
          role: 'img',
          'aria-label': `Grade ${score.grade}, score ${score.overall} out of 100`,
        },
        score.grade,
      ),
      h(
        'div',
        {},
        h(
          'div',
          { class: 'scores' },
          ...CATEGORIES.map(([key, name]) =>
            h('span', {}, `${name} `, h('b', {}, score.categories[key].score)),
          ),
        ),
        h(
          'div',
          { class: 'where' },
          `Score ${score.overall} / 100${score.capped ? ' (capped at C while a high security finding is open)' : ''} · ${tree.actionCount} actions · about ${estimate.total.toLocaleString('en-US')} actions per run${estimate.assumed ? ' (estimated)' : ''}`,
        ),
      ),
    ),
    findings.length === 0
      ? h('p', { class: 'ok' }, 'No problems found. This flow follows every rule we check.')
      : h('div', {}, ...findings.map(renderFinding)),
    ...warnings.map((w) => h('p', { class: 'where' }, `Note: ${w}`)),
  );
}
