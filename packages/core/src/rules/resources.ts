import {
  DATAVERSE,
  DATAVERSE_UPDATES,
  DATAVERSE_UPDATE_MESSAGES,
  EXCEL,
  SHAREPOINT,
  SQL,
  listOperation,
  sameTable,
  writeOperation,
} from '../connectors.ts';
import { asNumber, asString, hasValue } from '../definition.ts';
import { collectStrings } from '../expressions.ts';
import { descendants, enclosingLoops, isConcurrentLoop, singleRowSource } from '../parser.ts';
import type { ActionNode } from '../types.ts';
import {
  DOCS,
  FLOW_TARGET,
  actionTarget,
  plural,
  q,
  triggerTarget,
  type Rule,
  type RuleMatch,
} from './rule.ts';

const TRIGGER_DATA = /\btrigger(?:Outputs|Body)\(\)/;

export const RES01: Rule = {
  id: 'RES01',
  category: 'resources',
  severity: 'medium',
  confidence: 0.8,
  usesRunData: true,
  title: 'Most runs stop at the first check',
  why: 'Every run counts its actions toward your request limits, even when a Condition early in the flow finds there is nothing to do. A trigger condition makes the same check before the run starts, so those runs never happen.',
  fix: "Move the check into a trigger condition (trigger Settings → Trigger conditions), for example @equals(triggerOutputs()?['body/statuscode'], 1), then remove the Condition from the flow.",
  example: {
    before:
      "When a row is modified\nCondition  triggerOutputs()?['body/statuscode'] = 1\n  └ Yes: …   (most runs take No and end)",
    after:
      "When a row is modified\n  Trigger condition: @equals(triggerOutputs()?['body/statuscode'], 1)\n…   (runs start only when there is work)",
  },
  docs: [DOCS.triggers, DOCS.understandLimits],
  check({ tree, runs }) {
    // The slowest runs are the ones that did work: they say nothing about empty runs.
    if (!runs || runs.mode !== 'recent') return [];
    const trigger = tree.triggers[0];
    // Only event triggers take conditions on their data.
    if (!trigger || trigger.conditions.length > 0) return [];
    if (trigger.kind !== 'dataverse' && trigger.kind !== 'connector') return [];
    const check = tree.actions.find((n) => n.kind === 'condition');
    if (!check || check.references.length > 0 || check.variableRefs.length > 0) return [];
    if (!collectStrings(check.raw.expression).some((t) => TRIGGER_DATA.test(t))) return [];
    // The work: calls inside the Condition or after it.
    const after = tree.actions.slice(tree.actions.indexOf(check));
    const work = new Set(
      after
        .flatMap((n) => [n, ...descendants(n)])
        .filter((n) => n.kind === 'connector' || n.kind === 'http' || n.kind === 'child-flow')
        .map((n) => n.name),
    );
    if (work.size === 0) return [];
    const succeeded = runs.samples.filter((r) => r.status.toLowerCase() === 'succeeded');
    if (succeeded.length < 5) return [];
    const empty = succeeded.filter(
      (run) => !run.actions.some((a) => work.has(a.name) && a.status.toLowerCase() !== 'skipped'),
    ).length;
    if (empty / succeeded.length < 0.5) return [];
    return [
      {
        target: actionTarget(check),
        message: `${empty} of ${succeeded.length} recent runs stopped at ${q(check.name)} without making any call. It only checks trigger data, so a trigger condition could stop those runs from starting.`,
        confidence: empty / succeeded.length >= 0.8 ? 0.9 : 0.7,
      },
    ];
  },
};

