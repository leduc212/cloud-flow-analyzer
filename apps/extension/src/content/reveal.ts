// Finds an action in the flow designer and brings it into view.
//
// The new designer draws the flow on a React Flow canvas: every action is a
// `.react-flow__node[data-id="<action name>"]` and the canvas pans with a transform, not with
// scrolling. A content script can't reach React Flow itself, so it pans the way a user does
// (dragging the empty canvas, then the scroll wheel) and measures after each step, correcting
// until the action sits in the middle of the visible canvas. The classic designer is a plain
// scrolling page, where scrollIntoView works.

export interface RevealOutcome {
  ok: boolean;
  /** What happened, for the pane's status line. */
  message: string;
}

/** Keeps actions out from under the pane when centring them. */
export interface RevealOptions {
  reservedRight?: number;
}

const label = (name: string) => name.replace(/_/g, ' ');

function norm(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The page document plus any same-origin frames (the designer may live in one). */
export function searchDocuments(root: Document = document): Document[] {
  const documents = [root];
  for (const frame of root.querySelectorAll('iframe')) {
    try {
      if (frame.contentDocument) documents.push(frame.contentDocument);
    } catch {
      // Cross-origin frame: not reachable.
    }
  }
  return documents;
}

const TITLE_SELECTORS = [
  '.msla-card-title',
  '[class*="card-title"]',
  '[class*="CardTitle"]',
  '[data-automation-id*="card-title"]',
].join(',');

/** Finds the element that represents an action (or trigger) in the designer. */
export function findActionElement(
  name: string,
  documents: Document[] = searchDocuments(),
): HTMLElement | undefined {
  const id = CSS.escape(name);
  const selectors = [
    `.react-flow__node[data-id="${id}"]`,
    // Scopes, loops and conditions are drawn as "<name>-#scope" header nodes.
    `.react-flow__node[data-id^="${id}-#"]`,
    `[data-id="${id}"]`,
    `[data-automation-id="${id}"]`,
    `[id="${id}"]`,
  ];
  for (const doc of documents) {
    for (const selector of selectors) {
      const element = doc.querySelector<HTMLElement>(selector);
      if (element) return element;
    }
  }
  // Fallback: a card whose title is the action's display name.
  const wanted = norm(label(name));
  for (const doc of documents) {
    for (const title of doc.querySelectorAll<HTMLElement>(TITLE_SELECTORS)) {
      if (norm(title.textContent) === wanted || norm(title.getAttribute('title')) === wanted) {
        return (
          title.closest<HTMLElement>('.react-flow__node, .msla-card, [class*="card-container"]') ??
          title
        );
      }
    }
  }
  return undefined;
}

export function isDesignerOpen(documents: Document[] = searchDocuments()): boolean {
  return documents.some((doc) =>
    doc.querySelector('.react-flow, .msla-designer, [class*="msla-"]'),
  );
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 40)));

interface Canvas {
  container: HTMLElement;
  pane: HTMLElement;
}

function canvasOf(element: HTMLElement): Canvas | undefined {
  const container = element.closest<HTMLElement>('.react-flow');
  if (!container) return undefined;
  const pane =
    container.querySelector<HTMLElement>('.react-flow__pane') ??
    container.querySelector<HTMLElement>('.react-flow__renderer') ??
    container;
  return { container, pane };
}

/** How far the element must move to sit in the middle of the visible part of the canvas. */
function offset(element: HTMLElement, container: HTMLElement, reservedRight: number) {
  const box = element.getBoundingClientRect();
  const area = container.getBoundingClientRect();
  const right = Math.min(area.right, window.innerWidth - reservedRight);
  const targetX = (area.left + Math.max(right, area.left + 100)) / 2;
  const targetY = area.top + area.height / 2;
  // Tall scopes: aim for their header, not their middle.
  const elementY = box.height > area.height / 2 ? box.top + 40 : box.top + box.height / 2;
  return { dx: targetX - (box.left + box.width / 2), dy: targetY - elementY, box };
}

