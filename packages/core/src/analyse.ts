import { estimateActionsPerRun, type ActionEstimate, type EstimateOptions } from './estimate.ts';
import { parseFlow } from './parser.ts';
import { RULES } from './rules/index.ts';
import type { Rule } from './rules/rule.ts';
import { scoreFindings, type Score } from './scoring.ts';
import type { Finding, FlowTree, Severity } from './types.ts';

export interface AnalyseOptions {
  /** Rules to run. Defaults to every rule that isn't off by default. */
  rules?: Rule[];
  estimate?: EstimateOptions;
  isAccepted?: (finding: Finding) => boolean;
}

export interface FlowAnalysis {
  tree: FlowTree;
  findings: Finding[];
  score: Score;
  estimate: ActionEstimate;
  /** Parser warnings plus rules that failed on this flow. Never fatal. */
  warnings: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function runRules(tree: FlowTree, rules: Rule[], warnings: string[] = []): Finding[] {
  const order = new Map(tree.all.map((node, index) => [node.name, index]));
  const findings: Finding[] = [];
  for (const rule of rules) {
    try {
      for (const match of rule.check({ tree })) {
        findings.push({
          ...match,
          ruleId: rule.id,
          category: rule.category,
          severity: match.severity ?? rule.severity,
          confidence: match.confidence ?? rule.confidence,
        });
      }
    } catch (error) {
      warnings.push(
        `Rule ${rule.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const position = (f: Finding) =>
    f.target.kind === 'action' ? (order.get(f.target.name ?? '') ?? 0) + 1 : 0;
  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.confidence - a.confidence ||
      position(a) - position(b),
  );
}

/** Parses a flow (any shape `readFlow` accepts), runs the rules and scores the result. */
export function analyseFlow(input: unknown, options: AnalyseOptions = {}): FlowAnalysis {
  const tree = parseFlow(input);
  const warnings = [...tree.warnings];
  const rules = options.rules ?? RULES.filter((rule) => !rule.offByDefault);
  const findings = runRules(tree, rules, warnings);
  return {
    tree,
    findings,
    score: scoreFindings(findings, options.isAccepted),
    estimate: estimateActionsPerRun(tree, options.estimate),
    warnings,
  };
}
