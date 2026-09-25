import { estimateActionsPerRun, type ActionEstimate, type EstimateOptions } from './estimate.ts';
import { enclosingLoops, parseFlow } from './parser.ts';
import { RULES } from './rules/index.ts';
import { plural, q, type Rule, type RuleContext, type RunSampleMode } from './rules/rule.ts';
import { summariseRuns, type RunSample, type RunStats } from './runs.ts';
import { scoreFindings, type Score } from './scoring.ts';
import type { Finding, FindingEvidence, FlowTree, Severity } from './types.ts';

export interface AnalyseOptions {
  /** Rules to run. Defaults to every rule that isn't off by default. */
  rules?: Rule[];
  estimate?: EstimateOptions;
  isAccepted?: (finding: Finding) => boolean;
  /** Recent runs of the flow. Rules marked 📊 then measure instead of assuming. */
  runs?: RunSample[];
  /** How the runs were picked: the latest ones (default), or the slowest of the latest. */
  sample?: RunSampleMode;
  /** How often the flow runs (see `runsPerDay`), for RES06. */
  runsPerDay?: number;
  /** The user's daily request limit (Power Platform requests per 24 hours), for RES06. */
  dailyRequestLimit?: number;
}

export interface FlowAnalysis {
  tree: FlowTree;
  findings: Finding[];
  score: Score;
  estimate: ActionEstimate;
  /** Statistics over the runs passed in `options.runs`. */
  runStats?: RunStats;
  /** Parser warnings plus rules that failed on this flow. Never fatal. */
  warnings: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export interface Measurement {
  evidence: FindingEvidence;
  /** One sentence for the finding's message. */
  note: string;
  /** The loop never had more than one item in the sampled runs. */
  singleItem: boolean;
}

/**
 * What the runs measured about a finding's target: the time share of the outermost loop it is
 * in (or of the action itself outside loops), the loop's items, and throttled calls.
 */
export function measure(
  tree: FlowTree,
  stats: RunStats,
  finding: Pick<Finding, 'target'>,
  mode: RunSampleMode = 'recent',
): Measurement | undefined {
  const node =
    finding.target.kind === 'action' ? tree.byName.get(finding.target.name ?? '') : undefined;
  if (!node) return undefined;
  const loops = enclosingLoops(tree, node);
  const isLoop = node.kind === 'foreach' || node.kind === 'until';
  const outer = loops[loops.length - 1] ?? node;
  const loop = isLoop ? node : loops[0];
  const time = stats.actions.get(outer.name);
  const share = time?.timeSharePct;
  const iterations = loop ? stats.loops.get(loop.name) : undefined;
  const own = stats.actions.get(node.name);
  const throttled = (own?.throttled ?? 0) + (own?.retries429 ?? 0);
  const evidence: FindingEvidence = {
    ...(share !== undefined ? { timeSharePct: share } : {}),
    ...(iterations ? { iterationsP50: iterations.iterationsP50 } : {}),
    ...(throttled > 0 ? { retries429: throttled } : {}),
  };
  const items = iterations
    ? `${iterations.iterationsP50}${iterations.truncated ? '+' : ''} ${iterations.iterationsP50 === 1 && !iterations.truncated ? 'item' : 'items'}`
    : '';
  const parts: string[] = [];
  if (share !== undefined && time) {
    const over = iterations && loop === outer ? ` over ${items}` : '';
    parts.push(
      `${q(outer.name)} took ${share}% of the run time (${formatMs(time.busyP50Ms)})${over}`,
    );
  }
  if (iterations && loop && (share === undefined || loop !== outer)) {
    const per = enclosingLoops(tree, loop).length > 0 ? ' per outer item' : '';
    parts.push(`${q(loop.name)} ran ${items}${per}`);
  }
  if (throttled > 0) parts.push(`it was throttled ${throttled}× (429)`);
  if (parts.length === 0) return undefined;
  const runs =
    mode === 'slowest'
      ? `the ${plural(stats.sampled, 'slowest recent run')}`
      : plural(stats.sampled, 'recent run');
  return {
    evidence,
    note: `In ${runs} (medians): ${parts.join('; ')}.`,
    singleItem: Boolean(iterations && !iterations.truncated && iterations.iterationsP95 <= 1),
  };
}

export function runRules(
  tree: FlowTree,
  rules: Rule[],
  warnings: string[] = [],
  runs?: RuleContext['runs'],
  settings?: RuleContext['settings'],
): Finding[] {
  const order = new Map(tree.all.map((node, index) => [node.name, index]));
  const findings: Finding[] = [];
  for (const rule of rules) {
    try {
      for (const match of rule.check({
        tree,
        ...(runs ? { runs } : {}),
        ...(settings ? { settings } : {}),
      })) {
        const finding: Finding = {
          ...match,
          ruleId: rule.id,
          category: rule.category,
          severity: match.severity ?? rule.severity,
          confidence: match.confidence ?? rule.confidence,
        };
        const measured =
          rule.usesRunData && runs ? measure(tree, runs.stats, finding, runs.mode) : undefined;
        if (measured) {
          finding.evidence = { ...measured.evidence, ...finding.evidence };
          finding.message = `${finding.message} ${measured.note}`;
          // Per-item costs hardly matter while the loop only ever gets one item.
          if (measured.singleItem) finding.severity = 'low';
        }
        findings.push(finding);
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
  const samples = options.runs;
  const runStats = samples ? summariseRuns(tree, samples) : undefined;
  const runs: RuleContext['runs'] =
    samples && runStats && runStats.sampled > 0
      ? {
          samples,
          stats: runStats,
          mode: options.sample ?? 'recent',
          ...(options.runsPerDay !== undefined ? { runsPerDay: options.runsPerDay } : {}),
        }
      : undefined;
  const settings =
    options.dailyRequestLimit !== undefined
      ? { dailyRequestLimit: options.dailyRequestLimit }
      : undefined;
  const findings = runRules(tree, rules, warnings, runs, settings);
  const measured = runStats
    ? Object.fromEntries([...runStats.loops.values()].map((l) => [l.name, l.iterationsP50]))
    : {};
  return {
    tree,
    findings,
    score: scoreFindings(findings, options.isAccepted),
    // Measured requests per run when the runs give them; otherwise the definition's estimate.
    estimate: runs?.stats.actionsPerRun
      ? { total: runs.stats.actionsPerRun.p50, assumed: false, measured: true }
      : estimateActionsPerRun(tree, {
          ...options.estimate,
          iterations: { ...measured, ...options.estimate?.iterations },
        }),
    ...(runStats ? { runStats } : {}),
    warnings,
  };
}