export const RES02: Rule = {
  id: 'RES02',
  category: 'resources',
  severity: 'high',
  confidence: 0.9,
  title: 'Dataverse trigger fires on any column change',
  why: 'Without Select columns, the flow runs on every update of a row, whatever changed. Most of those runs do nothing useful but still count toward your limits, and they can set off loops with other automations.',
  fix: 'Set Select columns on the trigger to the columns the flow cares about (comma-separated logical names), and use Filter rows to skip rows that never matter.',
  example: {
    before:
      'When a row is added, modified or deleted\n  Change type: Modified   Table: Contacts\n  Select columns: (empty)',
    after:
      'When a row is added, modified or deleted\n  Change type: Modified   Table: Contacts\n  Select columns: statuscode,emailaddress1\n  Filter rows: statecode eq 0',
  },
  docs: [DOCS.dataverseTrigger, DOCS.triggers],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const trigger of tree.triggers) {
      if (trigger.kind !== 'dataverse') continue;
      const message = asNumber(trigger.parameters['subscriptionRequest/message']);
      if (message === undefined || !DATAVERSE_UPDATE_MESSAGES.has(message)) continue;
      if (hasValue(trigger.parameters['subscriptionRequest/filteringattributes'])) continue;
      const table = asString(trigger.parameters['subscriptionRequest/entityname']);
      const everyRow =
        !hasValue(trigger.parameters['subscriptionRequest/filterexpression']) &&
        trigger.conditions.length === 0;
      matches.push({
        target: triggerTarget(trigger),
        message: `The trigger runs on every change to any column of ${table ? `"${table}"` : 'the table'}${everyRow ? ', for every row' : ''}.`,
      });
    }
    return matches;
  },
};

export const RES03: Rule = {
  id: 'RES03',
  category: 'resources',
  severity: 'medium',
  confidence: 0.7,
  title: 'Very frequent schedule',
  why: 'A Recurrence trigger every few minutes runs hundreds of times a day, and every run counts its actions even when there is nothing to do.',
  fix: 'Trigger on the event instead (for example, When a row is added or modified), or run less often and add a trigger condition so empty runs are skipped.',
  example: {
    before: 'Recurrence  every 1 minute   → 1,440 runs a day',
    after: 'When a row is added  (event)   → runs only when there is work',
  },
  docs: [DOCS.triggers, DOCS.understandLimits],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const trigger of tree.triggers) {
      if (trigger.kind !== 'recurrence') continue;
      const frequency = trigger.recurrence?.frequency?.toLowerCase();
      const interval = Math.max(1, trigger.recurrence?.interval ?? 1);
      let perDay: number;
      if (frequency === 'second') perDay = 86_400 / interval;
      else if (frequency === 'minute' && interval <= 5) perDay = 1_440 / interval;
      else continue;
      matches.push({
        target: triggerTarget(trigger),
        message: `The flow runs every ${interval === 1 ? frequency : plural(interval, frequency)}: about ${plural(Math.round(perDay), 'run')} a day, even when there is nothing to do.`,
        severity: frequency === 'second' || interval <= 1 ? 'high' : 'medium',
        confidence: trigger.conditions.length > 0 ? 0.5 : 0.7,
      });
    }
    return matches;
  },
};

export const RES04: Rule = {
  id: 'RES04',
  category: 'resources',
  severity: 'medium',
  confidence: 0.8,
  title: 'List query reads more data than needed',
  why: 'Without a column list the query returns every column; without a filter or row limit it reads the whole table. Big payloads are slow to fetch and slow to process in every later step.',
  fix: 'Set Select columns to what later steps use, add Filter rows / Filter Query, and set Row count / Top Count when you only need a few rows.',
  example: {
    before: 'List rows  Table: Contacts',
    after:
      'List rows  Table: Contacts\n  Select columns: contactid,fullname,emailaddress1\n  Filter rows: statecode eq 0',
  },
  docs: [DOCS.relevantData, DOCS.listRows],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const node of tree.all) {
      const op = listOperation(node.connector, node.operationId);
      if (!op) continue;
      const has = (keys: string[]) => keys.some((key) => hasValue(node.parameters[key]));
      const noColumns = op.selectParams !== undefined && !has(op.selectParams);
      const noRows = !has(op.filterParams) && !has(op.topParams);
      if (!noColumns && !noRows) continue;
      const what = `${q(node.name)} (${op.label})`;
      const message =
        noColumns && noRows
          ? `${what} reads every column of every row: no column list, no filter and no row limit.`
          : noColumns
            ? `${what} returns every column: no column list is set.`
            : `${what} reads every row: no filter and no row limit.`;
      // Pagination makes an unfiltered query read far more than one page.
      const paged = node.settings.paginationMinItems ?? 0;
      const bulk = noRows && paged > 5000;
      matches.push({
        target: actionTarget(node),
        message: bulk
          ? `${message} Pagination is on, so each run can read up to ${paged.toLocaleString('en-US')} rows.`
          : message,
        confidence: noColumns || bulk ? 0.8 : 0.6,
        ...(bulk ? { severity: 'high' as const } : {}),
      });
    }
    return matches;
  },
};