type Mover = (pane: HTMLElement, dx: number, dy: number) => void;

function pointer(x: number, y: number, buttons: number): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons,
    view: window,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  };
}

/** Drags the empty canvas, like a user panning with the mouse. */
const drag: Mover = (pane, dx, dy) => {
  const area = pane.getBoundingClientRect();
  const x0 = area.left + area.width / 2;
  const y0 = area.top + area.height / 2;
  const fire = (kind: 'down' | 'move' | 'up', x: number, y: number) => {
    const buttons = kind === 'up' ? 0 : 1;
    pane.dispatchEvent(new PointerEvent(`pointer${kind}`, pointer(x, y, buttons)));
    pane.dispatchEvent(new MouseEvent(`mouse${kind}`, pointer(x, y, buttons)));
  };
  fire('down', x0, y0);
  const steps = 6;
  for (let i = 1; i <= steps; i++) fire('move', x0 + (dx * i) / steps, y0 + (dy * i) / steps);
  fire('up', x0 + dx, y0 + dy);
};

/** Scrolls the canvas with the wheel (the designer pans on scroll). */
const wheel: Mover = (pane, dx, dy) => {
  const area = pane.getBoundingClientRect();
  pane.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: area.left + area.width / 2,
      clientY: area.top + area.height / 2,
      deltaX: -dx,
      deltaY: -dy,
      deltaMode: 0,
      view: window,
    }),
  );
};

/**
 * Moves the canvas with one technique, measuring after each step and correcting the step size.
 * Returns false if the technique doesn't move the canvas (or zooms instead of panning).
 */
async function centreWith(
  mover: Mover,
  find: () => HTMLElement | undefined,
  reservedRight: number,
): Promise<boolean> {
  let gainX = 1;
  let gainY = 1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const element = find();
    const canvas = element && canvasOf(element);
    if (!element || !canvas) return false;
    const { dx, dy, box } = offset(element, canvas.container, reservedRight);
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return true;
    mover(canvas.pane, dx * gainX, dy * gainY);
    await nextFrame();
    const moved = find()?.getBoundingClientRect();
    if (!moved) return false;
    if (Math.abs(moved.width - box.width) > 2) return false; // zoomed, not panned
    const movedX = moved.left - box.left;
    const movedY = moved.top - box.top;
    if (Math.abs(movedX) < 1 && Math.abs(movedY) < 1) return false;
    if (Math.abs(dx) >= 24 && Math.abs(movedX) >= 1) gainX = clampGain((gainX * dx) / movedX);
    if (Math.abs(dy) >= 24 && Math.abs(movedY) >= 1) gainY = clampGain((gainY * dy) / movedY);
  }
  const element = find();
  const canvas = element && canvasOf(element);
  if (!element || !canvas) return false;
  const { dx, dy } = offset(element, canvas.container, reservedRight);
  return Math.abs(dx) < 60 && Math.abs(dy) < 60;
}

/** Keeps the correction factor sane; a negative one means the technique moves the other way. */
function clampGain(gain: number): number {
  if (!Number.isFinite(gain) || gain === 0) return 1;
  return Math.sign(gain) * Math.min(Math.max(Math.abs(gain), 0.1), 10);
}

function isInView(element: HTMLElement, reservedRight: number): boolean {
  const box = element.getBoundingClientRect();
  return (
    box.bottom > 0 &&
    box.top < window.innerHeight &&
    box.right > 0 &&
    box.left < window.innerWidth - reservedRight
  );
}

let highlightTimer: ReturnType<typeof setTimeout> | undefined;

