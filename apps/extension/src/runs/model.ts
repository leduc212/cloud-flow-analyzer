// The Runs page: a flow's runs, filtering them by duration, status and start time, the
// duration histogram, and export. Plain data only, so it can be tested without a browser.
import { percentile } from '@cfa/core';
import type { ListedRun } from '../api/runs.ts';
import { formatDuration } from '../content/report.ts';
import { flowRunUrl } from '../shared/flow-url.ts';

export interface RunRow {
  name: string;
  status: string;
  startTime?: string;
  endTime?: string;
  /** Start time in ms (NaN when unknown). */
  start: number;
  /** How long it took, or for a run still going, how long it has been going. */
  durationMs?: number;
  running: boolean;
}

export interface RunFilter {
  /** At least this long. */
  minMs?: number;
  /** At most this long. */
  maxMs?: number;
  /** Statuses turned off (lower case). */
  hidden: ReadonlySet<string>;
  /** Started at or after (ms). */
  from?: number;
  /** Started at or before (ms). */
  to?: number;
}

export type RunSortKey = 'started' | 'duration';
export type DurationUnit = 's' | 'min' | 'h';

export const UNIT_MS: Record<DurationUnit, number> = { s: 1000, min: 60_000, h: 3_600_000 };

const STILL_GOING = new Set(['running', 'waiting', 'paused']);

export function toRows(runs: ListedRun[], now: number): RunRow[] {
  return runs.map((run) => {
    const start = Date.parse(run.startTime ?? '');
    const end = Date.parse(run.endTime ?? '');
    const running = STILL_GOING.has(run.status.toLowerCase());
    const until = Number.isNaN(end) ? (running ? now : NaN) : end;
    const durationMs = Number.isNaN(start) || Number.isNaN(until) ? undefined : until - start;
    return {
      name: run.name,
      status: run.status,
      ...(run.startTime ? { startTime: run.startTime } : {}),
      ...(run.endTime ? { endTime: run.endTime } : {}),
      start,
      ...(durationMs !== undefined ? { durationMs: Math.max(0, durationMs) } : {}),
      running,
    };
  });
}

/** A duration typed into the page, in ms; undefined when empty or not a positive number. */
export function parseDuration(value: string, unit: DurationUnit): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * UNIT_MS[unit]) : undefined;
}

/** A duration as a number and unit for the inputs: the largest unit that keeps it ≥ 1. */
export function splitDuration(ms: number): { value: string; unit: DurationUnit } {
  const unit: DurationUnit = ms >= UNIT_MS.h ? 'h' : ms >= UNIT_MS.min ? 'min' : 's';
  const value = Math.round((ms / UNIT_MS[unit]) * 10) / 10;
  return { value: String(value), unit };
}

export function matches(row: RunRow, filter: RunFilter): boolean {
  if (filter.hidden.has(row.status.toLowerCase())) return false;
  if (filter.minMs !== undefined && !((row.durationMs ?? -1) >= filter.minMs)) return false;
  if (filter.maxMs !== undefined && !((row.durationMs ?? Infinity) <= filter.maxMs)) return false;
  if (filter.from !== undefined && !(row.start >= filter.from)) return false;
  if (filter.to !== undefined && !(row.start <= filter.to)) return false;
  return true;
}

export function filterRuns(rows: RunRow[], filter: RunFilter): RunRow[] {
  return rows.filter((row) => matches(row, filter));
}

/** Sorted copy; runs without a duration go last when sorting by duration. */
export function sortRuns(rows: RunRow[], key: RunSortKey, descending = true): RunRow[] {
  const direction = descending ? -1 : 1;
  const value = (row: RunRow) => (key === 'started' ? row.start : row.durationMs);
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const missingX = x === undefined || Number.isNaN(x);
    const missingY = y === undefined || Number.isNaN(y);
    if (missingX || missingY) return missingX === missingY ? 0 : missingX ? 1 : -1;
    return direction * (x - y) || b.start - a.start;
  });
}