const BULK_FIX: Record<string, string> = {
  [DATAVERSE]:
    'Build the rows with Select before the loop and send them in one request with the Dataverse bulk messages (CreateMultiple, UpdateMultiple, UpsertMultiple) through HTTP with Microsoft Entra ID, or group them in a $batch request. If you keep the loop, turn on concurrency.',
  [SHAREPOINT]:
    'Group the changes into $batch requests with "Send an HTTP request to SharePoint" (up to 1,000 changes per request), built with Select before the loop. If you keep the loop, turn on concurrency.',
  [SQL]:
    'Send all the rows in one call: pass them as JSON to a stored procedure (Execute stored procedure) that inserts or updates them together.',
  [EXCEL]:
    'Write all the rows in one call with an Office Script (Run script) that takes the array built with Select.',
};

export const RES08: Rule = {
  id: 'RES08',
  category: 'resources',
  severity: 'medium',
  confidence: 0.6,
  usesRunData: true,
  title: 'One write per loop item',
  why: 'Creating, updating or deleting records one at a time in a loop makes one request per record. With hundreds or thousands of items this is slow, counts heavily toward request limits, and invites throttling. Microsoft lists it as an anti-pattern.',
  fix: 'Prepare all the records with Select before the loop and write them in bulk or in batches. For services with no batch API, at least turn on concurrency for the loop.',
  example: {
    before: 'Apply to each  (1,000 items)\n  └ Update a row   → 1,000 requests',
    after:
      'Select  map items to rows\nHTTP with Microsoft Entra ID  POST …/contacts/Microsoft.Dynamics.CRM.UpdateMultiple\n  Body: { "Targets": body(\'Select\') }   → 1 request',
  },
  docs: [DOCS.antiPatterns, DOCS.bulkOperations],
  check({ tree }) {
    const byLoop = new Map<ActionNode, ActionNode[]>();
    for (const node of tree.all) {
      if (!writeOperation(node.connector, node.operationId)) continue;
      const loop = enclosingLoops(tree, node)[0];
      if (!loop || singleRowSource(tree, loop)) continue;
      byLoop.set(loop, [...(byLoop.get(loop) ?? []), node]);
    }
    return [...byLoop].map(([loop, writes]): RuleMatch => {
      const shown = writes
        .slice(0, 3)
        .map((w) => `${q(w.name)} (${writeOperation(w.connector, w.operationId)})`);
      const more = writes.length > 3 ? ` and ${writes.length - 3} more` : '';
      const connectors = new Set(writes.map((w) => w.connector));
      const [connector] = connectors;
      const fix = connectors.size === 1 && connector ? BULK_FIX[connector] : undefined;
      const outermost = enclosingLoops(tree, loop).at(-1) ?? loop;
      return {
        target: actionTarget(loop),
        message: `${q(loop.name)} writes records one at a time: ${plural(writes.length, 'request')} per item (${shown.join(', ')}${more}).`,
        confidence: isConcurrentLoop(outermost) ? 0.5 : 0.6,
        ...(fix ? { fix } : {}),
      };
    });
  },
};