/** Draws a pulsing outline over the element for a few seconds (never changes the designer). */
export function highlight(element: HTMLElement): void {
  const doc = element.ownerDocument;
  doc.getElementById('cfa-highlight')?.remove();
  clearTimeout(highlightTimer);
  const box = element.getBoundingClientRect();
  const outline = doc.createElement('div');
  outline.id = 'cfa-highlight';
  Object.assign(outline.style, {
    position: 'fixed',
    left: `${box.left - 6}px`,
    top: `${box.top - 6}px`,
    width: `${box.width + 12}px`,
    height: `${Math.min(box.height, 400) + 12}px`,
    border: '3px solid #0f6cbd',
    borderRadius: '10px',
    boxShadow: '0 0 0 4px rgb(15 108 189 / 25%)',
    pointerEvents: 'none',
    zIndex: '2147482999',
  });
  doc.documentElement.append(outline);
  outline.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], {
    duration: 900,
    iterations: 3,
  });
  highlightTimer = setTimeout(() => outline.remove(), 3000);
}

const TOGGLE_SELECTORS = [
  '.msla-collapse-toggle',
  '[class*="collapse-toggle"]',
  'button[aria-expanded]',
  'button[aria-label*="expand" i]',
  'button[aria-label*="collapse" i]',
  'button[title*="expand" i]',
  'button[title*="collapse" i]',
];

/** The card that holds a container's expand/collapse button (scope header first). */
function containerCard(name: string, documents = searchDocuments()): HTMLElement | undefined {
  const id = CSS.escape(name);
  for (const doc of documents) {
    const header = doc.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}-#scope"]`);
    if (header) return header;
  }
  return findActionElement(name, documents);
}

export function findCollapseToggle(card: HTMLElement): HTMLElement | undefined {
  for (const selector of TOGGLE_SELECTORS) {
    const toggle = card.querySelector<HTMLElement>(selector);
    if (toggle) return toggle;
  }
  return undefined;
}

/** Whether a toggle says its container is collapsed. Labels may be localised, so 'unknown' is common. */
export function toggleState(toggle: HTMLElement): 'collapsed' | 'expanded' | 'unknown' {
  const expanded = toggle.getAttribute('aria-expanded');
  if (expanded === 'false') return 'collapsed';
  if (expanded === 'true') return 'expanded';
  const text = norm(
    `${toggle.getAttribute('aria-label') ?? ''} ${toggle.getAttribute('title') ?? ''} ${toggle.textContent ?? ''}`,
  );
  const saysExpand = /\bexpand/.test(text);
  const saysCollapse = /\bcollapse/.test(text);
  if (saysExpand && !saysCollapse) return 'collapsed';
  if (saysCollapse && !saysExpand) return 'expanded';
  return 'unknown';
}

