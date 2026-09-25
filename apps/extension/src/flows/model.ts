// The "All flows" page: its rows, what one flow's analysis boils down to, and sorting,
// filtering and export. Plain data only, so it can be tested without a browser.
import { connectorName, getRule, label, type FlowAnalysis } from '@cfa/core';
import type { FlowSource, FlowSummary } from '../api/flows.ts';

export interface RowAnalysis {
  grade: string;
  score: number;
  /** An open high-severity security finding capped the grade at C. */
  capped: boolean;
  counts: { high: number; medium: number; low: number };
  /** The most important findings, most severe first. */
  top: { ruleId: string; title: string; target: string; severity: string }[];
  actionCount: number;
}

export interface FlowRow {
  name: string;
  displayName: string;
  state: string;
  suspension?: string;
  trigger: string;
  sources: FlowSource[];
  lastModified?: string;
  analysis?: RowAnalysis;
  /** Why the flow couldn't be read or analysed. */
  error?: string;
}

export type SortKey = 'name' | 'grade' | 'issues' | 'modified';
export type RowFilter = 'all' | 'needs-work' | 'high' | 'not-analysed';

const TRIGGER_KINDS: Record<string, string> = {
  button: 'Manual (button)',
  powerapp: 'Power Apps',
  powerappv2: 'Power Apps',
  skills: 'Copilot Studio',
  http: 'HTTP request',
  teams: 'Microsoft Teams',
};

/** A short, readable trigger description from the list's `definitionSummary`. */
export function triggerLabel(summary: FlowSummary): string {
  const trigger = summary.properties?.definitionSummary?.triggers?.[0] as
    | { type?: string; kind?: string; swaggerOperationId?: string; api?: { name?: string } }
    | undefined;
  if (!trigger?.type) return 'Unknown';
  const type = trigger.type.toLowerCase();
  if (type === 'recurrence') return 'Schedule';
  if (type === 'request') return TRIGGER_KINDS[trigger.kind?.toLowerCase() ?? ''] ?? 'Manual';
  const api = trigger.api?.name;
  if (
    api === 'shared_commondataserviceforapps' &&
    trigger.swaggerOperationId === 'SubscribeWebhookTrigger'
  ) {
    return 'Dataverse: row changes';
  }
  if (api)
    return `${connectorName(api)}${trigger.swaggerOperationId ? `: ${trigger.swaggerOperationId}` : ''}`;
  return trigger.type;
}

/** One row per flow, merging the lists it appears in (a flow can be in several). */
export function mergeFlowLists(lists: Partial<Record<FlowSource, FlowSummary[]>>): FlowRow[] {
  const rows = new Map<string, FlowRow>();
  for (const [source, flows] of Object.entries(lists) as [FlowSource, FlowSummary[]][]) {
    for (const summary of flows) {
      const existing = rows.get(summary.name);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        continue;
      }
      const p = summary.properties;
      const suspension = (p as { flowSuspensionReason?: string } | undefined)?.flowSuspensionReason;
      rows.set(summary.name, {
        name: summary.name,
        displayName: p?.displayName ?? summary.name,
        state: p?.state ?? 'Unknown',
        ...(suspension && suspension !== 'None' ? { suspension } : {}),
        trigger: triggerLabel(summary),
        sources: [source],
        ...(p?.lastModifiedTime ? { lastModified: p.lastModifiedTime } : {}),
      });
    }
  }
  return [...rows.values()];
}

/** What the table shows about one flow's analysis. */
export function summariseAnalysis(analysis: FlowAnalysis, top = 3): RowAnalysis {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of analysis.findings) counts[finding.severity] += 1;
  return {
    grade: analysis.score.grade,
    score: analysis.score.overall,
    capped: analysis.score.capped === true,
    counts,
    // Findings arrive sorted by severity, then confidence.
    top: analysis.findings.slice(0, top).map((f) => ({
      ruleId: f.ruleId,
      title: getRule(f.ruleId)?.title ?? f.ruleId,
      target: f.target.name ? label(f.target.name) : 'Whole flow',
      severity: f.severity,
    })),
    actionCount: analysis.tree.actionCount,
  };
}

const issueWeight = (a?: RowAnalysis) =>
  a ? a.counts.high * 10_000 + a.counts.medium * 100 + a.counts.low : -1;

/** Sorted copy. Flows not analysed yet go last, whatever the direction. */
export function sortRows(rows: FlowRow[], key: SortKey, descending = false): FlowRow[] {
  const direction = descending ? -1 : 1;
  const compare = (a: FlowRow, b: FlowRow): number => {
    switch (key) {
      case 'name':
        return a.displayName.localeCompare(b.displayName);
      case 'modified':
        return (a.lastModified ?? '').localeCompare(b.lastModified ?? '');
      case 'grade':
        // Worst first when ascending: that's what people look for.
        return (a.analysis?.score ?? 0) - (b.analysis?.score ?? 0);
      case 'issues':
        return issueWeight(b.analysis) - issueWeight(a.analysis);
    }
  };
  return [...rows].sort((a, b) => {
    if (key !== 'name' && key !== 'modified' && !a.analysis !== !b.analysis) {
      return a.analysis ? -1 : 1;
    }
    return direction * compare(a, b) || a.displayName.localeCompare(b.displayName);
  });
}

export function filterRows(rows: FlowRow[], query: string, filter: RowFilter): FlowRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (q && !`${row.displayName} ${row.trigger}`.toLowerCase().includes(q)) return false;
    switch (filter) {
      case 'needs-work':
        return row.analysis !== undefined && !['A', 'B'].includes(row.analysis.grade);
      case 'high':
        return (row.analysis?.counts.high ?? 0) > 0;
      case 'not-analysed':
        return row.analysis === undefined;
      default:
        return true;
    }
  });
}

/** A Markdown table cell: backslashes first, then pipes, so neither can break the table. */
const cell = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** The analysed flows as a Markdown table, worst first, for a ticket or a team chat. */
export function markdownSummary(rows: FlowRow[], environment: string, now = new Date()): string {
  const analysed = sortRows(
    rows.filter((r) => r.analysis),
    'grade',
  );
  const lines = [
    `# Flow analysis: ${environment}`,
    '',
    `${analysed.length} of ${rows.length} flows analysed on ${now.toISOString().slice(0, 10)}.`,
    '',
    '| Flow | Grade | High | Medium | Low | Top finding |',
    '| --- | --- | --- | --- | --- | --- |',
    ...analysed.map((row) => {
      const a = row.analysis!;
      const top = a.top[0];
      return `| ${cell(row.displayName)} | ${a.grade} (${a.score}) | ${a.counts.high} | ${a.counts.medium} | ${a.counts.low} | ${top ? cell(`${top.ruleId} ${top.title}: ${top.target}`) : '–'} |`;
    }),
    '',
    '_Generated by Cloud Flow Analyzer._',
  ];
  return lines.join('\n');
}
