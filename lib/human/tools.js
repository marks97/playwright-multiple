'use strict';

const INPUT_TOOL_NAMES = new Set([
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_check',
  'browser_uncheck',
  'browser_drag',
  'browser_press_key',
  'browser_press_sequentially',
]);

async function guardTab(context, name, response) {
  const tab = await context.ensureTab();
  const modalStates = tab.modalStates().map((state) => state.type);
  if (modalStates.length) {
    response.addError(`Error: Tool "${name}" does not handle the modal state.`);
    return null;
  }
  return tab;
}

function makeHandlers(human) {
  return {
    browser_click: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_click', response);
      if (!tab) return;
      response.setIncludeSnapshot();
      const { locator, resolved } = await tab.refLocator(params);
      response.addCode(`await page.${resolved}.${params.doubleClick ? 'dblclick' : 'click'}();`);
      await tab.waitForCompletion(async () => {
        await human.clickLocator(tab.page, locator, {
          button: params.button,
          modifiers: params.modifiers,
          doubleClick: params.doubleClick,
          fallbackOptions: { button: params.button, modifiers: params.modifiers },
        });
      });
    },
    browser_hover: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_hover', response);
      if (!tab) return;
      response.setIncludeSnapshot();
      const { locator, resolved } = await tab.refLocator(params);
      response.addCode(`await page.${resolved}.hover();`);
      await tab.waitForCompletion(async () => {
        await human.hoverLocator(tab.page, locator);
      });
    },
    browser_type: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_type', response);
      if (!tab) return;
      const { locator, resolved } = await tab.refLocator(params);
      const secret = tab.context.lookupSecret(params.text);
      await tab.waitForCompletion(async () => {
        response.setIncludeSnapshot();
        response.addCode(`await page.${resolved}.pressSequentially(${secret.code});`);
        await human.typeIntoLocator(tab.page, locator, secret.value, { replace: true });
        if (params.submit) {
          response.addCode(`await page.${resolved}.press('Enter');`);
          await human.pressKey(tab.page, 'Enter');
        }
      });
    },
    browser_fill_form: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_fill_form', response);
      if (!tab) return;
      for (const field of params.fields) {
        const { locator, resolved } = await tab.refLocator({ element: field.name, ref: field.ref, selector: field.selector });
        const source = `await page.${resolved}`;
        if (field.type === 'textbox' || field.type === 'slider') {
          const secret = tab.context.lookupSecret(field.value);
          await human.typeIntoLocator(tab.page, locator, secret.value, { replace: true });
          response.addCode(`${source}.fill(${secret.code});`);
        } else if (field.type === 'checkbox' || field.type === 'radio') {
          const want = field.value === 'true';
          let current = null;
          try {
            current = await locator.isChecked();
          } catch {
            current = null;
          }
          if (current !== want) await human.clickLocator(tab.page, locator);
          response.addCode(`${source}.setChecked(${want});`);
        } else if (field.type === 'combobox') {
          await human.hoverLocator(tab.page, locator);
          await locator.selectOption({ label: field.value }, tab.actionTimeoutOptions);
          response.addCode(`${source}.selectOption(${JSON.stringify(field.value)});`);
        }
      }
    },
    browser_select_option: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_select_option', response);
      if (!tab) return;
      response.setIncludeSnapshot();
      const { locator, resolved } = await tab.refLocator(params);
      response.addCode(`await page.${resolved}.selectOption(${JSON.stringify(params.values)});`);
      await tab.waitForCompletion(async () => {
        await human.hoverLocator(tab.page, locator);
        await locator.selectOption(params.values, tab.actionTimeoutOptions);
      });
    },
    browser_check: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_check', response);
      if (!tab) return;
      const { locator, resolved } = await tab.refLocator(params);
      response.addCode(`await page.${resolved}.check();`);
      let current = null;
      try {
        current = await locator.isChecked();
      } catch {
        current = null;
      }
      if (current !== true) await human.clickLocator(tab.page, locator);
    },
    browser_uncheck: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_uncheck', response);
      if (!tab) return;
      const { locator, resolved } = await tab.refLocator(params);
      response.addCode(`await page.${resolved}.uncheck();`);
      let current = null;
      try {
        current = await locator.isChecked();
      } catch {
        current = null;
      }
      if (current !== false) await human.clickLocator(tab.page, locator);
    },
    browser_drag: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_drag', response);
      if (!tab) return;
      response.setIncludeSnapshot();
      const [start, end] = await tab.refLocators([
        { ref: params.startRef, selector: params.startSelector, element: params.startElement },
        { ref: params.endRef, selector: params.endSelector, element: params.endElement },
      ]);
      response.addCode(`await page.${start.resolved}.dragTo(page.${end.resolved});`);
      await tab.waitForCompletion(async () => {
        await human.dragLocators(tab.page, start.locator, end.locator);
      });
    },
    browser_press_key: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_press_key', response);
      if (!tab) return;
      response.addCode(`await page.keyboard.press('${params.key}');`);
      if (params.key === 'Enter') {
        response.setIncludeSnapshot();
        await tab.waitForCompletion(async () => {
          await human.pressKey(tab.page, 'Enter');
        });
      } else {
        await human.pressKey(tab.page, params.key);
      }
    },
    browser_press_sequentially: async (context, params, response) => {
      const tab = await guardTab(context, 'browser_press_sequentially', response);
      if (!tab) return;
      response.addCode(`await page.keyboard.type('${params.text}');`);
      await human.typeText(tab.page, params.text);
      if (params.submit) {
        response.setIncludeSnapshot();
        await tab.waitForCompletion(async () => {
          await human.pressKey(tab.page, 'Enter');
        });
      }
    },
  };
}

function wrapHumanizedTools(tools, human) {
  const handlers = makeHandlers(human);
  for (const tool of tools) {
    const name = tool.schema && tool.schema.name;
    if (name && handlers[name]) tool.handle = handlers[name];
  }
  return tools;
}

module.exports = { wrapHumanizedTools, makeHandlers, INPUT_TOOL_NAMES };
