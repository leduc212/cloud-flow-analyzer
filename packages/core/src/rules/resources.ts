import { DATAVERSE_UPDATE_MESSAGES, listOperation } from '../connectors.ts';
import { asNumber, asString, hasValue } from '../definition.ts';
import { DOCS, actionTarget, plural, q, triggerTarget, type Rule, type RuleMatch } from './rule.ts';

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
      matches.push({
        target: actionTarget(node),
        message,
        confidence: noColumns ? 0.8 : 0.6,
      });
    }
    return matches;
  },
};

export const RESOURCE_RULES: Rule[] = [RES02, RES03, RES04];
