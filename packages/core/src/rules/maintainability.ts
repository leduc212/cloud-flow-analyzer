import { DOCS, actionTarget, q, type Rule } from './rule.ts';

/**
 * Names the designer gives new steps, with the `_2`, `_3`… it adds for repeats. Only the common
 * built-in and connector steps: a name missing here is simply not reported.
 */
const DEFAULT_NAME = new RegExp(
  `^(${[
    'Compose',
    'Condition',
    'Apply_to_each',
    'For_each',
    'Initialize_variable',
    'Set_variable',
    'Append_to_array_variable',
    'Append_to_string_variable',
    'Increment_variable',
    'Decrement_variable',
    'Scope',
    'Switch',
    'Do_until',
    'Delay',
    'Parse_JSON',
    'Select',
    'Filter_array',
    'Create_HTML_table',
    'Create_CSV_table',
    'Join',
    'HTTP',
    'Run_a_Child_Flow',
    'List_rows',
    'Get_a_row_by_ID',
    'Update_a_row',
    'Add_a_new_row',
    'Delete_a_row',
    'Get_items',
    'Get_item',
    'Create_item',
    'Update_item',
    'Delete_item',
    'Get_file_content',
    'Create_file',
    'Send_an_email_\\(V2\\)',
    'Post_message_in_a_chat_or_channel',
    'Get_user_profile_\\(V2\\)',
    'Run_script',
  ].join('|')})(_\\d+)?$`,
);

/** Fewer than this many default names in a flow isn't worth a finding. */
const MIN_DEFAULT_NAMES = 3;

export const MNT02: Rule = {
  id: 'MNT02',
  category: 'maintainability',
  severity: 'low',
  confidence: 0.9,
  title: 'Steps keep their default names',
  why: 'Steps are referred to by name in expressions, run history, error messages and these findings. "Compose 3" or "Condition 2" says nothing about what a step does, so the flow is harder to follow, fix and hand over. Maintainability findings don\'t count toward the grade.',
  fix: 'Rename each step to say what it does (the step\'s … menu → Rename), for example "Compose – order total" or "Condition – is approved". Add a note to steps whose purpose isn\'t obvious.',
  example: {
    before: 'Compose_3\nCondition_2\nApply_to_each',
    after: 'Compose – order total\nCondition – is approved\nFor each order line',
  },
  docs: [DOCS.naming],
  check({ tree }) {
    const defaults = tree.all.filter((n) => DEFAULT_NAME.test(n.name));
    const [first] = defaults;
    if (!first || defaults.length < MIN_DEFAULT_NAMES) return [];
    const shown = defaults.slice(0, 5).map((n) => q(n.name));
    const more = defaults.length > 5 ? ` and ${defaults.length - 5} more` : '';
    return [
      {
        target: actionTarget(first),
        message: `${defaults.length} of the ${tree.actionCount} steps keep the name the designer gave them: ${shown.join(', ')}${more}.`,
      },
    ];
  },
};

export const MAINTAINABILITY_RULES: Rule[] = [MNT02];
