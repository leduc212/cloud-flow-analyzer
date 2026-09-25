import { MAINTAINABILITY_RULES } from './maintainability.ts';
import { RELIABILITY_RULES } from './reliability.ts';
import { RESOURCE_RULES } from './resources.ts';
import type { Rule } from './rule.ts';
import { SECURITY_RULES } from './security.ts';
import { SPEED_RULES } from './speed.ts';

export const RULES: Rule[] = [
  ...SPEED_RULES,
  ...RESOURCE_RULES,
  ...RELIABILITY_RULES,
  ...SECURITY_RULES,
  ...MAINTAINABILITY_RULES,
];

export const RULES_BY_ID: ReadonlyMap<string, Rule> = new Map(RULES.map((rule) => [rule.id, rule]));

export function getRule(id: string): Rule | undefined {
  return RULES_BY_ID.get(id);
}

export type { Rule, RuleContext, RuleMatch, RunSampleMode } from './rule.ts';
export { DOCS } from './rule.ts';
