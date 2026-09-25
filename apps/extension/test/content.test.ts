// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { analyseFlow } from '@cfa/core';
import { HOST_ID, Pane } from '../src/content/pane.ts';
import {
  actionNameOfNode,
  branchCardIds,
  designerCheck,
  expandPath,
  findActionElement,
  isDesignerOpen,
  revealAction,
  toggleState,
} from '../src/content/reveal.ts';
import { buildPaneResult } from '../src/shared/pane-result.ts';

vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/g, '\\$&') });

afterEach(() => {
  document.body.innerHTML = '';
  document.getElementById(HOST_ID)?.remove();
});

describe('findActionElement', () => {
  it('finds React Flow nodes by action name, including scope headers', () => {
    document.body.innerHTML = `
      <div class="react-flow">
        <div class="react-flow__node" data-id="List_rows_2">x</div>
        <div class="react-flow__node" data-id="List_rows">a</div>
        <div class="react-flow__node" data-id="Apply_to_each-#scope">b</div>
        <div class="react-flow__node" data-id="When_a_row_is_added,_modified_or_deleted">c</div>
      </div>`;
    expect(findActionElement('List_rows')?.textContent).toBe('a');
    expect(findActionElement('Apply_to_each')?.textContent).toBe('b');
    expect(findActionElement('When_a_row_is_added,_modified_or_deleted')?.textContent).toBe('c');
    expect(findActionElement('Missing')).toBeUndefined();
    expect(isDesignerOpen()).toBe(true);
  });

  it('falls back to card titles (classic designer)', () => {
    document.body.innerHTML = `
      <div class="msla-card" id="card"><span class="msla-card-title"> Get  a row </span></div>`;
    expect(findActionElement('Get_a_row')?.id).toBe('card');
  });
});

describe('revealAction', () => {
  it('asks for the designer when it is not open', async () => {
    document.body.innerHTML = '<main>Flow details</main>';
    const outcome = await revealAction('Get_a_row', ['Get_a_row']);
    expect(outcome).toEqual({
      ok: false,
      message: expect.stringContaining('Open the flow in the designer'),
    });
  });

  it('points at the collapsed parent when the action is hidden', async () => {
    document.body.innerHTML = `
      <div class="msla-designer"><div class="msla-card"><span class="msla-card-title">Apply to each</span></div></div>`;
    Element.prototype.scrollIntoView = () => {};
    Element.prototype.animate = () => ({}) as Animation;
    const outcome = await revealAction('Get_a_row', ['Apply_to_each', 'Get_a_row']);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('inside "Apply to each"');
  });

  it('lists what the page contains for the designer check', () => {
    document.body.innerHTML = `
      <div class="react-flow"><div class="react-flow__pane"></div>
      <div class="react-flow__node" data-id="A">a</div></div>`;
    expect(designerCheck()).toMatchObject({ designerFound: true, nodeCount: 1, nodeIds: ['A'] });
  });
});

/**
 * A tiny designer: each container has a header node with a toggle; clicking it shows or hides
 * the container's children, like the new designer's collapse button.
 */
function designer(
  containers: Record<string, { children: string[]; collapsed: boolean; label?: 'aria' | 'none' }>,
) {
  document.body.innerHTML = '<div class="react-flow"></div>';
  const canvas = document.querySelector('.react-flow')!;
  const visible = (name: string): boolean =>
    Object.entries(containers).every(
      ([parent, c]) => !c.children.includes(name) || (!c.collapsed && visible(parent)),
    );
  const all = new Set([
    ...Object.keys(containers),
    ...Object.values(containers).flatMap((c) => c.children),
  ]);
  const render = () => {
    canvas.innerHTML = '';
    for (const name of all) {
      if (!visible(name)) continue;
      const container = containers[name];
      const node = document.createElement('div');
      node.className = 'react-flow__node';
      node.dataset.id = container ? `${name}-#scope` : name;
      if (container) {
        const toggle = document.createElement('button');
        toggle.className = 'msla-collapse-toggle';
        if (container.label !== 'none') {
          toggle.setAttribute('aria-label', container.collapsed ? 'Expand' : 'Collapse');
        }
        toggle.addEventListener('click', () => {
          container.collapsed = !container.collapsed;
          render();
        });
        node.append(toggle);
      }
      canvas.append(node);
    }
  };
  render();
  return containers;
}

describe('actionNameOfNode', () => {
  it('strips the designer suffixes from node IDs', () => {
    expect(actionNameOfNode('Get_a_row')).toBe('Get_a_row');
    expect(actionNameOfNode('Apply_to_each-#scope')).toBe('Apply_to_each');
    expect(actionNameOfNode('Case_1-#subgraph')).toBe('Case_1');
  });
});

