'use strict';

function createFakePage(events) {
  const log = events || [];
  return {
    events: log,
    mouse: {
      move: async (x, y) => { log.push({ t: 'move', x, y }); },
      down: async (options) => { log.push({ t: 'down', button: options && options.button }); },
      up: async (options) => { log.push({ t: 'up', button: options && options.button }); },
      wheel: async (dx, dy) => { log.push({ t: 'wheel', dx, dy }); },
    },
    keyboard: {
      type: async (text) => { log.push({ t: 'key', text }); },
      press: async (key) => { log.push({ t: 'press', key }); },
      down: async (key) => { log.push({ t: 'kdown', key }); },
      up: async (key) => { log.push({ t: 'kup', key }); },
    },
  };
}

function createFakeLocator(box, options = {}) {
  const state = { checked: options.checked || false, fillCalled: false, selected: null };
  return {
    state,
    boundingBox: async () => box,
    evaluate: async () => ({ top: box ? box.y : 0, height: box ? box.height : 0, viewport: options.viewport || 800 }),
    isChecked: async () => state.checked,
    click: async () => { state.clicked = true; },
    hover: async () => { state.hovered = true; },
    fill: async () => { state.fillCalled = true; },
    selectOption: async (value) => { state.selected = value; },
  };
}

module.exports = { createFakePage, createFakeLocator };
