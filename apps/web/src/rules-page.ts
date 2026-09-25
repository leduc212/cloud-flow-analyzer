import './site.css';
import { RULES, type Category, type Rule } from '@cfa/core';
import { h } from './dom.ts';
import { ruleDetails } from './report.ts';

const CATEGORIES: [Category, string][] = [
  ['speed', 'Speed'],
  ['resources', 'Resources'],
  ['reliability', 'Reliability'],
  ['security', 'Security'],
  ['maintainability', 'Maintainability'],
];

const SEVERITY = { high: 'high', medium: 'medium', low: 'low' } as const;

export function renderRule(rule: Rule): HTMLElement {
  return h(
    'article',
    { class: 'rule', id: rule.id },
    h('h3', {}, `${rule.id} · ${rule.title}`),
    h(
      'div',
      { class: 'meta' },
      `Usually ${SEVERITY[rule.severity]} severity${rule.usesRunData ? ' · 📊 uses run data when available' : ''}`,
    ),
    ...ruleDetails(rule),
  );
}

export function renderRules(target: HTMLElement, toc: HTMLElement): void {
  const groups = CATEGORIES.map(([category, name]) => ({
    category,
    name,
    rules: RULES.filter((r) => r.category === category),
  })).filter((g) => g.rules.length > 0);
  toc.replaceChildren(
    ...groups.map((g) => h('a', { href: `#${g.category}` }, `${g.name} (${g.rules.length})`)),
  );
  target.replaceChildren(
    ...groups.flatMap((g) => [
      h('h2', { class: 'category', id: g.category }, g.name),
      ...g.rules.map(renderRule),
    ]),
  );
}

const rules = document.getElementById('rules');
const toc = document.getElementById('toc');
if (rules && toc) {
  renderRules(rules, toc);
  // The page is built by script: jump to the rule the link pointed at.
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
