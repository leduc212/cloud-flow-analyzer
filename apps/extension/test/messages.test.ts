import { describe, expect, it } from 'vitest';
import { MESSAGE_SOURCES, isAllowed, messageSource } from '../src/shared/messages.ts';

const ID = 'abcdefghijklmnop';
const page = { id: ID, url: `chrome-extension://${ID}/flows.html` };
const pane = {
  id: ID,
  url: 'https://make.powerautomate.com/environments/e/flows/f/details',
  tab: { id: 7 },
};

describe('message senders', () => {
  it('tells extension pages, portal tabs and anything else apart', () => {
    expect(messageSource(page, ID)).toBe('extension-page');
    expect(messageSource(pane, ID)).toBe('portal-tab');
    expect(messageSource({ ...pane, url: 'https://evil.example.com/' }, ID)).toBe('unknown');
    expect(messageSource({ ...pane, tab: {} }, ID)).toBe('unknown');
    expect(messageSource({ ...page, id: 'other-extension' }, ID)).toBe('unknown');
    expect(messageSource({ id: ID }, ID)).toBe('unknown');
  });

  it('lets each message come only from where it belongs', () => {
    expect(isAllowed({ type: 'cfa:analyse-tab', tabId: 7 }, page, ID)).toBe(true);
    expect(isAllowed({ type: 'cfa:analyse-tab', tabId: 7 }, pane, ID)).toBe(false);
    expect(isAllowed({ type: 'cfa:analyse-sender' }, pane, ID)).toBe(true);
    expect(isAllowed({ type: 'cfa:analyse-sender' }, page, ID)).toBe(false);
    expect(isAllowed({ type: 'cfa:open-flow', environment: 'e', flowName: 'f' }, pane, ID)).toBe(
      false,
    );
    expect(isAllowed({ type: 'cfa:clear-run-cache' }, pane, ID)).toBe(true);
    expect(isAllowed({ type: 'cfa:clear-run-cache' }, page, ID)).toBe(true);
  });

  it('rejects malformed and unknown messages', () => {
    for (const message of [null, 'cfa:analyse-sender', {}, { type: 42 }, { type: 'toString' }]) {
      expect(isAllowed(message, pane, ID)).toBe(false);
    }
  });

  it('covers every message the worker handles', () => {
    expect(Object.keys(MESSAGE_SOURCES).sort()).toEqual([
      'cfa:analyse-sender',
      'cfa:analyse-tab',
      'cfa:cancel-runs',
      'cfa:clear-run-cache',
      'cfa:open-capture',
      'cfa:open-flow',
      'cfa:open-flows',
      'cfa:set-limit',
    ]);
  });
});
