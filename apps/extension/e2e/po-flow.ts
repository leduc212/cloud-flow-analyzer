// A flow shaped like a real one that reveal got lost in: the action sits deep inside nested
// Conditions and Scopes, in a collapsed "No" branch, far down the canvas.

type Actions = Record<string, Record<string, unknown>>;

/** Chains actions one after another, as the designer does when you add them in order. */
function chain(actions: Actions): Actions {
  let previous: string | undefined;
  const out: Actions = {};
  for (const [name, action] of Object.entries(actions)) {
    out[name] = { ...action, runAfter: previous ? { [previous]: ['Succeeded'] } : {} };
    previous = name;
  }
  return out;
}

const compose = (value: unknown) => ({ type: 'Compose', inputs: value });
const scope = (actions: Actions) => ({ type: 'Scope', actions: chain(actions) });
const condition = (yes: Actions, no: Actions = {}) => ({
  type: 'If',
  expression: { equals: ['@true', true] },
  actions: chain(yes),
  else: { actions: chain(no) },
});
const childFlow = () => ({
  type: 'Workflow',
  inputs: { host: { workflowReferenceName: 'abc' }, body: {} },
});
const loop = (actions: Actions) => ({
  type: 'Foreach',
  foreach: "@triggerBody()?['attachments']",
  actions: chain(actions),
});
const composes = (prefix: string, count: number): Actions =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}_${i + 1}`, compose(i)]));

export const IN_NO_BRANCH = 'Create_Non-PO_record';
export const FAR_DOWN_YES = 'Create_PO_line';
export const NO_LOOP = 'Apply_to_each_-_Email_attachment';

export const poFlow = {
  properties: {
    displayName: 'Process PO emails',
    definition: {
      triggers: { When_a_new_email_arrives: { type: 'Request', inputs: {} } },
      actions: chain({
        ...composes('Initialize', 12),
        'Condition_-_Check_if_Email_From_an_excluding_domain': condition({
          'Condition_-_PO_with_same_Conversation_id_not_exist': condition({
            'Scope_-_Using_OCR_to_classify_and_extract_PO': scope({
              'Scope_-_Extract_attachments_to_raw_text': scope(composes('Extract', 6)),
              Extract_text_from_Email_body_html: compose(1),
              'Select_-_OCR_Text_Only': compose(2),
              'Scope_-_Classify_PO': scope(composes('Classify', 5)),
              'Condition_-_If_classified_as_PO': condition(
                {
                  'Scope_-_Email_Body_Extraction': scope(composes('Body', 4)),
                  'Scope_-_Attachment_Extraction': scope(composes('Attachment', 4)),
                  'Parse_JSON_-_All_POs': compose(3),
                  // Wide enough that the "No" branch card is off-screen from the header.
                  'Switch_-_PO_type': {
                    type: 'Switch',
                    expression: '@body()',
                    cases: Object.fromEntries(
                      [
                        'Standard',
                        'Blanket',
                        'Contract',
                        'Planned',
                        'Service',
                        'Framework',
                        'Consignment',
                        'Other',
                      ].map((c) => [c, { case: c, actions: { [`Route_${c}`]: compose(c) } }]),
                    ),
                    default: { actions: {} },
                  },
                  ...composes('Map_PO', 14),
                  'Apply_to_each_-_PO': loop({ [FAR_DOWN_YES]: childFlow() }),
                },
                {
                  ...composes('Not_PO', 3),
                  [NO_LOOP]: loop({ Compose_attachment: compose(4), [IN_NO_BRANCH]: childFlow() }),
                },
              ),
            }),
          }),
        }),
        ...composes('Finish', 10),
      }),
    },
  },
};

/** How the user had the designer: the inner scopes and the "No" branch collapsed. */
export const poCollapsed = [
  'Scope_-_Extract_attachments_to_raw_text',
  'Scope_-_Classify_PO',
  'Scope_-_Email_Body_Extraction',
  'Scope_-_Attachment_Extraction',
  'Condition_-_If_classified_as_PO-elseActions',
];