describe('expandPath', () => {
  it('opens collapsed parents, outermost first', async () => {
    designer({
      Scope_OCR: { children: ['Loop'], collapsed: true },
      Loop: { children: ['Create_Non-PO_4'], collapsed: true },
    });
    expect(findActionElement('Create_Non-PO_4')).toBeUndefined();
    const outcome = await expandPath(['Scope_OCR', 'Loop', 'Create_Non-PO_4']);
    expect(outcome).toEqual({ expanded: ['"Scope OCR"', '"Loop"'] });
    expect(findActionElement('Create_Non-PO_4')).toBeDefined();
  });

  it('leaves already open parents alone', async () => {
    const state = designer({
      Scope_OCR: { children: ['Loop'], collapsed: false },
      Loop: { children: ['Create_Non-PO_4'], collapsed: true },
    });
    const outcome = await expandPath(['Scope_OCR', 'Loop', 'Create_Non-PO_4']);
    expect(outcome.expanded).toEqual(['"Loop"']);
    expect(state.Scope_OCR?.collapsed).toBe(false);
  });

  it('never clicks a toggle that says it is open, even if the action is missing', async () => {
    const state = designer({ Switch: { children: ['Other'], collapsed: false } });
    const outcome = await expandPath(['Switch', 'Hidden_in_a_case']);
    expect(outcome).toEqual({ expanded: [], blockedAt: 'Switch' });
    expect(state.Switch?.collapsed).toBe(false);
  });

  it('undoes a click on an unlabelled toggle that did not help', async () => {
    const state = designer({ Scope: { children: ['Other'], collapsed: false, label: 'none' } });
    const outcome = await expandPath(['Scope', 'Hidden']);
    expect(outcome.blockedAt).toBe('Scope');
    expect(state.Scope?.collapsed).toBe(false);
  }, 10_000);

  it('opens a collapsed Switch case or Condition branch card', async () => {
    document.body.innerHTML = `
      <div class="react-flow">
        <div class="react-flow__node" data-id="Switch-#scope"><button class="msla-collapse-toggle" aria-label="Collapse"></button></div>
        <div class="react-flow__node" data-id="Case_2-#subgraph"><button class="msla-collapse-toggle" aria-label="Expand"></button></div>
      </div>`;
    document.querySelector('[data-id="Case_2-#subgraph"] button')!.addEventListener('click', () => {
      const node = document.createElement('div');
      node.className = 'react-flow__node';
      node.dataset.id = 'Send_email';
      document.querySelector('.react-flow')!.append(node);
    });
    const outcome = await expandPath(
      ['Switch', 'Send_email'],
      [
        { name: 'Switch', kind: 'switch' },
        { name: 'Send_email', kind: 'connector', branch: 'case:Case_2' },
      ],
    );
    expect(outcome).toEqual({ expanded: ['case "Case 2"'] });
  });

  it('names branch cards the way the designer does', () => {
    const condition = { name: 'Check', kind: 'condition' };
    const sw = { name: 'Switch', kind: 'switch' };
    expect(branchCardIds(condition, { name: 'A', kind: 'x', branch: 'actions' })[0]).toBe(
      'Check-actions-#subgraph',
    );
    expect(branchCardIds(condition, { name: 'A', kind: 'x', branch: 'else' })[0]).toBe(
      'Check-elseActions-#subgraph',
    );
    expect(branchCardIds(sw, { name: 'A', kind: 'x', branch: 'default' })[0]).toBe(
      'Switch-defaultCase-#subgraph',
    );
    expect(branchCardIds({ name: 'S', kind: 'scope' }, { name: 'A', kind: 'x' })).toEqual([]);
  });

  it('reads toggle state from aria-expanded or the label', () => {
    const toggle = document.createElement('button');
    toggle.setAttribute('aria-expanded', 'false');
    expect(toggleState(toggle)).toBe('collapsed');
    toggle.removeAttribute('aria-expanded');
    toggle.setAttribute('aria-label', 'Collapse');
    expect(toggleState(toggle)).toBe('expanded');
    toggle.setAttribute('aria-label', 'Thu gọn');
    expect(toggleState(toggle)).toBe('unknown');
  });
});

describe('Pane', () => {
  const result = buildPaneResult({ environment: 'env', flowId: 'flow' }, analyseFlow(bad));
  const shadow = () => document.getElementById(HOST_ID)!.shadowRoot!;

  it('shows the grade, the findings and severity filters', () => {
    const pane = new Pane(() => {});
    pane.showResult(result);
    expect(shadow().querySelector('.grade')?.textContent).toBe(result.grade);
    expect(shadow().querySelectorAll('.finding')).toHaveLength(result.findings.length);
    const high = [...shadow().querySelectorAll<HTMLButtonElement>('.chip')].find((c) =>
      c.textContent?.startsWith('High'),
    )!;
    high.click();
    expect(shadow().querySelectorAll('.finding')).toHaveLength(
      result.findings.filter((f) => f.severity === 'high').length,
    );
    pane.close();
  });

  it('asks the worker to analyse again, and shows errors', () => {
    const send = vi.fn();
    const pane = new Pane(send);
    pane.showError('No token captured yet.');
    expect(shadow().querySelector('.state.error')?.textContent).toBe('No token captured yet.');
    shadow().querySelector<HTMLButtonElement>('button[aria-label="Analyse again"]')!.click();
    expect(send).toHaveBeenCalledWith({ type: 'cfa:analyse-sender' });
    pane.close();
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it('never renders finding text as HTML', () => {
    const pane = new Pane(() => {});
    pane.showResult({
      ...result,
      findings: [{ ...result.findings[0]!, message: '<img src=x onerror=alert(1)>' }],
    });
    expect(shadow().querySelector('.message')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(shadow().querySelector('img')).toBeNull();
    pane.close();
  });
});
