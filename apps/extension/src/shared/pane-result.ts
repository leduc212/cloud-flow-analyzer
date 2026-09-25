import { getRule, label, type FindingTarget, type FlowAnalysis } from '@cfa/core';
import type { FlowRef } from './flow-url.ts';

/** One step on the way to a finding's target: its kind and which branch of its parent holds it. */
export interface PathStep {
  name: string;
  /** Action kind (`scope`, `foreach`, `condition`, `switch`…) or `trigger`. */
  kind: string;
  /** `actions` / `else` (Condition), `case:<name>` / `default` (Switch), `actions` elsewhere. */
  branch?: string;
}

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
  /** The target's path with kinds and branches, to open collapsed branches in the designer. */
  steps: PathStep[];
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
  categories: { speed: number; resources: number; reliability: number; security: number };
  actionCount: number;
  estimate: { total: number; assumed: boolean };
  findings: PaneFinding[];
  /** Trigger and action names in designer order (top to bottom), to find actions off-screen. */
  order: string[];
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
      security: score.categories.security.score,
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
        steps: finding.target.path.map((name): PathStep => {
          const node = tree.byName.get(name);
          if (!node) return { name, kind: 'trigger' };
          return { name, kind: node.kind, ...(node.branch ? { branch: node.branch } : {}) };
        }),
        message: finding.message,
        why: rule?.why ?? '',
        fix: finding.fix ?? rule?.fix ?? '',
        ...(rule?.example ? { example: rule.example } : {}),
        docs: rule?.docs ?? [],
        ...(finding.blockedBy ? { blockedBy: finding.blockedBy } : {}),
      };
    }),
    order: [...tree.triggers.map((t) => t.name), ...tree.all.map((n) => n.name)],
    warnings,
    analysedAt: now.toISOString(),
  };
}
