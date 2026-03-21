#!/usr/bin/env node
/**
 * Playwright MCP with tabId isolation.
 * Fork of @playwright/mcp that adds an optional `tabId` parameter to every tool,
 * allowing multiple agents to work on separate tabs in the same browser.
 */

const { program } = require('playwright-core/lib/utilsBundle');
const { resolveCLIConfig, commaSeparatedList, semicolonSeparatedList, numberParser, enumParser, resolutionParser, headerParser, dotenvFileLoader } = require('playwright-core/lib/tools/mcp/config');
const { setupExitWatchdog } = require('playwright-core/lib/tools/mcp/watchdog');
const { createBrowser } = require('playwright-core/lib/tools/mcp/browserFactory');
const { BrowserBackend } = require('playwright-core/lib/tools/backend/browserBackend');
const { filteredTools } = require('playwright-core/lib/tools/backend/tools');
const mcpServer = require('playwright-core/lib/tools/utils/mcp/server');
const { z: zod } = require('playwright-core/lib/mcpBundle');
const { ProgramOption } = require('playwright-core/lib/utilsBundle');

const version = require('./package.json').version;

if (process.argv.includes('install-browser')) {
  const argv = process.argv.map(arg => arg === 'install-browser' ? 'install' : arg);
  const { program: mainProgram } = require('playwright-core/lib/cli/program');
  mainProgram.parse(argv);
  return;
}

// --- Tab ID management ---
class TabIdRouter {
  constructor() {
    this._tabIdToIndex = new Map(); // tabId -> tab index
    this._mutex = Promise.resolve();
  }

  // Serialize all operations to prevent race conditions
  async run(fn) {
    const prev = this._mutex;
    let resolve;
    this._mutex = new Promise(r => resolve = r);
    try {
      await prev;
      return await fn();
    } finally {
      resolve();
    }
  }

  async ensureTab(context, tabId) {
    if (!tabId) return; // no tabId = use current tab (backward compatible)

    if (!this._tabIdToIndex.has(tabId)) {
      // Create a new tab and record its index
      await context.newTab();
      const index = context.tabs().length - 1;
      this._tabIdToIndex.set(tabId, index);
      return;
    }

    // Rebuild index mapping in case tabs were closed
    const storedIndex = this._tabIdToIndex.get(tabId);
    if (storedIndex < context.tabs().length) {
      await context.selectTab(storedIndex);
    } else {
      // Tab was closed, create a new one
      await context.newTab();
      const index = context.tabs().length - 1;
      this._tabIdToIndex.set(tabId, index);
    }
  }

  removeTab(tabId) {
    if (!tabId) return;
    this._tabIdToIndex.delete(tabId);
    // Rebuild indices: shift down any tabs after the removed one
    const entries = [...this._tabIdToIndex.entries()].sort((a, b) => a[1] - b[1]);
    this._tabIdToIndex.clear();
    entries.forEach(([id, idx], i) => this._tabIdToIndex.set(id, i));
  }
}

// Add tabId to every tool schema
function addTabIdToSchemas(toolSchemas) {
  return toolSchemas.map(schema => {
    const modified = { ...schema };
    // Clone inputSchema and add tabId
    const original = modified.inputSchema;
    modified.inputSchema = {
      ...original,
      // Wrap the parse function to strip tabId before validation
      parse: (args) => {
        const { tabId, ...rest } = args || {};
        return original.parse(rest);
      },
      // Expose the raw shape for MCP tool listing
      _def: original._def,
    };

    // For the MCP tool listing, we need to add tabId to the JSON schema
    // The toMcpTool function in playwright-core converts zod schemas to JSON
    // We'll patch the schema's shape to include tabId
    if (original.shape) {
      const newShape = { ...original.shape };
      newShape.tabId = zod.string().optional().describe(
        'Tab identifier for isolation. Each unique tabId gets its own browser tab. Omit for default tab.'
      );
      modified.inputSchema = zod.object(newShape);
      // Preserve the original parse to strip tabId
      const newParse = modified.inputSchema.parse.bind(modified.inputSchema);
      modified.inputSchema.parse = (args) => {
        const { tabId, ...rest } = args || {};
        return newParse(rest);
      };
      // Actually we need to parse WITH tabId since zod will validate
      modified.inputSchema = zod.object(newShape);
    }

    return modified;
  });
}

// --- Main ---
const p = program.version('Version ' + version).name('Playwright Multiple');

