import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import good from '../../../fixtures/flows/sync-contacts-good.json' with { type: 'json' };
import clientdata from '../../../fixtures/flows/poll-orders-clientdata.json' with { type: 'json' };

export const SAMPLES: { id: string; label: string; flow: unknown }[] = [
  { id: 'before', label: 'Sync account contacts (before)', flow: bad },
  { id: 'after', label: 'Sync account contacts (after)', flow: good },
  { id: 'polling', label: 'Poll orders (solution clientdata)', flow: clientdata },
];
