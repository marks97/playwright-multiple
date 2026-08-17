'use strict';

const { createRng, sampleClamped, uniform, randomInt, chance } = require('./rng');
const { pointerPath } = require('./pointerPath');

const PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

class HumanInput {
  constructor(options = {}) {
    this.rng = options.rng || createRng(options.seed);
    this.sleep = options.sleep || defaultSleep;
    this.cursor = options.startCursor || { x: 12, y: 14 };
    this.moveSteps = options.moveSteps || { min: 8, max: 20 };
    this.maxStepPx = options.maxStepPx || 90;
    this.click = options.click || { mean: 110, sd: 35, min: 60, max: 180 };
    this.typing = options.typing || { mean: 120, sd: 45, min: 42, max: 320 };
    this.moveDelay = options.moveDelay || { min: 8, max: 17 };
  }

  sampleClickDwell() {
    return sampleClamped(this.rng, this.click.mean, this.click.sd, this.click.min, this.click.max);
  }

  sampleKeyDelay(char, prevChar) {
    let delay = sampleClamped(this.rng, this.typing.mean, this.typing.sd, this.typing.min, this.typing.max);
    if (prevChar && PUNCTUATION.has(prevChar)) delay += sampleClamped(this.rng, 160, 70, 40, 360);
    if (prevChar === ' ') delay += sampleClamped(this.rng, 70, 40, 10, 200);
    if (chance(this.rng, 0.03)) delay += sampleClamped(this.rng, 420, 180, 120, 900);
    return delay;
  }

  buildPath(target) {
    const steps = randomInt(this.rng, this.moveSteps.min, this.moveSteps.max);
    return pointerPath(this.cursor, target, {
      rng: this.rng,
      maxStepPx: this.maxStepPx,
      minSteps: steps,
    });
  }

  async moveTo(page, x, y) {
    const target = { x, y };
    const points = this.buildPath(target);
    for (const point of points) {
      await page.mouse.move(point.x, point.y);
      await this.sleep(uniform(this.rng, this.moveDelay.min, this.moveDelay.max));
    }
    this.cursor = { x, y };
    return points;
  }

  pickPointInBox(box) {
    const marginX = Math.min(box.width * 0.3, 8);
    const marginY = Math.min(box.height * 0.3, 6);
    return {
      x: box.x + box.width / 2 + uniform(this.rng, -marginX, marginX),
      y: box.y + box.height / 2 + uniform(this.rng, -marginY, marginY),
    };
  }

  async scrollIntoView(page, locator) {
    let info;
    try {
      info = await locator.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, height: rect.height, viewport: window.innerHeight };
      });
    } catch {
      return;
    }
    if (!info) return;
    const viewport = info.viewport || 800;
    const desired = viewport * uniform(this.rng, 0.35, 0.55);
    const delta = info.top - desired;
    if (Math.abs(delta) < viewport * 0.15) return;
    const steps = randomInt(this.rng, 4, 9);
    let done = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = t * t * (3 - 2 * t);
      const targetTotal = delta * eased;
      const stepDelta = targetTotal - done;
      done = targetTotal;
      await page.mouse.wheel(0, stepDelta);
      await this.sleep(sampleClamped(this.rng, 55, 25, 15, 140));
    }
  }

  async clickBox(page, box, options = {}) {
    const point = this.pickPointInBox(box);
    await this.moveTo(page, point.x, point.y);
    const button = options.button || 'left';
    const modifiers = options.modifiers || [];
    for (const mod of modifiers) await page.keyboard.down(mod);
    const rounds = options.doubleClick ? 2 : 1;
    for (let i = 0; i < rounds; i++) {
      await page.mouse.down({ button });
      await this.sleep(this.sampleClickDwell());
      await page.mouse.up({ button });
      if (i === 0 && rounds > 1) await this.sleep(sampleClamped(this.rng, 90, 30, 40, 160));
    }
    for (const mod of modifiers.slice().reverse()) await page.keyboard.up(mod);
    return point;
  }

  async clickLocator(page, locator, options = {}) {
    await this.scrollIntoView(page, locator);
    const box = await locator.boundingBox();
    if (!box) {
      await locator.click(options.fallbackOptions || {});
      return null;
    }
    return this.clickBox(page, box, options);
  }

  async hoverLocator(page, locator) {
    await this.scrollIntoView(page, locator);
    const box = await locator.boundingBox();
    if (!box) {
      await locator.hover();
      return null;
    }
    const point = this.pickPointInBox(box);
    await this.moveTo(page, point.x, point.y);
    return point;
  }

  async typeText(page, text) {
    let prevChar = null;
    for (const char of String(text)) {
      await page.keyboard.type(char);
      await this.sleep(this.sampleKeyDelay(char, prevChar));
      prevChar = char;
    }
  }

  async typeIntoLocator(page, locator, text, options = {}) {
    await this.clickLocator(page, locator);
    if (options.replace) {
      await page.keyboard.press('ControlOrMeta+A');
      await this.sleep(sampleClamped(this.rng, 60, 25, 20, 140));
      await page.keyboard.press('Delete');
      await this.sleep(sampleClamped(this.rng, 60, 25, 20, 140));
    }
    await this.typeText(page, text);
  }

  async pressKey(page, key) {
    await this.sleep(sampleClamped(this.rng, 90, 40, 20, 220));
    await page.keyboard.press(key);
  }

  async dragLocators(page, startLocator, endLocator) {
    const startBox = await startLocator.boundingBox();
    const endBox = await endLocator.boundingBox();
    if (!startBox || !endBox) {
      await startLocator.dragTo(endLocator);
      return;
    }
    const start = this.pickPointInBox(startBox);
    const end = this.pickPointInBox(endBox);
    await this.moveTo(page, start.x, start.y);
    await page.mouse.down();
    await this.sleep(sampleClamped(this.rng, 120, 40, 60, 240));
    const points = this.buildPath(end);
    for (const point of points) {
      await page.mouse.move(point.x, point.y);
      await this.sleep(uniform(this.rng, this.moveDelay.min, this.moveDelay.max));
    }
    this.cursor = { x: end.x, y: end.y };
    await this.sleep(sampleClamped(this.rng, 90, 30, 40, 160));
    await page.mouse.up();
  }
}

module.exports = { HumanInput, defaultSleep, PUNCTUATION };