export const RES06: Rule = {
  id: 'RES06',
  category: 'resources',
  severity: 'medium',
  confidence: 0.8,
  usesRunData: true,
  title: 'Large share of the daily request limit',
  why: "Every trigger, action, loop iteration and retry counts toward a 24-hour request limit: per user with a Premium licence (shared by all of the owner's flows), per flow with a Process licence. Over the limit, flows are slowed down.",
  fix: 'Cut the actions each run executes (loops and per-item calls are usually most of them: see the other findings), stop runs that have nothing to do with a trigger condition, or add capacity (a Process licence for this flow, or request add-ons).',
  docs: [DOCS.requestLimits, DOCS.whatCounts],
  check({ runs, settings }) {
    const limit = settings?.dailyRequestLimit;
    const perRun = runs?.stats.actionsPerRun;
    const perDay = runs?.runsPerDay;
    // The slowest runs make more requests than usual: only a recent sample gives the pace.
    if (!limit || !perRun || !perDay || runs.mode !== 'recent') return [];
    const requests = Math.round(perRun.mean * perDay);
    const share = requests / limit;
    if (share < 0.2) return [];
    const severity = share >= 1 ? 'high' : share >= 0.5 ? 'medium' : 'low';
    const pace =
      perDay >= 1
        ? `${plural(Math.round(perDay), 'run')} a day`
        : `${perDay.toFixed(1)} runs a day`;
    return [
      {
        target: FLOW_TARGET,
        message: `At its recent pace (about ${pace} × ${plural(perRun.mean, 'request')} per run), this flow makes about ${requests.toLocaleString('en-US')} requests a day: ${Math.round(share * 100)}% of the ${limit.toLocaleString('en-US')} daily limit you set.`,
        severity,
        evidence: { requestsPerDay: requests },
      },
    ];
  },
};

/** `…['body/<column>']` / `…?['<column>']` read from the trigger or from an action. */
function columnSources(value: unknown, column: string): string[] {
  if (typeof value !== 'string') return [];
  const col = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(triggerOutputs\\(\\)|triggerBody\\(\\)|(?:outputs|body)\\('((?:[^']|'')+)'\\))\\??\\['(?:body/)?${col}'\\]`,
    'g',
  );
  return [...value.matchAll(pattern)].map((m) => m[2]?.replace(/''/g, "'") ?? 'trigger');
}

export const RES07: Rule = {
  id: 'RES07',
  category: 'resources',
  severity: 'low',
  confidence: 0.6,
  title: 'Update writes back values that did not change',
  why: 'Dataverse updates every column sent in an update, even when the value is the same. Plug-ins and flows that watch those columns run anyway, and auditing shows changes that did not happen. Microsoft recommends sending only the columns that change.',
  fix: 'Only set the columns this step really changes. When it updates "if something changed", compare first and skip the update when nothing did (a Condition before it), instead of writing back the row\'s current values.',
  example: {
    before:
      "Update a row  Orders\n  City: if(new city is different, new city, outputs('Get_order')?['body/city'])\n  … 11 more like it",
    after:
      'Condition  any of the new values differs from the order\n  └ Yes: Update a row  Orders  (only the columns that changed)',
  },
  docs: [DOCS.dataverseUpdates],
  check({ tree }) {
    const trigger = tree.triggers.find((t) => t.kind === 'dataverse');
    const triggerTable = asString(trigger?.parameters['subscriptionRequest/entityname']);
    const matches: RuleMatch[] = [];
    for (const node of tree.all) {
      if (node.connector !== DATAVERSE || !DATAVERSE_UPDATES.has(node.operationId ?? '')) continue;
      const entity = asString(node.parameters.entityName);
      if (!entity) continue;
      // The row's own values: from a trigger on this table, or a read of this table.
      const ownRow = (source: string): boolean => {
        if (source === 'trigger') return Boolean(triggerTable && sameTable(triggerTable, entity));
        const read = tree.byName.get(source);
        return (
          read?.connector === DATAVERSE &&
          read.operationId === 'GetItem' &&
          asString(read.parameters.entityName)?.toLowerCase() === entity.toLowerCase()
        );
      };
      const copied = Object.entries(node.parameters)
        .filter(([key]) => key.startsWith('item/'))
        .map(([key]) => key.slice('item/'.length))
        .filter((column) => columnSources(node.parameters[`item/${column}`], column).some(ownRow));
      if (copied.length < 3) continue;
      const shown = copied.slice(0, 4).join(', ');
      matches.push({
        target: actionTarget(node),
        message: `${q(node.name)} can write back the row's current value in ${plural(copied.length, 'column')} (${shown}${copied.length > 4 ? '…' : ''}). Those columns count as updated on every run, changed or not.`,
      });
    }
    return matches;
  },
};

export const RESOURCE_RULES: Rule[] = [RES01, RES02, RES03, RES04, RES06, RES07, RES08];
