import { asObject, asString, isObject } from './definition.ts';

export const DATAVERSE = 'shared_commondataserviceforapps';
export const SHAREPOINT = 'shared_sharepointonline';
export const SQL = 'shared_sql';
export const EXCEL = 'shared_excelonlinebusiness';
export const OFFICE365_USERS = 'shared_office365users';

export const CONNECTOR_NAMES: Record<string, string> = {
  [DATAVERSE]: 'Dataverse',
  [SHAREPOINT]: 'SharePoint',
  [SQL]: 'SQL Server',
  [EXCEL]: 'Excel Online (Business)',
  [OFFICE365_USERS]: 'Office 365 Users',
  shared_office365: 'Office 365 Outlook',
  shared_teams: 'Microsoft Teams',
  shared_onedriveforbusiness: 'OneDrive for Business',
  shared_azureblob: 'Azure Blob Storage',
  shared_approvals: 'Approvals',
};

export interface ListOperation {
  label: string;
  /** Parameters that limit the columns returned. Absent when the connector has no such option. */
  selectParams?: string[];
  filterParams: string[];
  topParams: string[];
}

// Operation IDs and parameter names come from exported definitions. Confirm new ones against
// captured definitions (spike S3) before adding them.
export const LIST_OPERATIONS: Record<string, Record<string, ListOperation>> = {
  [DATAVERSE]: {
    ListRecords: {
      label: 'List rows',
      selectParams: ['$select', 'fetchXml'],
      filterParams: ['$filter', 'fetchXml'],
      topParams: ['$top'],
    },
  },
  [SHAREPOINT]: {
    GetItems: { label: 'Get items', filterParams: ['$filter'], topParams: ['$top'] },
  },
  [SQL]: {
    GetItems_V2: {
      label: 'Get rows (V2)',
      selectParams: ['$select'],
      filterParams: ['$filter'],
      topParams: ['$top'],
    },
  },
  [EXCEL]: {
    GetItems: {
      label: 'List rows present in a table',
      selectParams: ['$select'],
      filterParams: ['$filter'],
      topParams: ['$top'],
    },
  },
};

export const SINGLE_READ_OPERATIONS: Record<string, Record<string, string>> = {
  [DATAVERSE]: { GetItem: 'Get a row by ID' },
  [SHAREPOINT]: { GetItem: 'Get item', GetFileProperties: 'Get file properties' },
  [SQL]: { GetItem_V2: 'Get row (V2)' },
  [EXCEL]: { GetItem: 'Get a row' },
  [OFFICE365_USERS]: { UserProfile_V2: 'Get user profile (V2)', Manager_V2: 'Get manager (V2)' },
};

export const DATAVERSE_TRIGGER = 'SubscribeWebhookTrigger';
/** `subscriptionRequest/message` values that include Update: Modified, Added or Modified, Modified or Deleted, all. */
export const DATAVERSE_UPDATE_MESSAGES = new Set([3, 4, 6, 7]);

export function listOperation(
  connector: string | undefined,
  operationId: string | undefined,
): ListOperation | undefined {
  if (!connector || !operationId) return undefined;
  return LIST_OPERATIONS[connector]?.[operationId];
}

export function singleReadOperation(
  connector: string | undefined,
  operationId: string | undefined,
): string | undefined {
  if (!connector || !operationId) return undefined;
  return SINGLE_READ_OPERATIONS[connector]?.[operationId];
}

export function connectorName(connector: string | undefined): string {
  if (!connector) return 'connector';
  return CONNECTOR_NAMES[connector] ?? connector.replace(/^shared_/, '');
}

function lastSegment(apiId: string): string {
  const parts = apiId.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? apiId).toLowerCase();
}

function normalise(name: string): string {
  const lower = name.toLowerCase();
  return lower.startsWith('shared_') ? lower : `shared_${lower}`;
}

/** Resolves a connection reference key (e.g. `shared_commondataserviceforapps_1`) to a connector. */
function fromReference(key: string, references: Record<string, unknown>): string {
  const ref = references[key];
  if (isObject(ref)) {
    const apiName = asString(asObject(ref.api).name) ?? asString(ref.apiName);
    if (apiName) return normalise(apiName);
    const id = asString(ref.id) ?? asString(asObject(ref.api).id);
    if (id) return lastSegment(id);
  }
  return normalise(key.replace(/_\d+$/, ''));
}

const CONNECTIONS_PARAM = /\$connections'\)\s*\[\s*'([^']+)'\s*\]/;

/** Works out which connector an action's `inputs.host` points at. */
export function resolveConnector(
  host: unknown,
  references: Record<string, unknown>,
): string | undefined {
  if (!isObject(host)) return undefined;
  const apiId = asString(host.apiId);
  if (apiId) return lastSegment(apiId);

  const connectionName = asString(host.connectionName);
  if (connectionName) return fromReference(connectionName, references);

  const connection = host.connection;
  if (typeof connection === 'string') return fromReference(connection, references);
  if (isObject(connection)) {
    const referenceName = asString(connection.referenceName);
    if (referenceName) return fromReference(referenceName, references);
    const name = asString(connection.name);
    const match = name ? CONNECTIONS_PARAM.exec(name) : null;
    if (match?.[1]) return fromReference(match[1], references);
  }
  return undefined;
}

export const KEY_VAULT = 'shared_keyvault';
CONNECTOR_NAMES[KEY_VAULT] = 'Azure Key Vault';

/** Operations that return a secret (Key Vault). */
export const SECRET_OPERATIONS: Record<string, string[]> = {
  [KEY_VAULT]: ['GetSecret', 'GetSecretVersion'],
};

export function isSecretOperation(connector?: string, operationId?: string): boolean {
  return Boolean(connector && operationId && SECRET_OPERATIONS[connector]?.includes(operationId));
}

/** Operations that write one record (create, update, delete). */
export const WRITE_OPERATIONS: Record<string, Record<string, string>> = {
  [DATAVERSE]: {
    CreateRecord: 'Add a new row',
    UpdateRecord: 'Update a row',
    UpdateOnlyRecord: 'Update a row',
    DeleteRecord: 'Delete a row',
  },
  [SHAREPOINT]: { PostItem: 'Create item', PatchItem: 'Update item', DeleteItem: 'Delete item' },
  [SQL]: {
    PostItem_V2: 'Insert row (V2)',
    PatchItem_V2: 'Update row (V2)',
    DeleteItem_V2: 'Delete row (V2)',
  },
  [EXCEL]: {
    AddRowV2: 'Add a row into a table',
    PatchItem: 'Update a row',
    DeleteItem: 'Delete a row',
  },
};

export function writeOperation(connector?: string, operationId?: string): string | undefined {
  if (!connector || !operationId) return undefined;
  return WRITE_OPERATIONS[connector]?.[operationId];
}

/** Rows a list query returns when no row limit and no pagination are set. */
export const DEFAULT_PAGE_SIZE: Record<string, Record<string, number>> = {
  [SHAREPOINT]: { GetItems: 100 },
  [EXCEL]: { GetItems: 256 },
  [DATAVERSE]: { ListRecords: 5000 },
};

/** SharePoint triggers that fire when an existing item is modified. */
export const SHAREPOINT_UPDATE_TRIGGERS = new Set(['GetOnUpdatedItems', 'GetOnChangedItems']);

/** SharePoint operation that updates an item. */
export const SHAREPOINT_UPDATE = 'PatchItem';
/** Dataverse operations that update a row. */
export const DATAVERSE_UPDATES = new Set(['UpdateRecord', 'UpdateOnlyRecord']);