async function waitFor<T>(find: () => T | undefined, timeout = 2500): Promise<T | undefined> {
  const end = Date.now() + timeout;
  for (;;) {
    const found = find();
    if (found || Date.now() > end) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface ExpandOutcome {
  /** Containers this call expanded, outermost first. */
  expanded: string[];
  /** The container that couldn't be opened, when the action is still hidden. */
  blockedAt?: string;
}

/**
 * Opens the collapsed scopes, loops and conditions on the way to an action, outermost first.
 * Only clicks a toggle that says it is collapsed, or, when it can't tell, clicks it and undoes
 * the click if the next step doesn't appear, so expanded containers are never left collapsed.
 */
export async function expandPath(path: string[]): Promise<ExpandOutcome> {
  const expanded: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const parent = path[i] ?? '';
    const child = path[i + 1] ?? '';
    if (findActionElement(child)) continue;
    const card = containerCard(parent);
    const toggle = card && findCollapseToggle(card);
    if (!toggle) return { expanded, blockedAt: parent };
    const state = toggleState(toggle);
    if (state === 'expanded') return { expanded, blockedAt: parent };
    toggle.click();
    if (!(await waitFor(() => findActionElement(child)))) {
      if (state === 'unknown') {
        // We may have collapsed an open container: put it back.
        findCollapseToggle(containerCard(parent) ?? toggle)?.click();
      }
      return { expanded, blockedAt: parent };
    }
    expanded.push(parent);
  }
  return { expanded };
}

/**
 * Brings an action into view and highlights it. `path` is the action's position in the flow
 * (parents first); collapsed parents on that path are expanded first.
 */
export async function revealAction(
  name: string,
  path: string[],
  options: RevealOptions = {},
): Promise<RevealOutcome> {
  const reservedRight = options.reservedRight ?? 0;
  const find = () => findActionElement(name);
  let element = find();
  let expanded: string[] = [];
  if (!element) {
    if (!isDesignerOpen()) {
      return { ok: false, message: 'Open the flow in the designer (Edit) to jump to actions.' };
    }
    // Probably inside collapsed scopes, loops or conditions: open them.
    const outcome = await expandPath(path.length > 0 ? path : [name]);
    expanded = outcome.expanded;
    element = find();
    if (!element) {
      const parent =
        outcome.blockedAt ?? [...path.slice(0, -1)].reverse().find((p) => findActionElement(p));
      if (parent && findActionElement(parent)) {
        await revealAction(parent, [], options);
        return {
          ok: false,
          message: `"${label(name)}" is inside "${label(parent)}", which couldn't be opened automatically. Expand it (or the branch the action is in), then click again.`,
        };
      }
      return {
        ok: false,
        message: `Couldn't find "${label(name)}" in the designer. If it's inside a collapsed step, expand it and click again.`,
      };
    }
  }

  const canvas = canvasOf(element);
  let moved = false;
  if (canvas) {
    moved =
      (await centreWith(drag, find, reservedRight)) ||
      (await centreWith(wheel, find, reservedRight));
  }
  if (!moved) {
    find()?.scrollIntoView({ block: 'center', inline: 'center' });
    await nextFrame();
  }
  const final = find();
  if (!final) return { ok: false, message: `Lost "${label(name)}" while moving the canvas.` };
  highlight(final);
  if (!moved && !isInView(final, reservedRight)) {
    return {
      ok: false,
      message: `Found "${label(name)}" but couldn't move the canvas to it. Copy the designer check below and send it to us.`,
    };
  }
  const opened = expanded.length
    ? ` (opened ${expanded.map((e) => `"${label(e)}"`).join(' › ')})`
    : '';
  return { ok: true, message: `Showing "${label(name)}"${opened}.` };
}

function canRead(frame: HTMLIFrameElement): boolean {
  try {
    return Boolean(frame.contentDocument);
  } catch {
    return false;
  }
}

/** A snapshot of what the designer page looks like, for debugging "couldn't find" problems. */
export function designerCheck(documents: Document[] = searchDocuments()): Record<string, unknown> {
  const nodes = documents.flatMap((doc) => [
    ...doc.querySelectorAll<HTMLElement>('.react-flow__node'),
  ]);
  const titles = documents.flatMap((doc) => [
    ...doc.querySelectorAll<HTMLElement>(TITLE_SELECTORS),
  ]);
  const viewport = documents
    .map((doc) => doc.querySelector<HTMLElement>('.react-flow__viewport'))
    .find(Boolean);
  return {
    page: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '{id}'),
    designerFound: isDesignerOpen(documents),
    reactFlowCanvases: documents.reduce(
      (n, doc) => n + doc.querySelectorAll('.react-flow').length,
      0,
    ),
    reactFlowPane: documents.some((doc) => doc.querySelector('.react-flow__pane')),
    viewportTransform: viewport?.style.transform ?? null,
    nodeCount: nodes.length,
    nodeIds: nodes.slice(0, 25).map((n) => n.dataset.id ?? null),
    nodeClasses: [...new Set(nodes.slice(0, 25).map((n) => n.className))].slice(0, 5),
    cardTitles: titles.slice(0, 15).map((t) => t.textContent?.trim()),
    toggles: nodes
      .map((n) => {
        const toggle = findCollapseToggle(n);
        return toggle
          ? {
              node: n.dataset.id ?? null,
              class: toggle.className,
              label: toggle.getAttribute('aria-label'),
              expanded: toggle.getAttribute('aria-expanded'),
              state: toggleState(toggle),
            }
          : undefined;
      })
      .filter(Boolean)
      .slice(0, 15),
    frames: [...document.querySelectorAll('iframe')].map((f) => ({
      host: f.src ? new URL(f.src, location.href).host : '',
      sameOrigin: canRead(f),
    })),
  };
}
