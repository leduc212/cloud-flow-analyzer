import './site.css';
import { FlowParseError, RULES, analyseFlow } from '@cfa/core';
import { renderReport } from './report.ts';
import { SAMPLES } from './samples.ts';
import { h } from './dom.ts';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = byId<HTMLTextAreaElement>('input');
const sample = byId<HTMLSelectElement>('sample');
const file = byId<HTMLInputElement>('file');
const status = byId<HTMLSpanElement>('status');
const report = byId<HTMLElement>('report');

byId<HTMLElement>('rule-count').textContent = String(RULES.length);

function setStatus(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function analyse(): void {
  const text = input.value.trim();
  if (!text) {
    setStatus('Paste a flow definition first, or pick a sample.', true);
    return;
  }
  try {
    const analysis = analyseFlow(text);
    report.replaceChildren(renderReport(analysis));
    setStatus(`${analysis.findings.length} findings.`);
    report.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    report.replaceChildren();
    setStatus(
      error instanceof FlowParseError ? error.message : `Couldn't analyse this: ${String(error)}`,
      true,
    );
  }
}

sample.replaceChildren(
  h('option', { value: '' }, 'Pick a sample…'),
  ...SAMPLES.map((s) => h('option', { value: s.id }, s.label)),
);
sample.addEventListener('change', () => {
  const picked = SAMPLES.find((s) => s.id === sample.value);
  if (!picked) return;
  input.value = JSON.stringify(picked.flow, null, 2);
  analyse();
});
file.addEventListener('change', () => {
  const chosen = file.files?.[0];
  if (!chosen) return;
  void chosen.text().then((text) => {
    input.value = text;
    analyse();
  });
});
byId<HTMLButtonElement>('analyse').addEventListener('click', analyse);
