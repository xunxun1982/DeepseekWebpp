const HOST_NAME = 'com.deepseekwebpp.native_host';
const MUTATING_FILE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'remove_path',
  'make_dir',
  'multi_file_edit',
  'delete_file',
  'move_file',
  'copy_file',
]);
const SAFE_AUTO_TOOLS = new Set([
  'weather',
  'world_time',
  'disk_info',
  'directory_info',
  'web_search',
]);
const NETWORK_TIMEOUT_TOOLS = new Set(['web_search', 'web_fetch']);
const SERIAL_TOOL_CALL_TOOLS = new Set(['run_program']);
const DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 180000;
const DEFAULT_NETWORK_TOOL_TIMEOUT_MS = 600000;
const DEFAULT_TOOL_CALL_PARALLEL_LIMIT = 5;
const PATH_SCOPED_TOOLS = new Set([
  'list_files',
  'directory_info',
  'read_file',
  'glob_search',
  'grep_search',
  'file_exists',
]);
const DEFAULT_WEB_SEARCH_SETTINGS = {
  provider: 'duckduckgo',
  mcp: {
    mcpServers: {
      'grok-search-rs': {
        command: 'grok-search-rs',
        args: [],
        env: {
          GROK_SEARCH_API_KEY: 'sk-123456789',
          GROK_SEARCH_URL: 'http://172.28.100.252:28335',
          GROK_SEARCH_MODEL: 'grok-4.20-fast',
          TAVILY_API_KEY: 'tvly-dev-123456789',
          TAVILY_API_URL: 'https://api.tavily.com',
          FIRECRAWL_API_KEY: 'fc-123456789',
        },
      },
    },
  },
};
const pendingRequests = new Map();
let serialToolCallQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'tool.call') {
    handleToolCall(message.call, sender.tab && sender.tab.id)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message && message.type === 'tool.batch.call') {
    handleToolBatch(message.calls, sender.tab && sender.tab.id, message.parallelLimit)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message && message.type === 'options.open') {
    if (message.section) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${encodeURIComponent(message.section)}`) }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true });
      });
      return true;
    }
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message && message.type === 'webSearch.test') {
    handleWebSearchTest({ settings: message.settings })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message && message.type === 'confirm.result') {
    handleConfirmResult(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message && message.type === 'pending.get') {
    sendResponse(pendingRequests.get(message.id) || null);
    return false;
  }

  return false;
});

async function handleWebSearchTest({ settings }) {
  const call = {
    tool: 'web_search',
    args: mergeWebSearchSettings(normalizeWebSearchSettings(settings), {
      query: 'DeepseekWeb++ MCP test',
      limit: 1,
    }),
  };
  const result = await callNativeTool(call, await getToolTimeoutMs(call));
  return { ok: result && result.ok !== false, result, error: result && result.error };
}

async function handleToolCall(call, tabId) {
  call = await prepareToolCall(call);
  if (await getAutoAllowAllTools()) {
    await notifyToolRunning(call, tabId);
    const result = await callNativeTool(call, await getToolTimeoutMs(call));
    return deliverToolResultToTab(call, result, tabId);
  }
  if (SAFE_AUTO_TOOLS.has(call.tool)) {
    await notifyToolRunning(call, tabId);
    const result = await callNativeTool(call, await getToolTimeoutMs(call));
    return deliverToolResultToTab(call, result, tabId);
  }
  const rules = await getRules();
  if (rules.some((rule) => ruleMatchesRequest(rule, call))) {
    await notifyToolRunning(call, tabId);
    const result = await callNativeTool(call, await getToolTimeoutMs(call));
    return deliverToolResultToTab(call, result, tabId);
  }
  if (!tabId) {
    return { ok: false, error: '无法定位发起工具调用的 DeepSeek 标签页' };
  }

  const id = crypto.randomUUID();
  pendingRequests.set(id, { id, call, tabId, createdAt: Date.now() });
  await chrome.tabs.sendMessage(tabId, { type: 'confirm.show', id, call });
  return { ok: false, pending: true, message: '等待用户在当前页面确认工具调用' };
}

async function handleToolBatch(calls, tabId, parallelLimit) {
  const preparedCalls = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    preparedCalls.push(await prepareToolCall(call));
  }
  if (!preparedCalls.length) {
    return { ok: true, started: true, count: 0 };
  }
  if (!tabId) {
    return { ok: false, error: '无法定位发起工具调用的 DeepSeek 标签页' };
  }

  if (await getAutoAllowAllTools()) {
    executeToolCallBatch(preparedCalls, tabId, parallelLimit).catch(() => {});
    return { ok: true, started: true, count: preparedCalls.length };
  }

  const rules = await getRules();
  const autoCalls = [];
  const confirmCalls = [];
  for (const call of preparedCalls) {
    if (SAFE_AUTO_TOOLS.has(call.tool) || rules.some((rule) => ruleMatchesRequest(rule, call))) {
      autoCalls.push(call);
    } else {
      confirmCalls.push(call);
    }
  }

  if (!confirmCalls.length) {
    executeToolCallBatch(autoCalls, tabId, parallelLimit).catch(() => {});
    return { ok: true, started: true, count: preparedCalls.length };
  }

  const id = crypto.randomUUID();
  pendingRequests.set(id, {
    id,
    calls: confirmCalls,
    executeCalls: preparedCalls,
    tabId,
    parallelLimit,
    createdAt: Date.now(),
  });
  await chrome.tabs.sendMessage(tabId, { type: 'confirm.show', id, calls: confirmCalls });
  return { ok: false, pending: true, count: confirmCalls.length, message: '等待用户在当前页面确认工具调用' };
}

async function prepareToolCall(call) {
  if (call.tool === 'web_search') {
    const settings = await getWebSearchSettings();
    return { ...call, args: mergeWebSearchSettings(settings, call.args || {}) };
  }
  return call;
}

async function handleConfirmResult(message) {
  const pending = pendingRequests.get(message.id);
  if (!pending) {
    return { ok: false, error: '确认请求已失效' };
  }
  pendingRequests.delete(message.id);
  const calls = Array.isArray(pending.calls) ? pending.calls : [pending.call].filter(Boolean);
  const executeCalls = Array.isArray(pending.executeCalls) ? pending.executeCalls : calls;

  if (message.decision === 'allow_scope') {
    const rules = await getRules();
    for (const call of calls) {
      rules.push(createRuleFromCall(call, message.scopeMode));
    }
    await chrome.storage.local.set({ rules });
  }

  if (message.decision === 'allow_once' || message.decision === 'allow_scope') {
    executeToolCallBatch(executeCalls, pending.tabId, pending.parallelLimit).catch(() => {});
    return { ok: true, started: true, count: executeCalls.length };
  }

  if (pending.tabId) {
    const rejectedCalls = Array.isArray(pending.executeCalls) ? pending.executeCalls : calls;
    for (const call of rejectedCalls) {
      await chrome.tabs.sendMessage(pending.tabId, {
        type: 'tool.result',
        call,
        result: { ok: false, error: '用户拒绝工具调用' },
      });
    }
  }
  return { ok: false, error: '用户拒绝工具调用' };
}

async function executeToolCallBatch(calls, tabId, parallelLimit) {
  const queue = (Array.isArray(calls) ? calls : []).slice();
  const total = queue.length;
  const runningCalls = [];
  const maxParallel = normalizeToolCallParallelLimit(parallelLimit);
  let running = 0;
  let completed = 0;

  return new Promise((resolve) => {
    if (!total) {
      resolve({ ok: true, count: 0 });
      return;
    }
    const launchNext = () => {
      while (running < maxParallel && queue.length) {
        const nextIndex = queue.findIndex((call) => canLaunchBatchToolCall(call, runningCalls));
        if (nextIndex === -1) {
          return;
        }
        const [call] = queue.splice(nextIndex, 1);
        running += 1;
        runningCalls.push(call);
        runBatchToolCall(call, tabId)
          .finally(() => {
            removeRunningBatchToolCall(runningCalls, call);
            running = Math.max(0, running - 1);
            completed += 1;
            if (completed >= total) {
              resolve({ ok: true, count: completed });
              return;
            }
            launchNext();
          });
      }
    };
    launchNext();
  });
}

async function runBatchToolCall(call, tabId) {
  if (SERIAL_TOOL_CALL_TOOLS.has(call.tool)) {
    return runSerialBatchToolCall(call, tabId);
  }
  return runSingleBatchToolCall(call, tabId);
}

async function runSerialBatchToolCall(call, tabId) {
  const previous = serialToolCallQueue;
  let release;
  serialToolCallQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await runSingleBatchToolCall(call, tabId);
  } finally {
    release();
  }
}

async function runSingleBatchToolCall(call, tabId) {
  await notifyToolRunning(call, tabId);
  let result;
  try {
    result = await callNativeTool(call, await getToolTimeoutMs(call));
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  await deliverToolResultToTab(call, result, tabId);
}

function canLaunchBatchToolCall(call, runningCalls) {
  if (!call) {
    return false;
  }
  if (SERIAL_TOOL_CALL_TOOLS.has(call.tool)) {
    return !hasRunningSerialToolCall(runningCalls);
  }
  return true;
}

function hasRunningSerialToolCall(runningCalls) {
  return runningCalls.some((call) => SERIAL_TOOL_CALL_TOOLS.has(call.tool));
}

function removeRunningBatchToolCall(runningCalls, call) {
  const index = runningCalls.indexOf(call);
  if (index !== -1) {
    runningCalls.splice(index, 1);
  }
}

function normalizeToolCallParallelLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_TOOL_CALL_PARALLEL_LIMIT;
  }
  return Math.max(1, Math.min(Math.round(number), DEFAULT_TOOL_CALL_PARALLEL_LIMIT));
}

async function notifyToolRunning(call, tabId) {
  if (!tabId) {
    return;
  }
  await chrome.tabs.sendMessage(tabId, {
    type: 'tool.running',
    call,
  }).catch(() => {});
}

async function deliverToolResultToTab(call, result, tabId) {
  if (!tabId) {
    return result;
  }

  await focusOriginalTab(tabId);
  await chrome.tabs.sendMessage(tabId, {
    type: 'tool.result',
    call,
    result,
  });
  return result;
}

async function focusOriginalTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    return;
  }
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}

function callNativeTool(call, timeoutMs = DEFAULT_NATIVE_TOOL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      finish({ ok: false, error: `工具执行超时（${Math.round(timeoutMs / 1000)} 秒）：${call.tool}` });
    }, timeoutMs);
    chrome.runtime.sendNativeMessage(
      HOST_NAME,
      { id: crypto.randomUUID(), type: 'tool.call', tool: call.tool, args: call.args || {} },
      (response) => {
        if (finished) {
          return;
        }
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        finish(response || { ok: false, error: 'Native Host 没有返回结果' });
      },
    );
  });
}

async function getRules() {
  const data = await chrome.storage.local.get({ rules: [] });
  return Array.isArray(data.rules) ? data.rules : [];
}

async function getAutoAllowAllTools() {
  const data = await chrome.storage.local.get({ autoAllowAllTools: false });
  return data.autoAllowAllTools === true;
}

async function getToolTimeoutMs(call) {
  if (NETWORK_TIMEOUT_TOOLS.has(call && call.tool)) {
    return getNetworkToolTimeoutMs();
  }
  return DEFAULT_NATIVE_TOOL_TIMEOUT_MS;
}

async function getNetworkToolTimeoutMs() {
  const data = await chrome.storage.local.get({ networkToolTimeoutMs: DEFAULT_NETWORK_TOOL_TIMEOUT_MS });
  return normalizeNetworkToolTimeout(data.networkToolTimeoutMs);
}

function normalizeNetworkToolTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_NETWORK_TOOL_TIMEOUT_MS;
  }
  return Math.max(10000, Math.min(Math.round(number), 10 * 60 * 1000));
}

async function getWebSearchSettings() {
  const data = await chrome.storage.local.get({ webSearchSettings: DEFAULT_WEB_SEARCH_SETTINGS });
  return { ...DEFAULT_WEB_SEARCH_SETTINGS, ...(data.webSearchSettings || {}) };
}

function mergeWebSearchSettings(settings, args) {
  const provider = normalizeWebSearchProvider(args.provider || settings.provider || DEFAULT_WEB_SEARCH_SETTINGS.provider);
  const merged = {
    provider: settings.provider,
    mcp: settings.mcp,
    ...args,
    provider,
  };
  if (provider === 'bing' || provider === 'duckduckgo') {
    merged.searchUrl = defaultSearchUrl(provider);
    delete merged.mcp;
  }
  if (provider === 'mcp') {
    merged.mcp = { ...(settings.mcp || {}), ...(args.mcp || {}) };
    delete merged.searchUrl;
  }
  return merged;
}

function normalizeWebSearchProvider(provider) {
  return ['bing', 'duckduckgo', 'mcp'].includes(provider) ? provider : DEFAULT_WEB_SEARCH_SETTINGS.provider;
}

function normalizeWebSearchSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    provider: normalizeWebSearchProvider(source.provider),
    mcp: { ...DEFAULT_WEB_SEARCH_SETTINGS.mcp, ...(source.mcp || {}) },
  };
}

function defaultSearchUrl(provider) {
  if (provider === 'duckduckgo') {
    return 'https://html.duckduckgo.com/html/?q={query}';
  }
  return 'https://www.bing.com/search?q={query}';
}

function createRuleFromCall(call, scopeMode) {
  if (scopeMode === 'any') {
    return { id: crypto.randomUUID(), tool: call.tool, scope: { mode: 'any' } };
  }
  if (PATH_SCOPED_TOOLS.has(call.tool)) {
    return {
      id: crypto.randomUUID(),
      tool: call.tool,
      scope: { mode: 'path', path: call.args && (call.args.path || call.args.root) },
    };
  }
  if (call.tool === 'run_program') {
    return {
      id: crypto.randomUUID(),
      tool: call.tool,
      scope: { mode: 'program', executable: call.args && call.args.executable },
    };
  }
  return { id: crypto.randomUUID(), tool: call.tool, scope: { mode: 'any' } };
}

function ruleMatchesRequest(rule, request) {
  if (!rule || !request || rule.tool !== request.tool) {
    return false;
  }
  if (MUTATING_FILE_TOOLS.has(request.tool)) {
    return false;
  }
  const scope = rule.scope || {};
  if (scope.mode === 'any') {
    return true;
  }
  if (PATH_SCOPED_TOOLS.has(request.tool) && scope.mode === 'path') {
    return isPathInside(scope.path, request.args && (request.args.path || request.args.root));
  }
  if (request.tool === 'run_program' && scope.mode === 'program') {
    return normalizePath(scope.executable) === normalizePath(request.args && request.args.executable);
  }
  return false;
}

function isPathInside(basePath, candidatePath) {
  const base = normalizePath(basePath);
  const candidate = normalizePath(candidatePath);
  return candidate === base || candidate.startsWith(`${base}\\`);
}

function normalizePath(value) {
  return String(value || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}
