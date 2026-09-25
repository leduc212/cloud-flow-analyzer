import { isSecretOperation } from '../connectors.ts';
import { asObject, asString, isObject } from '../definition.ts';
import type { ActionNode } from '../types.ts';
import { DOCS, actionTarget, q, triggerTarget, type Rule, type RuleMatch } from './rule.ts';

export const SEC01: Rule = {
  id: 'SEC01',
  category: 'security',
  severity: 'high',
  confidence: 0.95,
  title: 'Secret visible in run history',
  why: 'Run history shows the inputs and outputs of every step to anyone who can see the runs: co-owners, admins, and anyone the flow is shared with. A secret read from Key Vault is shown there in plain text unless the steps that read and use it are secured.',
  fix: 'Open the step\'s Settings and turn on Secure outputs on "Get secret", and Secure inputs on every step that uses the secret.',
  example: {
    before:
      'Get secret  ApiKey          (Secure outputs off)\nHTTP        api-key: <secret>  (Secure inputs off)',
    after:
      'Get secret  ApiKey          (Secure outputs on)\nHTTP        api-key: <secret>  (Secure inputs on)\n\n"runtimeConfiguration": { "secureData": { "properties": ["outputs"] } }',
  },
  docs: [DOCS.secureData, DOCS.keyVaultVariables],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    const secrets = tree.all.filter((n) => isSecretOperation(n.connector, n.operationId));
    for (const secret of secrets) {
      if (!secret.settings.secureOutputs) {
        matches.push({
          target: actionTarget(secret),
          message: `${q(secret.name)} reads a secret, but Secure outputs is off: the secret is shown in plain text in the run history.`,
          fix: `Turn on Secure outputs in the Settings of ${q(secret.name)}.`,
        });
      }
    }
    const secretNames = new Set(secrets.map((n) => n.name));
    for (const node of tree.all) {
      if (node.settings.secureInputs) continue;
      const used = node.references.filter((name) => secretNames.has(name));
      if (used.length === 0) continue;
      matches.push({
        target: actionTarget(node),
        message: `${q(node.name)} uses the secret from ${used.map(q).join(', ')}, but Secure inputs is off: the secret is shown in plain text in its inputs in the run history.`,
        fix: `Turn on Secure inputs in the Settings of ${q(node.name)}.`,
      });
    }
    return matches;
  },
};

const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|x-api-key|api-key|apikey|ocp-apim-subscription-key|x-functions-key|x-auth-token|x-access-token)$/i;
/** Query parameters that carry a key or signature (Azure Functions `code`, SAS `sig`…). */
const CREDENTIAL_QUERY = /[?&](code|sig|api[-_]?key|access_token|subscription-key)=([^&#]*)/gi;
/** Fields of `inputs.authentication` that hold a secret. */
const CREDENTIAL_AUTH_FIELDS = ['password', 'secret', 'pfx', 'value'];

/** A literal: text that contains no expression. */
function isLiteral(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('@');
}

/** Where an HTTP action carries a hard-coded credential. */
function hardCodedCredentials(node: ActionNode): string[] {
  const inputs = asObject(node.inputs);
  const found: string[] = [];
  const auth = asObject(inputs.authentication);
  const authType = asString(auth.type);
  for (const field of CREDENTIAL_AUTH_FIELDS) {
    if (isLiteral(auth[field])) {
      found.push(`the ${field} of its ${authType ? `${authType} ` : ''}authentication`);
    }
  }
  if (isObject(inputs.headers)) {
    for (const [header, value] of Object.entries(inputs.headers)) {
      if (CREDENTIAL_HEADER.test(header) && isLiteral(value)) found.push(`the ${header} header`);
    }
  }
  const uri = asString(inputs.uri);
  // A URI that is a whole expression (`@parameters('…')`) holds no literal.
  if (uri && !uri.startsWith('@')) {
    for (const match of uri.matchAll(CREDENTIAL_QUERY)) {
      const [, param, value] = match;
      if (param && value && !value.includes('@')) found.push(`the ${param}= parameter of its URI`);
    }
  }
  return found;
}

export const SEC02: Rule = {
  id: 'SEC02',
  category: 'security',
  severity: 'high',
  confidence: 0.85,
  title: 'Hard-coded credential',
  why: "A password or key typed into the flow can be read by anyone who can edit the flow or export it, and it appears in every run's history. Changing it means editing every flow that holds a copy.",
  fix: 'Store the secret in Azure Key Vault and read it with an environment variable of type Secret (or the Key Vault "Get secret" action with Secure outputs on). Turn on Secure inputs on this step, and rotate the exposed secret.',
  example: {
    before: 'HTTP  Headers: x-api-key: 3f9c1e…',
    after:
      "Get secret  ApiKey  (Secure outputs on)\nHTTP        Headers: x-api-key: @{body('Get_secret')?['value']}  (Secure inputs on)",
  },
  docs: [DOCS.secureData, DOCS.keyVaultVariables],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const node of tree.all) {
      if (node.kind !== 'http') continue;
      const found = hardCodedCredentials(node);
      if (found.length === 0) continue;
      matches.push({
        target: actionTarget(node),
        message: `${q(node.name)} has a credential typed into ${found.join(', ')}.`,
      });
    }
    return matches;
  },
};

export const SEC03: Rule = {
  id: 'SEC03',
  category: 'security',
  severity: 'medium',
  confidence: 0.8,
  title: 'HTTP trigger anyone can call',
  why: 'With "Who can trigger the flow" set to Anyone, the URL is the only protection: anyone who gets it (from a log, an email, a browser history) can start the flow with any data.',
  fix: 'Set "Who can trigger the flow" to "Any user in my tenant" or "Specific users in my tenant", and have callers send an Entra ID token. Turn on Secure inputs on the trigger if requests carry sensitive data.',
  example: {
    before: 'When an HTTP request is received  Who can trigger: Anyone',
    after: 'When an HTTP request is received  Who can trigger: Specific users in my tenant',
  },
  docs: [DOCS.httpTrigger, DOCS.secureData],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const trigger of tree.triggers) {
      if (trigger.kind !== 'request' || trigger.requestKind?.toLowerCase() !== 'http') continue;
      const who = asString(asObject(trigger.raw.inputs).triggerAuthenticationType);
      if (who !== undefined && who.toLowerCase() !== 'all') continue;
      matches.push({
        target: triggerTarget(trigger),
        message:
          who === undefined
            ? 'The HTTP trigger has no "Who can trigger the flow" setting (flows created before it existed), so anyone with the URL can call it.'
            : 'The HTTP trigger lets anyone with the URL start the flow ("Who can trigger the flow": Anyone).',
        confidence: who === undefined ? 0.6 : 0.8,
      });
    }
    return matches;
  },
};

export const SECURITY_RULES: Rule[] = [SEC01, SEC02, SEC03];
