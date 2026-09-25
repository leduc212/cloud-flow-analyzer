import { getRule, label, type FindingTarget, type FlowAnalysis } from '@cfa/core';
import type { FlowRef } from './flow-url.ts';

/** One finding, with the rule's texts, ready for the in-page pane. Plain data only. */
export interface PaneFinding {
  ruleId: string;
  title: string;
  category: string;
  severity: 'high' | 'medium' | 'low';
  confidence: number;
  target: FindingTarget;
  /** Designer-style name of the target, e.g. "Get a row", or "Whole flow". */
  targetLabel: string;
  message: string;
  why: string;
  fix: string;
  example?: { before: string; after: string };
  docs: string[];
  blockedBy?: string[];
}

export interface PaneResult {
  ref: FlowRef;
  displayName: string;
  grade: string;
  overall: number;
  categories: { speed: number; resources: number; reliability: number };
  actionCount: number;
  estimate: { total: number; assumed: boolean };
  findings: PaneFinding[];
  warnings: string[];
  analysedAt: string;
}

export function buildPaneResult(
  ref: FlowRef,
  analysis: FlowAnalysis,
  now = new Date(),
): PaneResult {
  const { tree, score, estimate, findings, warnings } = analysis;
  return {
    ref,
    displayName: tree.displayName ?? 'This flow',
    grade: score.grade,
    overall: score.overall,
    categories: {
      speed: score.categories.speed.score,
      resources: score.categories.resources.score,
      reliability: score.categories.reliability.score,
    },
    actionCount: tree.actionCount,
    estimate,
    findings: findings.map((finding): PaneFinding => {
      const rule = getRule(finding.ruleId);
      return {
        ruleId: finding.ruleId,
        title: rule?.title ?? finding.ruleId,
        category: finding.category,
        severity: finding.severity,
        confidence: finding.confidence,
        target: finding.target,
        targetLabel: finding.target.name ? label(finding.target.name) : 'Whole flow',
        message: finding.message,
        why: rule?.why ?? '',
        fix: finding.fix ?? rule?.fix ?? '',
        ...(rule?.example ? { example: rule.example } : {}),
        docs: rule?.docs ?? [],
        ...(finding.blockedBy ? { blockedBy: finding.blockedBy } : {}),
      };
    }),
    warnings,
    analysedAt: now.toISOString(),
  };
}
