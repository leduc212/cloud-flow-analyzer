/** The environment and flow a maker portal page is showing. */
export interface FlowRef {
  environment: string;
  /** The ID in the URL: the flow's name, or for some solution pages its Dataverse workflow ID. */
  flowId: string;
}

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FLOW_PATH = new RegExp(
  `/environments/([^/?#]+)/(?:[^?#]*/)?(?:flows|cloudflows)/(?:shared/)?(${GUID})`,
  'i',
);

/**
 * Reads the flow from a maker portal URL: flow details, designer (classic or new), run history,
 * and flows opened from a solution, on make.powerautomate.com or make.powerapps.com.
 */
export function parseFlowUrl(url: string | undefined): FlowRef | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!/^make\.(preview\.)?(powerautomate|powerapps)\.com$/i.test(parsed.hostname))
    return undefined;
  const match = FLOW_PATH.exec(parsed.pathname);
  if (!match?.[1] || !match[2]) return undefined;
  return { environment: decodeURIComponent(match[1]), flowId: match[2].toLowerCase() };
}
