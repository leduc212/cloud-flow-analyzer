// Analyse flow definitions from the command line.
//
//   pnpm analyse <file.json> [more files…]
//
// Accepts a flow from the Power Automate API or an export package, Dataverse clientdata, a bare
// definition, or a capture file from the extension's capture tool (every flow in it is analysed,
// with the runs recorded for it).
import { readFileSync } from 'node:fs';
import {
  analyseFlow,
  getRule,
  label,
  runSamplesFromResponses,
  type Finding,
  type RunSample,
} from '@cfa/core';

interface Candidate {
  source: string;
  input: unknown;
  runs?: RunSample[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flows inside a capture file: every recorded response that carries a definition. */
function fromCapture(file: string, capture: Record<string, unknown>): Candidate[] {
  const requests = (Array.isArray(capture.requests) ? capture.requests : []).filter(isObject);
  const runs = runSamplesFromResponses(
    requests.map((r) => ({ url: String(r.url ?? ''), body: r.body })),
  );
  return requests.flatMap((request): Candidate[] => {
    if (!isObject(request.body)) return [];
    const properties = request.body.properties;
    if (!isObject(properties) || !isObject(properties.definition)) return [];
    const flowRuns = runs.get(String(request.body.name));
    return [
      {
        source: `${file} → ${String(request.label ?? request.url)}`,
        input: request.body,
        ...(flowRuns?.length ? { runs: flowRuns } : {}),
      },
    ];
  });
}

function candidates(file: string): Candidate[] {
  const json: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (isObject(json) && json.tool === 'cloud-flow-analyzer-capture') return fromCapture(file, json);
  return [{ source: file, input: json }];
}

function target(finding: Finding): string {
  if (finding.target.kind === 'flow') return 'flow';
  return label(finding.target.name ?? '');
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: pnpm analyse <flow-or-capture.json> [more files…]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  for (const { source, input, runs } of candidates(file)) {
    try {
      const { tree, findings, score, estimate, warnings, runStats } = analyseFlow(
        input,
        runs ? { runs } : {},
      );
      const c = score.categories;
      console.log(`\n${tree.displayName ?? source}`);
      console.log(
        `  ${score.grade} (${score.overall}) · speed ${c.speed.score} · resources ${c.resources.score} · reliability ${c.reliability.score} · security ${c.security.score}${score.capped ? ' (capped at C)' : ''}` +
          ` · ${tree.actionCount} actions · ~${estimate.total.toLocaleString('en-US')} per run${estimate.assumed ? ' (assumed loop sizes)' : ''}`,
      );
      if (runStats) {
        const statuses = Object.entries(runStats.statuses)
          .map(([status, count]) => `${count} ${status.toLowerCase()}`)
          .join(', ');
        console.log(
          `  runs: ${runStats.sampled} (${statuses}) · median ${(runStats.durationP50Ms / 1000).toFixed(1)} s`,
        );
      }
      for (const finding of findings) {
        const rule = getRule(finding.ruleId);
        console.log(
          `  ${finding.severity.toUpperCase().padEnd(6)} ${finding.ruleId}  ${target(finding)}: ${finding.message}`,
        );
        console.log(`         fix: ${finding.fix ?? rule?.fix ?? ''}`);
      }
      if (findings.length === 0) console.log('  No findings.');
      for (const warning of warnings) console.log(`  warning: ${warning}`);
    } catch (error) {
      failed = true;
      console.log(
        `\n${source}\n  error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
process.exit(failed ? 1 : 0);
