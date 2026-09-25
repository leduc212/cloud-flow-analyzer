// URL builders for the Power Automate API (api.flow.microsoft.com, api-version 2016-11-01).
// These are the Logic Apps-style paths the maker portal uses; spike S1 confirms them against
// the endpoints the capture tool records.

export const FLOW_API_VERSION = '2016-11-01';
const PROCESS_SIMPLE = '/providers/Microsoft.ProcessSimple';

/** Where a flow list comes from. */
export type FlowSource = 'default' | 'personal' | 'team' | 'admin';

export const FLOW_SOURCE_LABELS: Record<FlowSource, string> = {
  default: 'Default list',
  personal: "My flows (search('personal'))",
  team: "Shared with me (search('team'))",
  admin: 'Admin: all flows in the environment',
};

export interface Environment {
  name: string;
  properties?: {
    displayName?: string;
    isDefault?: boolean;
    azureRegion?: string;
  };
}

export interface FlowSummary {
  name: string;
  id?: string;
  properties?: {
    displayName?: string;
    state?: string;
    createdTime?: string;
    lastModifiedTime?: string;
    workflowEntityId?: string;
    definitionSummary?: { triggers?: { type?: string; kind?: string }[] };
  };
}

export interface FlowRun {
  name: string;
  properties?: { startTime?: string; endTime?: string; status?: string };
}

export interface RunAction {
  name: string;
  properties?: {
    startTime?: string;
    endTime?: string;
    status?: string;
    code?: string;
    repetitionCount?: number;
  };
}

const e = encodeURIComponent;

export function flowApi(origin: string) {
  const version = `api-version=${FLOW_API_VERSION}`;
  const env = (environment: string) => `${origin}${PROCESS_SIMPLE}/environments/${e(environment)}`;
  const flow = (environment: string, flowName: string) =>
    `${env(environment)}/flows/${e(flowName)}`;
  const run = (environment: string, flowName: string, runName: string) =>
    `${flow(environment, flowName)}/runs/${e(runName)}`;

  return {
    environments: () => `${origin}${PROCESS_SIMPLE}/environments?${version}`,
    flows(environment: string, source: FlowSource): string {
      if (source === 'admin') {
        return `${origin}${PROCESS_SIMPLE}/scopes/admin/environments/${e(environment)}/v2/flows?${version}`;
      }
      const filter = source === 'default' ? '' : `&$filter=${e(`search('${source}')`)}`;
      return `${env(environment)}/flows?${version}${filter}`;
    },
    flow(environment: string, flowName: string, admin = false): string {
      if (admin) {
        return `${origin}${PROCESS_SIMPLE}/scopes/admin/environments/${e(environment)}/flows/${e(flowName)}?${version}`;
      }
      return `${flow(environment, flowName)}?${version}`;
    },
    runs: (environment: string, flowName: string, top: number) =>
      `${flow(environment, flowName)}/runs?${version}&$top=${top}`,
    runActions: (environment: string, flowName: string, runName: string) =>
      `${run(environment, flowName, runName)}/actions?${version}`,
    repetitions: (environment: string, flowName: string, runName: string, actionName: string) =>
      `${run(environment, flowName, runName)}/actions/${e(actionName)}/repetitions?${version}`,
  };
}

export type FlowApi = ReturnType<typeof flowApi>;
