import type { FlowRef } from '../shared/flow-url.ts';
import type { HostKind } from '../shared/hosts.ts';
import type { TokenRecord } from '../shared/token.ts';
import { ApiError, NoTokenError, type ApiClient } from './client.ts';
import { flowApi, powerPlatformFlowUrl, type FlowSummary } from './flows.ts';

const notFound = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);

/**
 * Fetches a flow (with its definition) by the ID shown in the portal URL. Tries, in order:
 * the Power Automate API, its admin endpoint, a lookup by Dataverse workflow ID (solution
 * pages can show that instead of the flow name), and the Power Platform API.
 */
export async function fetchFlow(
  client: ApiClient,
  tokens: Partial<Record<HostKind, TokenRecord>>,
  ref: FlowRef,
): Promise<unknown> {
  const origin = tokens.flow?.origins[0];
  if (origin) {
    const api = flowApi(origin);
    try {
      return await client.get(api.flow(ref.environment, ref.flowId), 'flow');
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    try {
      return await client.get(api.flow(ref.environment, ref.flowId, true), 'flow (admin)');
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    const name = await findByWorkflowId(client, origin, ref);
    if (name) return client.get(api.flow(ref.environment, name), 'flow (by workflow ID)');
  }
  if (tokens.powerplatform) {
    return client.get(
      powerPlatformFlowUrl(ref.environment, ref.flowId),
      'flow (Power Platform API)',
    );
  }
  if (!origin) throw new NoTokenError('flow');
  throw new ApiError(
    "This flow wasn't found. It may have been deleted, or you may not have access to it.",
    404,
    '',
  );
}

async function findByWorkflowId(
  client: ApiClient,
  origin: string,
  ref: FlowRef,
): Promise<string | undefined> {
  const api = flowApi(origin);
  for (const source of ['default', 'admin'] as const) {
    try {
      const flows = await client.getAll<FlowSummary>(
        api.flows(ref.environment, source),
        `flows (${source})`,
        5000,
        50,
      );
      const match = flows.find((f) => f.properties?.workflowEntityId?.toLowerCase() === ref.flowId);
      if (match) return match.name;
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  return undefined;
}
