'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { HumanInput } = require('../lib/human/humanInput');
const { makeHandlers, INPUT_TOOL_NAMES } = require('../lib/human/tools');
const { createFakePage, createFakeLocator } = require('./helpers/fakes');

function createFakeResponse() {
  return {
    errors: [],
    code: [],
    snapshot: false,
    setIncludeSnapshot() { this.snapshot = true; },
    addCode(line) { this.code.push(line); },
    addError(message) { this.errors.push(message); },
  };
}

function createFakeTab(page, locators) {
  return {
    page,
    actionTimeoutOptions: {},
    modalStates: () => [],
    waitForCompletion: async (fn) => fn(),
    context: { lookupSecret: (text) => ({ value: text, code: JSON.stringify(text) }) },
    refLocator: async (params) => ({ locator: locators[params.ref] || locators.default, resolved: `ref('${params.ref || 'x'}')` }),
    refLocators: async (list) => list.map((p) => ({ locator: locators[p.ref] || locators.default, resolved: `ref('${p.ref}')` })),
  };
}

function setup(locators) {
  const page = createFakePage();
  const tab = createFakeTab(page, locators);
  const context = { ensureTab: async () => tab };
  const human = new HumanInput({ seed: 321, sleep: () => Promise.resolve() });
  const handlers = makeHandlers(human);
  return { page, tab, context, handlers };
}

test('all documented input tools have humanized handlers', () => {
  const human = new HumanInput({ seed: 1, sleep: () => Promise.resolve() });
  const handlers = makeHandlers(human);
  for (const name of INPUT_TOOL_NAMES) assert.equal(typeof handlers[name], 'function', `${name} handler missing`);
});

test('browser_type types character by character and never fills', async () => {
  const locator = createFakeLocator({ x: 100, y: 120, width: 200, height: 30 });
  const { context, handlers } = setup({ default: locator });
  const response = createFakeResponse();
  await handlers.browser_type(context, { ref: 'r1', text: 'abc' }, response);
  assert.equal(locator.state.fillCalled, false, 'humanized type must not call fill()');
});

test('browser_type emits one key event per character', async () => {
  const locator = createFakeLocator({ x: 100, y: 120, width: 200, height: 30 });
  const s = setup({ default: locator });
  const response = createFakeResponse();
  await s.handlers.browser_type(s.context, { ref: 'r1', text: 'abcd' }, response);
  const keys = s.page.events.filter((e) => e.t === 'key');
  assert.equal(keys.length, 4);
  assert.equal(keys.map((e) => e.text).join(''), 'abcd');
});

test('browser_click moves the pointer before pressing', async () => {
  const locator = createFakeLocator({ x: 500, y: 400, width: 100, height: 40 });
  const s = setup({ default: locator });
  const response = createFakeResponse();
  await s.handlers.browser_click(s.context, { ref: 'r1' }, response);
  const downIdx = s.page.events.findIndex((e) => e.t === 'down');
  const movesBefore = s.page.events.slice(0, downIdx).filter((e) => e.t === 'move');
  assert.ok(movesBefore.length >= 8, `expected >=8 moves before click, got ${movesBefore.length}`);
  assert.ok(s.page.events.some((e) => e.t === 'up'));
});

test('browser_check clicks only when state differs', async () => {
  const unchecked = createFakeLocator({ x: 10, y: 10, width: 20, height: 20 }, { checked: false });
  const s1 = setup({ default: unchecked });
  await s1.handlers.browser_check(s1.context, { ref: 'r1' }, createFakeResponse());
  assert.ok(s1.page.events.some((e) => e.t === 'down'), 'unchecked box must be clicked to check');

  const checked = createFakeLocator({ x: 10, y: 10, width: 20, height: 20 }, { checked: true });
  const s2 = setup({ default: checked });
  await s2.handlers.browser_check(s2.context, { ref: 'r1' }, createFakeResponse());
  assert.ok(!s2.page.events.some((e) => e.t === 'down'), 'already-checked box must not be re-clicked');
});

test('modal state blocks input tools with an error', async () => {
  const locator = createFakeLocator({ x: 10, y: 10, width: 20, height: 20 });
  const s = setup({ default: locator });
  s.tab.modalStates = () => [{ type: 'dialog' }];
  const response = createFakeResponse();
  await s.handlers.browser_click(s.context, { ref: 'r1' }, response);
  assert.equal(response.errors.length, 1);
  assert.ok(!s.page.events.some((e) => e.t === 'down'));
});
