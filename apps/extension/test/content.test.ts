// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { analyseFlow } from '@cfa/core';
import { HOST_ID, Pane } from '../src/content/pane.ts';
import {
  designerCheck,
  findActionElement,
  isDesignerOpen,
  revealAction,
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
