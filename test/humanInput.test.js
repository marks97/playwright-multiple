'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { HumanInput } = require('../lib/human/humanInput');
const { pointerPath, maxSegment } = require('../lib/human/pointerPath');
const { createRng } = require('../lib/human/rng');
const { createFakePage, createFakeLocator } = require('./helpers/fakes');

function stats(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

test('click dwell has a human mean and non-zero variance', () => {
  const human = new HumanInput({ seed: 42 });
  const samples = [];
  for (let i = 0; i < 200; i++) samples.push(human.sampleClickDwell());
  const { mean, sd } = stats(samples);
  assert.ok(mean >= 60 && mean <= 180, `mean ${mean} must be in [60,180]`);
  assert.ok(sd > 20, `stddev ${sd} must exceed 20 (a constant delay would fail this)`);
  const constant = samples.every((v) => v === samples[0]);
  assert.ok(!constant, 'dwell must not be constant');
});

test('inter-key delays average above 40ms with real variance', () => {
  const human = new HumanInput({ seed: 7 });
  const samples = [];
  let prev = null;
  for (const ch of 'the quick brown fox, jumped! over.') {
    samples.push(human.sampleKeyDelay(ch, prev));
    prev = ch;
  }
  const { mean, sd } = stats(samples);
  assert.ok(mean > 40, `mean inter-key ${mean} must exceed 40ms`);
  assert.ok(sd > 10, `inter-key stddev ${sd} must show real variance`);
});

test('a click is preceded by at least 8 move events and no oversized jumps', async () => {
  const page = createFakePage();
  const human = new HumanInput({ seed: 123, sleep: () => Promise.resolve(), startCursor: { x: 5, y: 5 } });
  const locator = createFakeLocator({ x: 640, y: 480, width: 120, height: 40 });
  await human.clickLocator(page, locator, {});

  const moves = page.events.filter((e) => e.t === 'move');
  const downIdx = page.events.findIndex((e) => e.t === 'down');
  const movesBeforeDown = page.events.slice(0, downIdx).filter((e) => e.t === 'move');
  assert.ok(movesBeforeDown.length >= 8, `expected >=8 moves before click, got ${movesBeforeDown.length}`);

  let prev = { x: 5, y: 5 };
  let maxJump = 0;
  for (const m of moves) {
    maxJump = Math.max(maxJump, Math.hypot(m.x - prev.x, m.y - prev.y));
    prev = m;
  }
  assert.ok(maxJump <= human.maxStepPx + 1, `max pointer jump ${maxJump} exceeded ${human.maxStepPx}`);
});

test('click emits down, a sampled dwell, then up', async () => {
  const events = [];
  const page = createFakePage(events);
  const human = new HumanInput({ seed: 99, sleep: (ms) => { events.push({ t: 'sleep', ms }); return Promise.resolve(); } });
  const locator = createFakeLocator({ x: 300, y: 200, width: 80, height: 30 });
  await human.clickLocator(page, locator, {});

  const downIdx = events.findIndex((e) => e.t === 'down');
  assert.ok(downIdx !== -1);
  assert.equal(events[downIdx + 1].t, 'sleep', 'dwell sleep must sit between down and up');
  assert.equal(events[downIdx + 2].t, 'up');
  const dwell = events[downIdx + 1].ms;
  assert.ok(dwell >= 60 && dwell <= 180, `dwell ${dwell} in range`);
});

test('typing emits real key events per character and never uses fill()', async () => {
  const page = createFakePage();
  const human = new HumanInput({ seed: 55, sleep: () => Promise.resolve() });
  const locator = createFakeLocator({ x: 100, y: 100, width: 200, height: 30 });
  await human.typeIntoLocator(page, locator, 'Hi!', { replace: true });

  assert.equal(locator.state.fillCalled, false, 'fill() must not be called in humanized mode');
  const typed = page.events.filter((e) => e.t === 'key').map((e) => e.text).join('');
  assert.equal(typed, 'Hi!');
  assert.equal(page.events.filter((e) => e.t === 'key').length, 3, 'one key event per character');
});

test('scroll emits several wheel events for an element below the fold', async () => {
  const page = createFakePage();
  const human = new HumanInput({ seed: 8, sleep: () => Promise.resolve() });
  const locator = createFakeLocator({ x: 100, y: 2400, width: 100, height: 30 }, { viewport: 800 });
  await human.scrollIntoView(page, locator);
  const wheels = page.events.filter((e) => e.t === 'wheel');
  assert.ok(wheels.length >= 3, `expected several wheel steps, got ${wheels.length}`);
});

test('pointer path always meets the min-step and max-jump guarantees', () => {
  const rng = createRng(2024);
  const cases = [
    [{ x: 0, y: 0 }, { x: 5, y: 3 }],
    [{ x: 0, y: 0 }, { x: 40, y: 10 }],
    [{ x: 10, y: 10 }, { x: 900, y: 700 }],
    [{ x: 800, y: 100 }, { x: 20, y: 600 }],
  ];
  for (const [from, to] of cases) {
    const points = pointerPath(from, to, { rng, maxStepPx: 90, minSteps: 12 });
    assert.ok(points.length >= 8, `path ${JSON.stringify(from)}→${JSON.stringify(to)} had ${points.length} points`);
    assert.ok(maxSegment(from, points) <= 91, 'no segment may exceed maxStepPx');
    const last = points[points.length - 1];
    assert.ok(Math.abs(last.x - to.x) < 0.001 && Math.abs(last.y - to.y) < 0.001, 'path must end exactly on target');
  }
});
