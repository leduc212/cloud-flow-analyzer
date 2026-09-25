import { label } from '../parser.ts';
import type { RunSample, RunStats } from '../runs.ts';
import type {
  ActionNode,
  Category,
  Finding,
  FindingTarget,
  FlowTree,
  Severity,
  TriggerNode,
} from '../types.ts';

/** Which runs were read: the latest ones, or the slowest of the latest. */
export type RunSampleMode = 'recent' | 'slowest';

export interface RuleContext {
  tree: FlowTree;
  /** Recent runs, when the user asked for run analysis. */
  runs?: { samples: RunSample[]; stats: RunStats; mode: RunSampleMode; runsPerDay?: number };
  settings?: { dailyRequestLimit?: number };
}

/** What a rule reports; the engine adds the rule's id, category and defaults. */
export type RuleMatch = Omit<Finding, 'ruleId' | 'category' | 'severity' | 'confidence'> &
  Partial<Pick<Finding, 'severity' | 'confidence'>>;

export interface Rule {
  id: string;
  category: Category;
  severity: Severity;
  confidence: number;
  title: string;
  why: string;
  fix: string;
  example?: { before: string; after: string };
  docs: string[];
  /** Uses run data when available (📊). */
  usesRunData?: boolean;
  /** Off unless the user turns it on (e.g. maintainability rules). */
  offByDefault?: boolean;
  check(ctx: RuleContext): RuleMatch[];
}

const GUIDANCE = 'https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines';
export const DOCS = {
  parallel: `${GUIDANCE}/implement-parallel-execution`,
  antiPatterns: `${GUIDANCE}/avoid-anti-patterns`,
  triggers: `${GUIDANCE}/optimize-power-automate-triggers`,
  relevantData: `${GUIDANCE}/work-with-relevant-data`,
  dataOperations: `${GUIDANCE}/use-data-operations`,
  errorHandling: `${GUIDANCE}/error-handling`,
  understandLimits: `${GUIDANCE}/understand-limits`,
  childFlows: `${GUIDANCE}/create-reusable-code`,
  limits: 'https://learn.microsoft.com/en-us/power-automate/limits-and-config',
  dataverseTrigger:
    'https://learn.microsoft.com/en-us/power-automate/dataverse/create-update-delete-trigger',
  listRows: 'https://learn.microsoft.com/en-us/power-automate/dataverse/list-rows',
  loops: 'https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-control-flow-loops',
  secureData: `${GUIDANCE}/use-secure-inputs-outputs-triggers`,
  genericConfig: `${GUIDANCE}/keep-flow-configuration-generic`,
  keyVaultVariables:
    'https://learn.microsoft.com/en-us/power-apps/maker/data-platform/environmentvariables-azure-key-vault-secrets',
  bulkOperations:
    'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/bulk-operations',
  sharePointGetItems:
    'https://learn.microsoft.com/en-us/sharepoint/dev/business-apps/power-automate/guidance/working-with-get-items-and-get-files',
  expressions: 'https://learn.microsoft.com/en-us/power-automate/expression-cookbook',
  httpTrigger: 'https://learn.microsoft.com/en-us/power-automate/oauth-authentication',
  naming: `${GUIDANCE}/use-consistent-naming-conventions`,
  dataverseUpdates:
    'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/update-delete-entities-using-web-api',
  requestLimits:
    'https://learn.microsoft.com/en-us/power-platform/admin/api-request-limits-allocations',
  whatCounts:
    'https://learn.microsoft.com/en-us/power-platform/admin/power-automate-licensing/faqs#what-counts-as-an-action',
} as const;

/**
 * A readable title for a docs link, from its address: `…/implement-parallel-execution` →
 * "Implement parallel execution" (the anchor wins when there is one).
 */
export function docLabel(url: string): string {
  let slug = url;
  try {
    const parsed = new URL(url);
    slug = parsed.hash.slice(1) || parsed.pathname.split('/').filter(Boolean).pop() || url;
  } catch {
    // Not a URL: use it as it is.
  }
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function actionTarget(node: ActionNode): FindingTarget {
  return { kind: 'action', name: node.name, path: node.path };
}

export function triggerTarget(trigger: TriggerNode): FindingTarget {
  return { kind: 'trigger', name: trigger.name, path: [trigger.name] };
}

export const FLOW_TARGET: FindingTarget = { kind: 'flow', path: [] };

/** `Get_a_row` → `"Get a row"` for messages. */
export function q(name: string): string {
  return `"${label(name)}"`;
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;
}

export function isIo(node: ActionNode): boolean {
  return node.kind === 'connector' || node.kind === 'http' || node.kind === 'child-flow';
}