/** Count per status, most common first. */
export function statusCounts(rows: RunRow[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface DurationStats {
  /** Runs with a duration. */
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Durations of finished runs (runs still going haven't got one yet). */
export function durationStats(rows: RunRow[]): DurationStats {
  const durations = rows.flatMap((r) =>
    !r.running && r.durationMs !== undefined ? [r.durationMs] : [],
  );
  return {
    count: durations.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length > 0 ? Math.max(...durations) : 0,
  };
}

/** Histogram bucket edges: roughly logarithmic, at durations people think in. */
export const BUCKET_EDGES_MS = [
  0, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
  7_200_000, 21_600_000, 86_400_000,
];

export interface Bucket {
  fromMs: number;
  /** Undefined for the last, open-ended bucket. */
  toMs?: number;
  count: number;
  /** Runs in the bucket that the filter keeps. */
  matching: number;
}

/** Runs per duration bucket, from the first bucket with runs to the last. */
export function histogram(rows: RunRow[], filter: RunFilter): Bucket[] {
  const buckets: Bucket[] = BUCKET_EDGES_MS.map((fromMs, i) => {
    const toMs = BUCKET_EDGES_MS[i + 1];
    return { fromMs, ...(toMs !== undefined ? { toMs } : {}), count: 0, matching: 0 };
  });
  for (const row of rows) {
    if (row.durationMs === undefined) continue;
    let i = BUCKET_EDGES_MS.length - 1;
    while (i > 0 && row.durationMs < (BUCKET_EDGES_MS[i] ?? 0)) i--;
    const bucket = buckets[i]!;
    bucket.count += 1;
    if (matches(row, filter)) bucket.matching += 1;
  }
  const first = buckets.findIndex((b) => b.count > 0);
  if (first < 0) return [];
  const last = buckets.length - 1 - [...buckets].reverse().findIndex((b) => b.count > 0);
  return buckets.slice(first, last + 1);
}

/** A bucket's range in words: "1–2 min", "under 1 s", "1 d or more". */
export function bucketLabel(bucket: Bucket): string {
  const short = (ms: number) => {
    if (ms >= 86_400_000) return `${ms / 86_400_000} d`;
    if (ms >= 3_600_000) return `${ms / 3_600_000} h`;
    if (ms >= 60_000) return `${ms / 60_000} min`;
    return `${ms / 1000} s`;
  };
  if (bucket.toMs === undefined) return `${short(bucket.fromMs)} or more`;
  if (bucket.fromMs === 0) return `under ${short(bucket.toMs)}`;
  const [from, fromUnit] = short(bucket.fromMs).split(' ');
  const [to, toUnit] = short(bucket.toMs).split(' ');
  return fromUnit === toUnit
    ? `${from}–${to} ${toUnit}`
    : `${short(bucket.fromMs)}–${short(bucket.toMs)}`;
}

/** The filter in words, for exports: "longer than 5.0 min, Failed only". */
export function describeFilter(filter: RunFilter, statuses: string[]): string {
  const parts: string[] = [];
  if (filter.minMs !== undefined) parts.push(`at least ${formatDuration(filter.minMs)}`);
  if (filter.maxMs !== undefined) parts.push(`at most ${formatDuration(filter.maxMs)}`);
  const shown = statuses.filter((s) => !filter.hidden.has(s.toLowerCase()));
  if (shown.length < statuses.length) parts.push(`${shown.join(', ') || 'no status'} only`);
  if (filter.from !== undefined) parts.push(`started from ${new Date(filter.from).toISOString()}`);
  if (filter.to !== undefined) parts.push(`started until ${new Date(filter.to).toISOString()}`);
  return parts.length > 0 ? parts.join(', ') : 'all runs';
}

/** A CSV field, quoted when needed, and never read as a formula by a spreadsheet. */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function runsCsv(rows: RunRow[], environment: string, flowName: string): string {
  const lines = [
    ['run', 'status', 'started', 'ended', 'duration_seconds', 'still_running', 'url'],
    ...rows.map((row) => [
      row.name,
      row.status,
      row.startTime ?? '',
      row.endTime ?? '',
      row.durationMs !== undefined ? (row.durationMs / 1000).toFixed(1) : '',
      row.running ? 'yes' : 'no',
      flowRunUrl(environment, flowName, row.name),
    ]),
  ];
  return `${lines.map((line) => line.map(csvField).join(',')).join('\r\n')}\r\n`;
}

const cell = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** The runs as a Markdown table (at most `max` rows), for a ticket or a team chat. */
export function runsMarkdown(
  rows: RunRow[],
  options: { environment: string; flowName: string; displayName: string; filter: string },
  max = 50,
): string {
  const shown = rows.slice(0, max);
  return [
    `# Runs of ${cell(options.displayName)}`,
    '',
    `${rows.length} runs (${cell(options.filter)})${rows.length > max ? `, the first ${max} listed` : ''}.`,
    '',
    '| Started (UTC) | Duration | Status | Run |',
    '| --- | --- | --- | --- |',
    ...shown.map(
      (row) =>
        `| ${row.startTime?.replace('T', ' ').slice(0, 19) ?? '–'} | ${row.durationMs !== undefined ? `${formatDuration(row.durationMs)}${row.running ? ' (running)' : ''}` : '–'} | ${cell(row.status)} | [${cell(row.name)}](${flowRunUrl(options.environment, options.flowName, row.name)}) |`,
    ),
    '',
    '_Generated by Cloud Flow Analyzer._',
  ].join('\n');
}
