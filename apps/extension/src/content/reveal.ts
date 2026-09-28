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

export interface RevealOptions {
  /** Keeps actions out from under the pane when centring them. */
  reservedRight?: number;
  /** Trigger and action names in designer order, used to find actions that aren't drawn yet. */
  order?: string[];
  /** The parent and branch of each nested action, to walk the designer's layout. */
  parents?: Parents;
  /** Kinds and branches along the path, to open Condition branches and Switch cases. */
  steps?: Step[];
  /** Status updates while searching. */
  onProgress?: (text: string) => void;
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

function pointer(
  x: number,
  y: number,
  buttons: number,
  view: Window | null = window,
): PointerEventInit {
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
    view,
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
  // Branch cards: the whole card is the toggle; the chevron inside is a disabled icon.
  '[role="button"][aria-expanded]',
  'button[aria-label*="expand" i]',
  'button[aria-label*="collapse" i]',
  'button[title*="expand" i]',
  'button[title*="collapse" i]',
];

/**
 * Whether pressing the element can do anything: not disabled, and not decoration hidden
 * from assistive tech inside the card (the designer's branch chevrons are both).
 */
function usable(toggle: HTMLElement, card: HTMLElement): boolean {
  if ((toggle as HTMLButtonElement).disabled || toggle.getAttribute('aria-disabled') === 'true') {
    return false;
  }
  for (let el: HTMLElement | null = toggle; el && el !== card; el = el.parentElement) {
    if (el.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
}

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
    for (const toggle of card.querySelectorAll<HTMLElement>(selector)) {
      if (usable(toggle, card)) return toggle;
    }
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
  /** A container whose toggle was clicked but didn't open it, and its node on the canvas. */
  failed?: { label: string; nodeId?: string };
}

/**
 * Opens the collapsed scopes, loops and conditions on the way to an action, outermost first.
 * Only clicks a toggle that says it is collapsed, or, when it can't tell, clicks it and undoes
 * the click if the next step doesn't appear, so expanded containers are never left collapsed.
 */
/** A step on the way to an action: its kind and the branch of its parent that holds it. */
export interface Step {
  name: string;
  kind: string;
  branch?: string;
}

interface Container {
  /** Shown in the status line, e.g. `"Scope"` or `the "No" branch of "Condition"`. */
  label: string;
  card: () => HTMLElement | undefined;
}

/**
 * Condition branches and Switch cases are drawn as their own collapsible cards. The designer
 * names them `<condition>-actions` / `<condition>-elseActions`, the case name, and
 * `<switch>-defaultCase`, with a `-#subgraph` suffix on the card.
 */
export function branchCardIds(parent: Step, child: Step): string[] {
  const branch = child.branch ?? 'actions';
  let id: string | undefined;
  if (parent.kind === 'condition') {
    id = branch === 'else' ? `${parent.name}-elseActions` : `${parent.name}-actions`;
  } else if (parent.kind === 'switch') {
    id = branch === 'default' ? `${parent.name}-defaultCase` : branch.replace(/^case:/, '');
  }
  return id ? [`${id}-#subgraph`, id] : [];
}

function branchLabel(parent: Step, child: Step): string {
  const branch = child.branch ?? 'actions';
  if (parent.kind === 'condition') {
    return `the "${branch === 'else' ? 'No' : 'Yes'}" branch of "${label(parent.name)}"`;
  }
  if (branch === 'default') return `the default case of "${label(parent.name)}"`;
  return `case "${label(branch.replace(/^case:/, ''))}"`;
}

/** `failed`: said collapsed and stayed so. `undone`: couldn't tell, clicked, and put it back. */
type OpenResult = 'shown' | 'opened' | 'already-open' | 'no-toggle' | 'failed' | 'undone';

/** Opens one collapsible card if it says it's collapsed (or can't tell), and reports what happened. */
/** What was under a toggle's centre when we pressed it, for the designer check. */
function hitAt(toggle: HTMLElement): string {
  const box = toggle.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return 'off-screen';
  const doc = toggle.ownerDocument;
  const hit = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : null;
  if (!hit) return 'nothing';
  if (hit === toggle) return 'toggle';
  if (toggle.contains(hit)) return 'inside toggle';
  return describe(hit);
}

function describe(el: Element): string {
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  const id = el.id ? `#${el.id}` : '';
  const dataId = el instanceof HTMLElement && el.dataset.id ? `[data-id=${el.dataset.id}]` : '';
  return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}${dataId}`.slice(0, 120);
}

/**
 * Presses an element the way a mouse does: pointer and mouse down and up, then click, at its
 * centre. A bare element.click() skips the down/up events, which some designer buttons act on.
 */
function press(el: HTMLElement): void {
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const view = null; // Handlers don't read it, and test DOMs reject their own window here.
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  el.dispatchEvent(new Pointer('pointerover', pointer(x, y, 0, view)));
  el.dispatchEvent(new MouseEvent('mouseover', pointer(x, y, 0, view)));
  el.dispatchEvent(new Pointer('pointerdown', pointer(x, y, 1, view)));
  el.dispatchEvent(new MouseEvent('mousedown', pointer(x, y, 1, view)));
  el.focus({ preventScroll: true });
  el.dispatchEvent(new Pointer('pointerup', pointer(x, y, 0, view)));
  el.dispatchEvent(new MouseEvent('mouseup', pointer(x, y, 0, view)));
  el.dispatchEvent(new MouseEvent('click', { ...pointer(x, y, 0, view), detail: 1 }));
}

/** Presses Enter on a focused element, for toggles that only listen to the keyboard. */
function pressEnter(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  const key = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', key));
  el.dispatchEvent(new KeyboardEvent('keyup', key));
}

export interface ToggleAttempt {
  node: string;
  label: string | null;
  /** What was under the toggle's centre: `toggle` when nothing covered it (events go to it either way). */
  hit: string;
  /** How it was pressed, and the toggle's state after each try. */
  tries: { how: 'press' | 'enter'; after: string }[];
  /** The card's structure (tags, roles, aria and data attributes), when it didn't open. */
  structure?: string;
}

/** The last toggles we pressed, newest last, shown in the designer check. */
const toggleAttempts: ToggleAttempt[] = [];

/** The card's element tree without text: enough to see where its buttons and handlers sit. */
function structureOf(el: Element, depth = 0): string {
  if (depth > 5) return '';
  const attrs = [...el.attributes]
    .filter((a) => /^(role|aria-|data-|tabindex|type|disabled)/.test(a.name))
    .map((a) => `${a.name}="${a.value.slice(0, 60)}"`);
  const head = [describe(el), ...attrs].join(' ');
  const children = [...el.children].map((c) => structureOf(c, depth + 1)).filter(Boolean);
  const pad = '  '.repeat(depth);
  return [pad + head, ...children].join('\n');
}

/** Opens one collapsible card if it says it's collapsed (or can't tell), and reports what happened. */
async function open(card: () => HTMLElement | undefined, child: string): Promise<OpenResult> {
  const found = card();
  const toggle = found && findCollapseToggle(found);
  if (!toggle) return 'no-toggle';
  const state = toggleState(toggle);
  if (state === 'expanded') return 'already-open';
  const attempt: ToggleAttempt = {
    node: found.dataset.id ?? describe(found),
    label: toggle.getAttribute('aria-label'),
    hit: hitAt(toggle),
    tries: [],
  };
  toggleAttempts.push(attempt);
  if (toggleAttempts.length > 5) toggleAttempts.shift();

  // Done when the next step is drawn, or when the toggle now says open (the next step may
  // just be off-screen, which the canvas search handles).
  const opened = () => {
    if (findActionElement(child)) return 'shown' as const;
    const again = card();
    const now = again && findCollapseToggle(again);
    return state === 'collapsed' && now && toggleState(now) === 'expanded'
      ? ('opened' as const)
      : undefined;
  };
  const current = () => {
    const now = findCollapseToggle(card() ?? toggle) ?? toggle;
    return now.isConnected ? toggleState(now) : 'gone';
  };
  // Try the keyboard only for a toggle that says it's collapsed: an unlabelled one might be
  // open, and pressing it twice would close it.
  const ways = state === 'collapsed' ? (['press', 'enter'] as const) : (['press'] as const);
  for (const how of ways) {
    const now = findCollapseToggle(card() ?? toggle) ?? toggle;
    if (how === 'press') press(now);
    else pressEnter(now);
    const result = await waitFor(opened, 1500);
    attempt.tries.push({ how, after: result ?? current() });
    if (result) return result;
    // Stop if the toggle changed in some other way, rather than pressing it again.
    if (state === 'collapsed' && current() !== 'collapsed') break;
  }
  if (state === 'unknown') {
    // We may have collapsed an open container: put it back.
    const now = findCollapseToggle(card() ?? toggle);
    if (now) press(now);
    return 'undone';
  }
  const shown = card();
  if (shown) attempt.structure = structureOf(shown);
  return 'failed';
}

/**
 * Opens the collapsed scopes, loops, conditions, branches and cases on the way to an action,
 * outermost first. Only clicks a toggle that says it is collapsed, or, when it can't tell,
 * clicks it and undoes the click if the next step doesn't appear, so open containers are never
 * left collapsed.
 */
export async function expandPath(path: string[], steps: Step[] = []): Promise<ExpandOutcome> {
  const expanded: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const parent = path[i] ?? '';
    const child = path[i + 1] ?? '';
    if (findActionElement(child)) continue;
    const parentStep = steps[i];
    const childStep = steps[i + 1];
    const containers: Container[] = [
      { label: `"${label(parent)}"`, card: () => containerCard(parent) },
    ];
    if (parentStep && childStep) {
      for (const id of branchCardIds(parentStep, childStep)) {
        containers.push({ label: branchLabel(parentStep, childStep), card: () => nodeById(id) });
      }
    }
    let shown = false;
    for (const container of containers) {
      const result = await open(container.card, child);
      if (result === 'shown' || result === 'opened') expanded.push(container.label);
      if (result === 'opened') return { expanded };
      if (result === 'undone') return { expanded, blockedAt: parent };
      if (result === 'failed') {
        const nodeId = container.card()?.dataset.id;
        return {
          expanded,
          blockedAt: parent,
          failed: { label: container.label, ...(nodeId ? { nodeId } : {}) },
        };
      }
      if (result === 'shown') {
        shown = true;
        break;
      }
    }
    if (!shown) return { expanded, blockedAt: parent };
  }
  return { expanded };
}

/** Node IDs look like `Name`, `Name-#scope`, `Name-#subgraph`…: the action name is the part before `-#`. */
export function actionNameOfNode(id: string): string {
  return id.replace(/-#.*$/, '');
}

function renderedNodes(documents = searchDocuments()): HTMLElement[] {
  return documents.flatMap((doc) => [...doc.querySelectorAll<HTMLElement>('.react-flow__node')]);
}

function nodeById(id: string): HTMLElement | undefined {
  const selector = `.react-flow__node[data-id="${CSS.escape(id)}"]`;
  for (const doc of searchDocuments()) {
    const node = doc.querySelector<HTMLElement>(selector);
    if (node) return node;
  }
  return undefined;
}

const settle = async () => {
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, 150));
};

/** Where each nested action sits: its parent and the branch of the parent that holds it. */
export type Parents = Record<string, { parent: string; branch: string }>;

/** The flow's structure, to tell where a drawn node sits relative to the action we want. */
export interface FlowShape {
  /** Trigger and action names in designer order. */
  index: Map<string, number>;
  parents: Parents;
  /** Switch case name → its Switch, for case cards whose ID is just the case name. */
  cases: Map<string, string>;
}

export function flowShape(order: string[], parents: Parents = {}): FlowShape {
  const cases = new Map<string, string>();
  for (const { parent, branch } of Object.values(parents)) {
    if (branch.startsWith('case:')) cases.set(branch.slice(5), parent);
  }
  return { index: new Map(order.map((name, i) => [name, i])), parents, cases };
}

/** What a drawn node stands for: an action, or a branch of a Condition or Switch (its card or area). */
export type Place = { action: string } | { parent: string; branch: string };

export function placeOfNode(id: string, shape: FlowShape): Place | undefined {
  const base = actionNameOfNode(id);
  if (shape.index.has(base)) return { action: base };
  const branch = /^(.*)-(actions|elseActions|defaultCase)$/.exec(base);
  if (branch?.[1] && shape.index.has(branch[1])) {
    const kind = { actions: 'actions', elseActions: 'else', defaultCase: 'default' }[
      branch[2] as 'actions' | 'elseActions' | 'defaultCase'
    ];
    return { parent: branch[1], branch: kind };
  }
  const caseOf = shape.cases.get(base);
  return caseOf ? { parent: caseOf, branch: `case:${base}` } : undefined;
}

/** The action's ancestors, outermost first, ending with the action itself. */
function lineage(name: string, parents: Parents): string[] {
  const chain = [name];
  for (let up = parents[name]; up && chain.length < 100; up = parents[up.parent]) {
    chain.unshift(up.parent);
  }
  return chain;
}

/**
 * Which action in the list holding `path[level]` (same parent, same branch) contains a drawn
 * node: that action's name, `'top'` for the branch's own card, or undefined when the node is
 * outside that list (another branch, or elsewhere in the flow).
 */
export function siblingAt(
  place: Place,
  path: string[],
  level: number,
  shape: FlowShape,
): string | undefined {
  const parent = level > 0 ? path[level - 1] : undefined;
  const branch = shape.parents[path[level] ?? '']?.branch;
  if ('branch' in place && place.parent === parent && place.branch === branch) return 'top';
  const chain = lineage('action' in place ? place.action : place.parent, shape.parents);
  if (parent === undefined) return chain[0];
  const at = chain.indexOf(parent);
  const child = at >= 0 ? chain[at + 1] : undefined;
  return child && shape.parents[child]?.branch === branch ? child : undefined;
}

interface Drawn {
  el: HTMLElement;
  place: Place;
}

/** Where the walk is: the deepest action on the path whose part of the canvas is drawn. */
function depthReached(drawn: Drawn[], path: string[], shape: FlowShape): number {
  for (let level = path.length - 1; level >= 0; level--) {
    if (drawn.some((d) => siblingAt(d.place, path, level, shape) === path[level])) return level;
  }
  return -1;
}

/**
 * The designer only draws what is near the visible part of the canvas, so an action far away
 * isn't on the page at all. Walk down the action's path instead of guessing: at each level,
 * find the drawn action in the same list (same parent and branch) that is closest to the next
 * step and jump past it, towards the step (lists run top to bottom; scopes, loops and
 * conditions are drawn as boxes, so one jump clears a whole container). When nothing in that
 * list is drawn, go to the list's start: the parent's header, or for a Condition or Switch the
 * branch's card, sweeping sideways from the header to find it (branches sit side by side).
 * Collapsed parents and branches are opened as they come into view.
 */
async function searchCanvas(
  name: string,
  path: string[],
  steps: Step[],
  shape: FlowShape,
  reservedRight: number,
  opened: Pick<ExpandOutcome, 'expanded' | 'failed'>,
): Promise<HTMLElement | undefined> {
  const tryFind = async () => {
    const found = findActionElement(name);
    if (found) return found;
    const outcome = await expandPath(path, steps);
    for (const e of outcome.expanded) if (!opened.expanded.includes(e)) opened.expanded.push(e);
    if (outcome.failed) opened.failed = outcome.failed;
    return findActionElement(name);
  };
  let found = await tryFind();
  // A toggle that doesn't open its container won't open on the next try either: stop there.
  if (found || opened.failed) return found;

  let best = { level: -2, distance: Infinity };
  let stale = 0;
  let sweep = { parent: '', direction: 1, turned: false };
  // Moved onto empty canvas: go back, then try again shifted sideways by these parts of a view.
  const NUDGES = [0.6, -0.6, 1.2, -1.2];
  let nudge = 0;
  let lastMove: { pane: HTMLElement; dx: number; dy: number } | undefined;
  for (let move = 0; move < 60 && stale < 10; move++) {
    const drawn = renderedNodes()
      .map((el) => ({ el, place: placeOfNode(el.dataset.id ?? '', shape) }))
      .filter((d): d is Drawn => d.place !== undefined);
    if (drawn.length === 0) {
      if (!lastMove || nudge >= NUDGES.length) return undefined;
      drag(lastMove.pane, -lastMove.dx, -lastMove.dy);
      lastMove = undefined;
      nudge += 1;
      await settle();
      continue;
    }
    const canvas = canvasOf(drawn[0]!.el);
    if (!canvas) return undefined;
    const area = visibleArea(canvas.container, reservedRight);

    const reached = depthReached(drawn, path, shape);
    const level = reached + 1;
    const step = path[level];
    let distance = Infinity;
    let dx = 0;
    let dy: number;
    if (step === undefined) {
      // The action's area is drawn but not the action itself: its header is further up.
      dy = area.height * 0.5;
    } else {
      const target = shape.index.get(step) ?? 0;
      const near = nearestSibling(drawn, path, level, shape, target);
      if (near && near.name !== 'top') {
        distance = Math.abs((shape.index.get(near.name) ?? 0) - target);
        const box = (findActionElement(near.name) ?? near.el).getBoundingClientRect();
        dx = area.x - (box.left + box.width / 2);
        if ((shape.index.get(near.name) ?? 0) < target) {
          // It's above the step: bring its bottom edge to the top of the view.
          dy = Math.min(area.top + area.height * 0.15 - box.bottom, -area.height * 0.5);
        } else {
          dy = Math.max(area.bottom - area.height * 0.15 - box.top, area.height * 0.5);
        }
      } else {
        const parent = path[level - 1];
        const parentStep = steps[level - 1];
        const childStep = steps[level];
        const card =
          near?.el ??
          (parentStep && childStep
            ? branchCardIds(parentStep, childStep)
                .map(nodeById)
                .find((el) => el !== undefined)
            : undefined);
        const branched = parentStep?.kind === 'condition' || parentStep?.kind === 'switch';
        const anchor = card ?? (parent !== undefined ? findActionElement(parent) : undefined);
        if (!anchor) return undefined;
        const box = anchor.getBoundingClientRect();
        // Aim at the top of the anchor: a header or branch card, not the middle of a tall box.
        dx = area.x - (box.left + box.width / 2);
        dy = area.top + area.height * 0.3 - box.top;
        const settled = Math.abs(dx) < 24 && Math.abs(dy) < 24;
        if (!card && branched && (settled || sweep.parent === parent)) {
          // At the Condition or Switch header and the branch card isn't drawn: branches sit
          // side by side under the header, so move along that row, right first, then left.
          if (sweep.parent !== parent)
            sweep = { parent: parent ?? '', direction: 1, turned: false };
          const edge = sweep.direction > 0 ? box.right - area.right : area.left - box.left;
          if (edge <= 0) {
            if (sweep.turned) return undefined;
            sweep = { ...sweep, direction: -sweep.direction, turned: true };
          }
          dx = -sweep.direction * (area.right - area.left) * 0.6;
        } else if (settled) {
          // At the start of the list and still nothing drawn: its actions are further down.
          dx = 0;
          dy = -area.height * 0.4;
        }
      }
    }

    if (level > best.level || (level === best.level && distance < best.distance)) {
      best = { level, distance };
      stale = 0;
      nudge = 0;
    } else {
      stale += 1;
    }
    if (nudge > 0) dx += (NUDGES[nudge - 1] ?? 0) * (area.right - area.left);
    lastMove = { pane: canvas.pane, dx, dy };
    drag(canvas.pane, dx, dy);
    await settle();
    found = await tryFind();
    if (found || opened.failed) return found;
  }
  return undefined;
}

/** The part of the canvas not covered by the pane, and its middle. */
function visibleArea(container: HTMLElement, reservedRight: number) {
  const box = container.getBoundingClientRect();
  const right = Math.max(Math.min(box.right, window.innerWidth - reservedRight), box.left + 100);
  return {
    left: box.left,
    right,
    top: box.top,
    bottom: box.bottom,
    height: box.height,
    x: (box.left + right) / 2,
  };
}

/** The drawn action in the step's list closest to the step, or the list's card when only that is drawn. */
function nearestSibling(
  drawn: Drawn[],
  path: string[],
  level: number,
  shape: FlowShape,
  target: number,
): { name: string; el: HTMLElement } | undefined {
  let near: { name: string; el: HTMLElement; distance: number } | undefined;
  for (const d of drawn) {
    const name = siblingAt(d.place, path, level, shape);
    if (!name) continue;
    const distance = name === 'top' ? Infinity : Math.abs((shape.index.get(name) ?? 0) - target);
    // Prefer the card itself over the branch's area when only the top of the branch is drawn.
    const isCard = d.el.dataset.id?.endsWith('-#subgraph') ?? false;
    if (!near || distance < near.distance || (distance === near.distance && isCard)) {
      near = { name, el: d.el, distance };
    }
  }
  return near;
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
  let opened: Pick<ExpandOutcome, 'expanded' | 'failed'> = { expanded: [] };
  if (!element) {
    if (!isDesignerOpen()) {
      return { ok: false, message: 'Open the flow in the designer (Edit) to jump to actions.' };
    }
    options.onProgress?.(`Searching the designer for "${label(name)}"…`);
    const walk = path.length > 0 ? path : [name];
    if (options.order && renderedNodes().length > 0) {
      element = await searchCanvas(
        name,
        walk,
        options.steps ?? [],
        flowShape(options.order, options.parents),
        reservedRight,
        opened,
      );
    } else {
      // No canvas to walk (classic designer): open collapsed parents on the page.
      opened = await expandPath(walk, options.steps);
      element = find();
    }
    const failedId = opened.failed?.nodeId;
    if (!element && opened.failed && failedId && nodeById(failedId)) {
      await centreWith(drag, () => nodeById(failedId), reservedRight);
      const shown = nodeById(failedId);
      if (shown) highlight(shown);
      return {
        ok: false,
        message: `"${label(name)}" is inside ${opened.failed.label}, which didn't open when clicked. Expand it by hand (it's highlighted), then click again.`,
      };
    }
    if (!element) {
      const steps = options.steps ?? [];
      const parentStep = steps[path.length - 2];
      const ownStep = steps[path.length - 1];
      const branched = parentStep?.kind === 'condition' || parentStep?.kind === 'switch';
      const card =
        parentStep && ownStep
          ? branchCardIds(parentStep, ownStep)
              .map(nodeById)
              .find((el) => el !== undefined)
          : undefined;
      const parent = [...path.slice(0, -1)].reverse().find((p) => findActionElement(p));
      if (card || parent) {
        if (card) {
          const id = card.dataset.id ?? '';
          await centreWith(drag, () => nodeById(id), reservedRight);
          const shown = nodeById(id);
          if (shown) highlight(shown);
        } else if (parent) {
          await revealAction(parent, [], options);
        }
        const where =
          parentStep && ownStep && branched
            ? branchLabel(parentStep, ownStep)
            : `"${label(path[path.length - 2] ?? parent ?? '')}"`;
        return {
          ok: false,
          message: `"${label(name)}" is inside ${where}, which couldn't be opened automatically. Expand it (and any collapsed step inside it that holds the action), then click again.`,
        };
      }
      return {
        ok: false,
        message: `Couldn't find "${label(name)}" in the designer after searching the canvas. If it's inside a collapsed step or branch, expand it and click again, or copy the designer check below and send it to us.`,
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
  const list = opened.expanded.length ? ` (opened ${opened.expanded.join(' › ')})` : '';
  return { ok: true, message: `Showing "${label(name)}"${list}.` };
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
    nodeClasses: [...new Set(nodes.map((n) => n.className))].slice(0, 10),
    containerNodeIds: nodes
      .map((n) => n.dataset.id ?? '')
      .filter((id) => id.includes('-#'))
      .slice(0, 15),
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
    toggleAttempts,
    frames: [...document.querySelectorAll('iframe')].map((f) => ({
      host: f.src ? new URL(f.src, location.href).host : '',
      sameOrigin: canRead(f),
    })),
  };
}