// Copy all options from the original decorateMCPCommand
p.option("--allowed-hosts <hosts...>", "comma-separated list of hosts", commaSeparatedList)
  .option("--allowed-origins <origins>", "semicolon-separated list of TRUSTED origins", semicolonSeparatedList)
  .option("--allow-unrestricted-file-access", "allow access to files outside of workspace roots")
  .option("--blocked-origins <origins>", "semicolon-separated list of origins to block", semicolonSeparatedList)
  .option("--block-service-workers", "block service workers")
  .option("--browser <browser>", "browser or chrome channel to use")
  .option("--caps <caps>", "comma-separated capabilities: vision, pdf, devtools", commaSeparatedList)
  .option("--cdp-endpoint <endpoint>", "CDP endpoint to connect to")
  .option("--cdp-header <headers...>", "CDP headers", headerParser)
  .option("--cdp-timeout <timeout>", "CDP connect timeout in ms", numberParser)
  .option("--codegen <lang>", "code generation language", enumParser.bind(null, "--codegen", ["none", "typescript"]))
  .option("--config <path>", "path to configuration file")
  .option("--console-level <level>", "console message level", enumParser.bind(null, "--console-level", ["error", "warning", "info", "debug"]))
  .option("--device <device>", "device to emulate")
  .option("--executable-path <path>", "path to browser executable")
  .option("--extension", "connect to running browser via extension")
  .option("--grant-permissions <permissions...>", "permissions to grant", commaSeparatedList)
  .option("--headless", "run browser in headless mode")
  .option("--host <host>", "host to bind to")
  .option("--ignore-https-errors", "ignore https errors")
  .option("--init-page <path...>", "TypeScript file to evaluate on page")
  .option("--init-script <path...>", "JavaScript init script")
  .option("--isolated", "keep browser profile in memory")
  .option("--image-responses <mode>", "image response mode", enumParser.bind(null, "--image-responses", ["allow", "omit"]))
  .option("--no-sandbox", "disable sandbox")
  .option("--output-dir <path>", "output directory")
  .option("--output-mode <mode>", "output mode", enumParser.bind(null, "--output-mode", ["file", "stdout"]))
  .option("--port <port>", "port for SSE transport")
  .option("--proxy-bypass <bypass>", "proxy bypass domains")
  .option("--proxy-server <proxy>", "proxy server")
  .option("--sandbox", "enable sandbox")
  .option("--save-session", "save session to output directory")
  .option("--secrets <path>", "path to secrets file", dotenvFileLoader)
  .option("--shared-browser-context", "reuse browser context between HTTP clients")
  .option("--snapshot-mode <mode>", "snapshot mode", enumParser.bind(null, "--snapshot-mode", ["incremental", "full", "none"]))
  .option("--storage-state <path>", "storage state file path")
  .option("--test-id-attribute <attribute>", "test id attribute")
  .option("--timeout-action <timeout>", "action timeout in ms", numberParser)
  .option("--timeout-navigation <timeout>", "navigation timeout in ms", numberParser)
  .option("--user-agent <ua string>", "user agent string")
  .option("--user-data-dir <path>", "user data directory")
  .option("--viewport-size <size>", "viewport size", resolutionParser.bind(null, "--viewport-size"))
  .addOption(new ProgramOption("--vision", "Legacy, use --caps=vision").hideHelp())
  .action(async (options) => {
    options.sandbox = options.sandbox === true ? undefined : false;
    setupExitWatchdog();

    if (options.vision) {
      console.error("The --vision option is deprecated, use --caps=vision instead");
      options.caps = "vision";
    }
    if (options.caps?.includes("tracing"))
      options.caps.push("devtools");

    const config = await resolveCLIConfig(options);
    const tools = filteredTools(config);
    const modifiedTools = addTabIdToSchemas(tools);
    const router = new TabIdRouter();

    const useSharedBrowser = config.sharedBrowserContext || config.browser.isolated;
    let sharedBrowser;
    let clientCount = 0;

    const factory = {
      name: 'Playwright Multiple',
      nameInConfig: 'playwright-multiple',
      version,
      toolSchemas: modifiedTools.map(tool => tool.schema),
      create: async (clientInfo) => {
        if (useSharedBrowser && clientCount === 0)
          sharedBrowser = await createBrowser(config, clientInfo);
        clientCount++;
        const browser = sharedBrowser || await createBrowser(config, clientInfo);
        const browserContext = config.browser.isolated
          ? await browser.newContext(config.browser.contextOptions)
          : browser.contexts()[0];

        const backend = new BrowserBackend(config, browserContext, modifiedTools);

        // Wrap callTool to add tabId routing
        const originalCallTool = backend.callTool.bind(backend);
        backend.callTool = async (name, rawArgs, progress) => {
          const { tabId, ...args } = rawArgs || {};

          return router.run(async () => {
            // Initialize context if needed (first call triggers it)
            if (backend._context) {
              await router.ensureTab(backend._context, tabId);
            }

            // Call the original tool
            const result = await originalCallTool(name, args, progress);
            return result;
          });
        };

        return backend;
      },
      disposed: async (backend) => {
        clientCount--;
        if (sharedBrowser && clientCount > 0)
          return;
        sharedBrowser = undefined;
        const browserContext = backend.browserContext;
        await browserContext.close().catch(() => {});
        await browserContext.browser()?.close().catch(() => {});
      }
    };

    await mcpServer.start(factory, config.server);
  });

void program.parseAsync(process.argv);
