import { ancestors, analyseFlow, createAnonymiser, type FlowAnalysis } from '@cfa/core';
import {
  ApiError,
  NoTokenError,
  type ApiClient,
  type ApiList,
  type RecordedRequest,
} from '../api/client.ts';
import type { FlowApi, FlowRun, FlowSource, FlowSummary, RunAction } from '../api/flows.ts';
import type { EndpointRecord } from '../shared/endpoints.ts';
import type { TokenRecord } from '../shared/token.ts';

export interface CapturedFlow {
  name: string;
  displayName: string;
  sources: FlowSource[];
  summary: FlowSummary;
}

export interface FlowResult {
  flow: string;
  displayName: string;
  grade?: string;
  score?: number;
  actionCount?: number;
  estimatedActionsPerRun?: number;
  findings: {
    ruleId: string;
    severity: string;
    confidence: number;
    target: string;
    /** Not called `message`: the anonymiser replaces free text under that key. */
    detail: string;
    fix?: string;
    blockedBy?: string[];
  }[];
  warnings: string[];
  error?: string;
}

export interface CaptureOptions {
  runsPerFlow: number;
  repetitionPages: number;
  /** Most loop actions whose repetitions are fetched per run. */
  maxLoopActions?: number;
}

export function summarise(flow: CapturedFlow, analysis: FlowAnalysis): FlowResult {
  return {
    flow: flow.name,
    displayName: flow.displayName,
    grade: analysis.score.grade,
    score: analysis.score.overall,
    actionCount: analysis.tree.actionCount,
    estimatedActionsPerRun: analysis.estimate.total,
    findings: analysis.findings.map((f) => ({
      ruleId: f.ruleId,
      severity: f.severity,
      confidence: f.confidence,
      target: f.target.path.join(' › ') || 'flow',
      detail: f.message,
      ...(f.fix ? { fix: f.fix } : {}),
      ...(f.blockedBy ? { blockedBy: f.blockedBy } : {}),
    })),
    warnings: analysis.warnings,
  };
}

function isFatal(error: unknown): boolean {
  return (
    error instanceof NoTokenError ||
    (error instanceof ApiError && error.status === 401) ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

/** Waits for a request whose failure is already recorded; only fatal errors stop the capture. */
async function soft<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request;
  } catch (error) {
    if (isFatal(error)) throw error;
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Captures one flow: its definition (falling back to the admin endpoint for admin-listed flows),
 * then its latest runs, each run's actions, and the repetitions of actions inside loops.
 */
export async function captureFlow(
  client: ApiClient,
  api: FlowApi,
  environment: string,
  flow: CapturedFlow,
  options: CaptureOptions,
): Promise<FlowResult> {
  let definition: unknown;
  try {
    definition = await client.get(api.flow(environment, flow.name), `flow: ${flow.displayName}`);
  } catch (error) {
    const denied = error instanceof ApiError && (error.status === 403 || error.status === 404);
    if (!denied || !flow.sources.includes('admin') || isFatal(error)) {
      if (isFatal(error)) throw error;
      return {
        flow: flow.name,
        displayName: flow.displayName,
        findings: [],
        warnings: [],
        error: errorText(error),
      };
    }
    try {
      definition = await client.get(
        api.flow(environment, flow.name, true),
        `flow (admin): ${flow.displayName}`,
      );
    } catch (adminError) {
      if (isFatal(adminError)) throw adminError;
      return {
        flow: flow.name,
        displayName: flow.displayName,
        findings: [],
        warnings: [],
        error: errorText(adminError),
      };
    }
  }

  let analysis: FlowAnalysis | undefined;
  let result: FlowResult;
  try {
    analysis = analyseFlow(definition);
    result = summarise(flow, analysis);
  } catch (error) {
    result = {
      flow: flow.name,
      displayName: flow.displayName,
      findings: [],
      warnings: [],
      error: errorText(error),
    };
  }

  if (options.runsPerFlow <= 0) return result;
  const runs = await soft(
    client.get<ApiList<FlowRun>>(
      api.runs(environment, flow.name, options.runsPerFlow),
      `runs: ${flow.displayName}`,
    ),
  );
  const tree = analysis?.tree;
  const loopActions = tree
    ? tree.all
        .filter((node) =>
          ancestors(tree, node).some((a) => a.kind === 'foreach' || a.kind === 'until'),
        )
        .slice(0, options.maxLoopActions ?? 25)
    : [];

  await Promise.all(
    (runs?.value ?? []).slice(0, options.runsPerFlow).map(async (run) => {
      await soft(
        client.getAll<RunAction>(
          api.runActions(environment, flow.name, run.name),
          `run actions: ${flow.displayName}`,
          1000,
          10,
        ),
      );
      if (options.repetitionPages <= 0) return;
      await Promise.all(
        loopActions.map((action) =>
          soft(
            client.getAll(
              api.repetitions(environment, flow.name, run.name, action.name),
              `repetitions: ${flow.displayName} › ${action.name}`,
              5000,
              options.repetitionPages,
            ),
          ),
        ),
      );
    }),
  );
  return result;
}

export interface CaptureContents {
  environment?: string;
  tokens: TokenRecord[];
  endpoints: EndpointRecord[];
  flows: CapturedFlow[];
  requests: RecordedRequest[];
  results: FlowResult[];
}

export const CAPTURE_TOOL = 'cloud-flow-analyzer-capture';

/** The downloadable capture file. Tokens are described, never included. */
export function buildCaptureFile(
  contents: CaptureContents,
  options: { anonymise: boolean; extensionVersion: string; userAgent: string; now?: Date },
): unknown {
  const file = {
    tool: CAPTURE_TOOL,
    version: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    extensionVersion: options.extensionVersion,
    userAgent: options.userAgent,
    anonymised: options.anonymise,
    environment: contents.environment,
    tokens: contents.tokens.map((t) => ({
      kind: t.kind,
      audience: t.audience,
      tenantId: t.tenantId,
      account: t.account,
      expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : undefined,
      origins: t.origins,
    })),
    portalEndpoints: contents.endpoints,
    flows: contents.flows,
    requests: contents.requests,
    results: contents.results,
  };
  return options.anonymise ? createAnonymiser().value(file) : file;
}
