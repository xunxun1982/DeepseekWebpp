const TOOL_PROMPT = `可调用工具：
文件系统只读工具：
- list_files: 列出指定目录的文件和子目录。参数：{"path":"目录路径"}
- directory_info: 快速递归统计目录总大小、文件数和子目录数，只返回汇总信息，不返回文件列表。参数：{"path":"目录路径"}
- read_file: 读取文本文件，可指定行范围。参数：{"path":"文件路径","startLine":1,"endLine":100}
- glob_search: 按通配符查找文件。参数：{"root":"目录路径","pattern":"**/*.js"}
- grep_search: 在文件内容中搜索文本或正则。参数：{"root":"目录路径","pattern":"关键词或正则","glob":"**/*.*"}
- file_exists: 检查文件或目录是否存在。参数：{"path":"路径"}

文件系统变更工具（必须弹出确认）：
- write_file: 创建或覆盖文本文件。参数：{"path":"文件路径","content":"内容"}
- edit_file: 精确查找替换。参数：{"path":"文件路径","search":"原文","replace":"新文"}
- remove_path: 删除文件或目录。参数：{"path":"路径","recursive":true,"force":false}
- make_dir: 创建目录。参数：{"path":"目录路径"}
- multi_file_edit: 批量编辑多个文件。参数：{"edits":[{"path":"文件路径","search":"原文","replace":"新文"}]}

系统与网络工具：
- disk_info: 查询本机硬盘容量、已用空间和可用空间。参数：{}
- run_program: 运行本机可执行程序。参数：{"executable":"程序名、命令名、软件别名或完整路径","args":["参数"],"timeoutMs":30000,"wait":false}。任意语言表达打开、启动或运行本机软件时，直接调用本工具；executable 使用用户提到的软件名、命令名或完整路径，不要求先询问路径。Host 会按 PATH、注册表 App Paths 和常见安装位置解析程序。
- web_fetch: 抓取指定 URL 文本。参数：{"url":"https://example.com","maxChars":12000}
- web_search: 联网搜索。参数：{"query":"搜索词","limit":20}。默认使用 DuckDuckGo；也可在设置页切换 Bing 或本地 MCP。
- weather: 查询当前天气。默认查询当地；也可指定地点。参数：{} 或 {"location":"New York"}。地点参数请先自行归一化为城市级英文名或 IANA 时区；用户说区县、城区、街道、景点等细粒度地点时，传入其所属城市，不要把区县和城市拼在一起。
- world_time: 查询各地时间，默认北京时间。参数：{} 或 {"location":"New York"}。地点参数请先自行归一化为城市级英文名或 IANA 时区；用户说区县、城区、街道、景点等细粒度地点时，传入其所属城市，不要把区县和城市拼在一起。

不要向用户请求权限或确认；需要工具时直接输出 tool_call JSON，扩展会负责权限确认和白名单。
每次回复最多输出 5 个 tool_call。多个独立需求可以连续输出多个 JSON 对象，也可以输出 {"tool_calls":[...]} 数组；例如“打开计算器和画图”应同时输出 calc 与 mspaint 两个 run_program 调用，“现在几点，我这里天气如何”应同时输出 world_time {} 与 weather {}。
收到工具结果后必须基于结果直接总结回答，不要连续换关键词重复搜索。
如果原始用户任务明确要求根据工具结果继续修改/写入/删除文件或运行验证命令，请继续只输出下一步 tool_call JSON，不要用自然语言假装已经执行。
运行验证命令时使用 run_program wait:true；验证结果会返回 exitCode、stdout、stderr、timedOut 或 error，无论成功还是失败都必须基于这些字段判断并回复，必要时再输出下一步 tool_call JSON。
web_search 返回结果后优先直接回答；结果通常包含标题、摘要、时间和 URL。除非用户明确要求阅读某个链接，或搜索结果摘要明显不足，否则不要自动循环调用 web_fetch。
需要工具时，只输出 JSON，不要添加其他内容：
严禁输出 <tool_calls>、<tool_call>、XML 标签、Markdown 表格或自然语言说明；工具调用的唯一主格式是下面的 JSON：
\`\`\`json
{"tool_call":{"tool":"list_files","args":{"path":"C:\\\\Users"}}}
{"tool_call":{"tool":"directory_info","args":{"path":"F:\\\\MyProjects"}}}
{"tool_call":{"tool":"disk_info","args":{}}}
{"tool_call":{"tool":"run_program","args":{"executable":"用户要打开的软件名","args":[],"timeoutMs":30000,"wait":false}}}
{"tool_call":{"tool":"weather","args":{}}}
{"tool_call":{"tool":"world_time","args":{"location":"New York"}}}
{"tool_calls":[{"tool":"world_time","args":{}},{"tool":"weather","args":{}}]}
\`\`\``;

const processedToolCalls = new Set();
const MAX_PROCESSED_TOOL_CALLS = 200;
const SCAN_DEBOUNCE_MS = 500;
const SCAN_FALLBACK_INTERVAL_MS = 5000;
const DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS = 30000;
const DEFAULT_NETWORK_TOOL_TIMEOUT_MS = 600000;
const DEFAULT_TOOL_CALL_BATCH_LIMIT = 5;
const DEFAULT_TOOL_CALL_PARALLEL_LIMIT = 5;
const TOOL_RESULT_ANSWER_SUPPRESS_MS = 120000;
const TOOL_CALL_REQUEST_WINDOW_MS = 120000;
const NETWORK_TIMEOUT_TOOLS = new Set(['web_search', 'web_fetch']);
const TOOL_RESULT_CONTINUATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'remove_path',
  'make_dir',
  'multi_file_edit',
  'run_program',
]);
const ignoredToolCallNodes = new WeakSet();
let toolsEnabled = false;
let pendingToolResults = 0;
let lastToolName = '无';
let scanTimer = null;
let pendingToolCallRequest = false;
let toolCallRequestTimer = null;
let toolStateVersion = 0;
let toolResultContinueTimer = null;
let toolResultContinueTimeoutMs = DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS;
let networkToolTimeoutMs = DEFAULT_NETWORK_TOOL_TIMEOUT_MS;
let toolCallBatchLimit = DEFAULT_TOOL_CALL_BATCH_LIMIT;
let toolCallParallelLimit = DEFAULT_TOOL_CALL_PARALLEL_LIMIT;
let activeToolResultBatch = null;
let toolResultContinueRequested = false;
let suppressToolCallsUntilUserTurn = false;
let suppressToolCallsTimer = null;
let programmaticComposerInput = false;

injectPageBridge();
createPanel();
configurePageBridge(false);
restoreToolsEnabledState();
restoreToolResultSettings();
restoreNetworkToolSettings();
restoreToolCallBatchSettings();
restoreToolCallParallelSettings();
listenForToolResultSettings();
listenForNetworkToolSettings();
listenForToolCallBatchSettings();
listenForToolCallParallelSettings();
listenForComposerUserInput();
startToolCallScanner();

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'tool.running') {
    setStatus(getToolRunningStatus(message.call));
  }
  if (message && message.type === 'tool.result') {
    if (!toolsEnabled) {
      setStatus('工具已禁用，忽略工具结果');
      return;
    }
    if (!shouldContinueWithToolResult(message.call, message.result)) {
      lastToolName = message.call && message.call.tool ? message.call.tool : lastToolName;
      updatePanelStats();
      setStatus(getDirectToolResultStatus(message.call, message.result));
      if (noteToolResultForBatch(message.call)) {
        maybeContinueWithCompletedToolBatch();
      }
      return;
    }
    queueToolResultForBridge(message.call, message.result);
    if (!noteToolResultForBatch(message.call)) {
      continueWithToolResult();
      return;
    }
    maybeContinueWithCompletedToolBatch();
  }
  if (message && message.type === 'confirm.show') {
    showConfirmOverlay(message.id, message.calls || message.call);
  }
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message && message.source === 'DeepseekWebpp' && message.type === 'DSWEBPP_REQUEST_CONFIG') {
    configurePageBridge(toolsEnabled);
  }
  if (message && message.source === 'DeepseekWebpp' && message.type === 'DSWEBPP_USER_REQUEST_SENT') {
    startToolCallRequestGate();
  }
});

function injectPageBridge() {
  if (document.getElementById('deepseekwebpp-page-injector')) {
    return;
  }
  const script = document.createElement('script');
  script.id = 'deepseekwebpp-page-injector';
  script.src = chrome.runtime.getURL('page-injector.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function configurePageBridge(enabled) {
  window.postMessage(
    {
      source: 'DeepseekWebpp',
      type: 'DSWEBPP_CONFIG',
      enabled,
      prompt: TOOL_PROMPT,
    },
    '*',
  );
}

function appendElement(parent, tagName, options = {}, children = []) {
  const element = document.createElement(tagName);
  if (options.id) {
    element.id = options.id;
  }
  if (options.className) {
    element.className = options.className;
  }
  if (options.text !== undefined) {
    element.textContent = options.text;
  }
  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) {
      element.setAttribute(name, value);
    }
  }
  for (const child of children) {
    element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  parent.appendChild(element);
  return element;
}

function createPanel() {
  if (document.getElementById('deepseekwebpp-panel')) {
    return;
  }
  const panel = document.createElement('div');
  panel.id = 'deepseekwebpp-panel';

  const title = appendElement(panel, 'div', { className: 'deepseekwebpp-title' });
  const titleText = appendElement(title, 'div');
  appendElement(titleText, 'div', { className: 'deepseekwebpp-brand', text: 'DeepseekWeb++' });
  appendElement(titleText, 'div', { className: 'deepseekwebpp-caption', text: 'DeepSeek 本地工具' });
  appendElement(title, 'span', { className: 'deepseekwebpp-drag-hint', text: '拖动' });

  const stats = appendElement(panel, 'div', { className: 'deepseekwebpp-console-grid' });
  const stateStat = appendElement(stats, 'div', { className: 'deepseekwebpp-stat' });
  appendElement(stateStat, 'span', { text: '状态' });
  appendElement(stateStat, 'strong', { id: 'deepseekwebpp-state', text: '未启动' });
  const toolStat = appendElement(stats, 'div', { className: 'deepseekwebpp-stat' });
  appendElement(toolStat, 'span', { text: '最近工具' });
  appendElement(toolStat, 'strong', { id: 'deepseekwebpp-last-tool', text: '无' });
  const pendingStat = appendElement(stats, 'div', { className: 'deepseekwebpp-stat' });
  appendElement(pendingStat, 'span', { text: '待注入' });
  appendElement(pendingStat, 'strong', { id: 'deepseekwebpp-pending-count', text: '0' });

  const actions = appendElement(panel, 'div', { className: 'deepseekwebpp-actions' });
  const toggleButton = appendElement(actions, 'button', {
    id: 'deepseekwebpp-toggle',
    className: 'disabled',
    text: '启动工具',
    attributes: { type: 'button' },
  });
  const optionsButton = appendElement(actions, 'button', {
    id: 'deepseekwebpp-options',
    text: '设置',
    attributes: { type: 'button' },
  });
  const whitelistButton = appendElement(actions, 'button', {
    id: 'deepseekwebpp-whitelist',
    text: '白名单',
    attributes: { type: 'button' },
  });
  appendElement(panel, 'div', { id: 'deepseekwebpp-status', text: '工具未启动' });
  document.documentElement.appendChild(panel);
  restorePanelPosition(panel);
  enablePanelDrag(panel);

  toggleButton.addEventListener('click', () => {
    setToolsEnabled(!toolsEnabled, { persist: true });
  });
  optionsButton.addEventListener('click', () => openOptionsPageFromPanel());
  whitelistButton.addEventListener('click', () => openOptionsPageFromPanel('whitelist'));
  updatePanelStats();
}

function openOptionsPageFromPanel(section) {
    const message = section ? { type: 'options.open', section } : { type: 'options.open' };
    chrome.runtime.sendMessage(message, (response) => {
      if (!response || !response.ok) {
        setStatus(response && response.error ? response.error : '设置页面打开失败');
      }
    });
}

function restoreToolsEnabledState() {
  chrome.storage.local.get({ toolsEnabled: false }, (data) => {
    setToolsEnabled(!!data.toolsEnabled, { persist: false });
  });
}

function restoreToolResultSettings() {
  chrome.storage.local.get({ toolResultContinueTimeoutMs: DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS }, (data) => {
    toolResultContinueTimeoutMs = normalizeToolResultContinueTimeout(data.toolResultContinueTimeoutMs);
  });
}

function restoreNetworkToolSettings() {
  chrome.storage.local.get({ networkToolTimeoutMs: DEFAULT_NETWORK_TOOL_TIMEOUT_MS }, (data) => {
    networkToolTimeoutMs = normalizeNetworkToolTimeout(data.networkToolTimeoutMs);
  });
}

function restoreToolCallBatchSettings() {
  chrome.storage.local.get({ toolCallBatchLimit: DEFAULT_TOOL_CALL_BATCH_LIMIT }, (data) => {
    toolCallBatchLimit = normalizeToolCallBatchLimit(data.toolCallBatchLimit);
  });
}

function restoreToolCallParallelSettings() {
  chrome.storage.local.get({ toolCallParallelLimit: DEFAULT_TOOL_CALL_PARALLEL_LIMIT }, (data) => {
    toolCallParallelLimit = normalizeToolCallParallelLimit(data.toolCallParallelLimit);
  });
}

function listenForToolResultSettings() {
  if (!chrome.storage.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.toolResultContinueTimeoutMs) {
      return;
    }
    toolResultContinueTimeoutMs = normalizeToolResultContinueTimeout(changes.toolResultContinueTimeoutMs.newValue);
  });
}

function listenForNetworkToolSettings() {
  if (!chrome.storage.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.networkToolTimeoutMs) {
      return;
    }
    networkToolTimeoutMs = normalizeNetworkToolTimeout(changes.networkToolTimeoutMs.newValue);
  });
}

function listenForToolCallBatchSettings() {
  if (!chrome.storage.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.toolCallBatchLimit) {
      return;
    }
    toolCallBatchLimit = normalizeToolCallBatchLimit(changes.toolCallBatchLimit.newValue);
  });
}

function listenForToolCallParallelSettings() {
  if (!chrome.storage.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.toolCallParallelLimit) {
      return;
    }
    toolCallParallelLimit = normalizeToolCallParallelLimit(changes.toolCallParallelLimit.newValue);
  });
}

function normalizeToolResultContinueTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS;
  }
  return Math.max(30000, Math.min(Math.round(number), 30 * 60 * 1000));
}

function normalizeNetworkToolTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_NETWORK_TOOL_TIMEOUT_MS;
  }
  return Math.max(10000, Math.min(Math.round(number), 10 * 60 * 1000));
}

function normalizeToolCallBatchLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_TOOL_CALL_BATCH_LIMIT;
  }
  return Math.max(1, Math.min(Math.round(number), DEFAULT_TOOL_CALL_BATCH_LIMIT));
}

function normalizeToolCallParallelLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_TOOL_CALL_PARALLEL_LIMIT;
  }
  return Math.max(1, Math.min(Math.round(number), DEFAULT_TOOL_CALL_PARALLEL_LIMIT));
}

function setToolsEnabled(enabled, options = {}) {
  toolStateVersion += 1;
  toolsEnabled = enabled;
  if (!enabled) {
    clearPendingToolResults();
    processedToolCalls.clear();
    clearToolCallRequestGate();
  }
  configurePageBridge(enabled);
  if (options.persist) {
    chrome.storage.local.set({ toolsEnabled: enabled });
  }
  const button = document.getElementById('deepseekwebpp-toggle');
  if (button) {
    button.textContent = enabled ? '禁用工具' : '启动工具';
    button.classList.toggle('enabled', enabled);
    button.classList.toggle('disabled', !enabled);
  }
  updatePanelStats();
  setStatus(enabled ? '工具已启动，请正常发送消息' : '工具已禁用');
  if (enabled) {
    scheduleToolCallScan();
  }
}

function clearPendingToolResults() {
  clearToolResultContinueTimer();
  stopSuppressingToolResultAnswerCalls();
  activeToolResultBatch = null;
  toolResultContinueRequested = false;
  pendingToolResults = 0;
  const continueButton = document.getElementById('deepseekwebpp-continue');
  if (continueButton) {
    continueButton.remove();
  }
  updatePanelStats();
  window.postMessage(
    {
      source: 'DeepseekWebpp',
      type: 'DSWEBPP_CLEAR_TOOL_RESULTS',
    },
    '*',
  );
}

function clearToolResultContinueTimer() {
  if (toolResultContinueTimer) {
    clearTimeout(toolResultContinueTimer);
    toolResultContinueTimer = null;
  }
}

function scheduleToolResultContinueExpiry() {
  clearToolResultContinueTimer();
  toolResultContinueTimer = setTimeout(() => {
    clearPendingToolResults();
    setStatus('工具结果等待发送超时，已重置');
  }, activeToolResultBatch ? activeToolResultBatch.timeoutMs : toolResultContinueTimeoutMs);
}

function startToolCallScanner() {
  const observer = new MutationObserver(scheduleToolCallScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  setInterval(scanAssistantMessages, SCAN_FALLBACK_INTERVAL_MS);
}

function listenForComposerUserInput() {
  document.addEventListener('input', handleComposerUserInput, true);
}

function handleComposerUserInput(event) {
  if (!suppressToolCallsUntilUserTurn || programmaticComposerInput) {
    return;
  }
  const input = getComposerInputFromEventTarget(event.target);
  if (!input) {
    return;
  }
  stopSuppressingToolResultAnswerCalls();
  toolResultContinueRequested = false;
}

function getComposerInputFromEventTarget(target) {
  if (!(target instanceof Element)) {
    return null;
  }
  const input = target.closest('textarea, input, [contenteditable="true"], [role="textbox"]');
  if (!input || isPanelElement(input)) {
    return null;
  }
  const rect = input.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? input : null;
}

function scheduleToolCallScan() {
  if (!toolsEnabled) {
    return;
  }
  if (scanTimer) {
    clearTimeout(scanTimer);
  }
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scanAssistantMessages();
  }, SCAN_DEBOUNCE_MS);
}

function scanAssistantMessages() {
  if (!toolsEnabled) {
    return;
  }
  const nodes = collectToolCallNodes();
  if (!pendingToolCallRequest) {
    ignoreToolCallNodes(nodes);
    return;
  }
  const callsToSend = [];
  for (const node of nodes.slice(-30)) {
    if (ignoredToolCallNodes.has(node)) {
      continue;
    }
    if (callsToSend.length >= toolCallBatchLimit) {
      break;
    }
    const text = getNodeText(node);
    const calls = DeepSeekToolParser.parseToolCalls(text);
    if (!calls.length) {
      continue;
    }
    const freshCalls = calls
      .map((call) => ({ call, key: getToolCallKey(call) }))
      .filter(({ key }) => !processedToolCalls.has(key));
    if (!freshCalls.length) {
      continue;
    }
    if (shouldSuppressToolResultAnswerCalls()) {
      const continuationCalls = getToolResultContinuationCalls(freshCalls);
      const continuationKeys = new Set(continuationCalls.map(({ key }) => key));
      for (const { key } of freshCalls) {
        if (!continuationKeys.has(key)) {
          rememberToolCallKey(key);
        }
      }
      if (!continuationCalls.length) {
        stopSuppressingToolResultAnswerCalls();
        clearToolCallRequestGate();
        setStatus('已忽略工具结果回答中的二次工具调用');
        return;
      }
      stopSuppressingToolResultAnswerCalls();
      toolResultContinueRequested = false;
      for (const { call, key } of continuationCalls) {
        if (callsToSend.length >= toolCallBatchLimit) {
          break;
        }
        if (!rememberToolCallKey(key)) {
          continue;
        }
        callsToSend.push(call);
      }
      continue;
    }
    for (const { call, key } of freshCalls) {
      if (callsToSend.length >= toolCallBatchLimit) {
        break;
      }
      if (!rememberToolCallKey(key)) {
        continue;
      }
      callsToSend.push(call);
    }
  }
  if (!callsToSend.length) {
    return;
  }
  clearToolCallRequestGate();
  startToolResultBatch(callsToSend);
  launchQueuedToolCalls();
}

function getToolResultContinuationCalls(freshCalls) {
  const continuationCalls = freshCalls.filter(({ call }) => call && TOOL_RESULT_CONTINUATION_TOOLS.has(call.tool));
  const runIndex = continuationCalls.findIndex(({ call }) => call.tool === 'run_program');
  if (runIndex === -1) {
    return continuationCalls;
  }
  return runIndex === 0 ? continuationCalls.slice(0, 1) : continuationCalls.slice(0, runIndex);
}

function startToolCallRequestGate() {
  if (!toolsEnabled) {
    return;
  }
  ignoreToolCallNodes(collectToolCallNodes());
  pendingToolCallRequest = true;
  if (toolCallRequestTimer) {
    clearTimeout(toolCallRequestTimer);
  }
  toolCallRequestTimer = setTimeout(() => {
    pendingToolCallRequest = false;
    toolCallRequestTimer = null;
  }, TOOL_CALL_REQUEST_WINDOW_MS);
  scheduleToolCallScan();
}

function clearToolCallRequestGate() {
  pendingToolCallRequest = false;
  if (toolCallRequestTimer) {
    clearTimeout(toolCallRequestTimer);
    toolCallRequestTimer = null;
  }
}

function ignoreToolCallNodes(nodes) {
  for (const node of nodes) {
    ignoredToolCallNodes.add(node);
  }
}

function collectToolCallNodes() {
  const nodes = new Set();
  const candidates = [...document.querySelectorAll('div, p, pre, code, article, section, main, li, span, [class*="message"], [class*="markdown"]')]
    .filter((node) => getNodeText(node).includes('tool_call') && !isEditableToolCallNode(node));
  for (const node of candidates) {
    const container = normalizeToolCallNode(node);
    if (container) {
      nodes.add(container);
    }
  }
  if (nodes.size > 0) {
    return [...nodes];
  }
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    if (!String(textNode.nodeValue || '').includes('tool_call')) {
      continue;
    }
    const container = normalizeToolCallNode(textNode.parentElement);
    if (container) {
      nodes.add(container);
    }
  }
  return [...nodes];
}

function normalizeToolCallNode(node) {
  if (!node || typeof node.closest !== 'function') {
    return null;
  }
  if (isEditableToolCallNode(node)) {
    return null;
  }
  const codeContainer = node.closest('pre') || node.closest('code');
  if (codeContainer && getNodeText(codeContainer).includes('tool_call')) {
    return codeContainer;
  }
  const messageContainer = node.closest('[class*="message"], [class*="markdown"], article, section, main');
  if (messageContainer && getNodeText(messageContainer).includes('tool_call')) {
    return messageContainer;
  }
  const blockContainer = node.closest('li, p, div');
  if (blockContainer && getNodeText(blockContainer).includes('tool_call')) {
    return blockContainer;
  }
  return getNodeText(node).includes('tool_call') ? node : null;
}

function isEditableToolCallNode(node) {
  if (!node || typeof node.closest !== 'function') {
    return false;
  }
  const editable = node.closest('textarea, input, [contenteditable="true"], [role="textbox"]')
    || (typeof node.querySelector === 'function'
      ? node.querySelector('textarea, input, [contenteditable="true"], [role="textbox"]')
      : null);
  return !!editable && !isPanelElement(editable) && getNodeText(editable).includes('tool_call');
}

function getNodeText(node) {
  return node.innerText || node.textContent || '';
}

function getToolCallKey(call) {
  return JSON.stringify({ tool: call.tool, args: call.args || {} });
}

function rememberToolCallKey(key) {
  if (processedToolCalls.has(key)) {
    return false;
  }
  processedToolCalls.add(key);
  while (processedToolCalls.size > MAX_PROCESSED_TOOL_CALLS) {
    processedToolCalls.delete(processedToolCalls.values().next().value);
  }
  return true;
}

function showConfirmOverlay(id, call) {
  const existing = document.getElementById('deepseekwebpp-confirm');
  if (existing) {
    existing.remove();
  }
  const calls = normalizeConfirmCalls(call);

  const overlay = document.createElement('div');
  overlay.id = 'deepseekwebpp-confirm';
  const card = appendElement(overlay, 'div', {
    className: 'deepseekwebpp-confirm-card',
    attributes: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '确认工具调用',
    },
  });
  appendElement(card, 'h2', { text: '确认工具调用' });
  for (const item of calls) {
    appendElement(card, 'div', { className: 'deepseekwebpp-confirm-tool', text: item.tool });
    appendElement(card, 'pre', { text: JSON.stringify(item.args || {}, null, 2) });
  }
  const label = appendElement(card, 'label');
  label.appendChild(document.createTextNode('授权范围'));
  const scopeSelect = appendElement(label, 'select', { id: 'deepseekwebpp-confirm-scope' });
  appendElement(scopeSelect, 'option', { text: '当前参数范围', attributes: { value: 'exact' } });
  appendElement(scopeSelect, 'option', { text: '此工具任意参数', attributes: { value: 'any' } });
  const actions = appendElement(card, 'div', { className: 'deepseekwebpp-confirm-actions' });
  const allowOnceButton = appendElement(actions, 'button', {
    id: 'deepseekwebpp-allow-once',
    text: '仅本次允许',
    attributes: { type: 'button' },
  });
  const allowScopeButton = appendElement(actions, 'button', {
    id: 'deepseekwebpp-allow-scope',
    text: '加入白名单并允许',
    attributes: { type: 'button' },
  });
  const denyButton = appendElement(actions, 'button', {
    id: 'deepseekwebpp-deny',
    text: '拒绝',
    attributes: { type: 'button' },
  });
  document.documentElement.appendChild(overlay);

  allowOnceButton.addEventListener('click', () => {
    decideConfirm(id, 'allow_once');
    overlay.remove();
  });
  allowScopeButton.addEventListener('click', () => {
    const selected = scopeSelect.value;
    decideConfirm(id, 'allow_scope', selected === 'any' ? 'any' : 'exact');
    overlay.remove();
  });
  denyButton.addEventListener('click', () => {
    decideConfirm(id, 'deny');
    overlay.remove();
  });
}

function normalizeConfirmCalls(call) {
  return (Array.isArray(call) ? call : [call]).filter((item) => item && typeof item.tool === 'string');
}

function decideConfirm(id, decision, scopeMode) {
  chrome.runtime.sendMessage({ type: 'confirm.result', id, decision, scopeMode });
}

function queueToolResultForBridge(call, response) {
  lastToolName = call.tool;
  pendingToolResults += 1;
  if (!activeToolResultBatch) {
    scheduleToolResultContinueExpiry();
  }
  updatePanelStats();
  window.postMessage(
    {
      source: 'DeepseekWebpp',
      type: 'DSWEBPP_TOOL_RESULT',
      result: {
        tool: call.tool,
        args: call.args || {},
        response,
      },
    },
    '*',
  );
  setStatus(`已获取 ${call.tool} 结果，正在请求 DeepSeek 基于工具结果回答`);
}

function startToolResultBatch(callsToSend) {
  if (!Array.isArray(callsToSend) || !callsToSend.length) {
    activeToolResultBatch = null;
    return;
  }
  stopSuppressingToolResultAnswerCalls();
  activeToolResultBatch = {
    expected: callsToSend.length,
    completed: 0,
    running: 0,
    runningCalls: [],
    queue: callsToSend.slice(),
    batchDispatched: false,
    timeoutMs: getToolResultBatchTimeoutMs(callsToSend),
  };
  toolResultContinueRequested = false;
  scheduleToolResultContinueExpiry();
  setStatus(`已发起工具批次：${callsToSend.length} 个，并行上限 ${toolCallParallelLimit}`);
}

function launchQueuedToolCalls() {
  if (!activeToolResultBatch || activeToolResultBatch.batchDispatched) {
    return;
  }
  const calls = activeToolResultBatch.queue.splice(0);
  if (!calls.length) {
    return;
  }
  activeToolResultBatch.batchDispatched = true;
  activeToolResultBatch.running += calls.length;
  activeToolResultBatch.runningCalls.push(...calls);
  lastToolName = calls[calls.length - 1].tool;
  updatePanelStats();
  setStatus(getToolBatchRunningStatus());
  chrome.runtime.sendMessage({ type: 'tool.batch.call', calls, parallelLimit: toolCallParallelLimit }, (response) => {
    if (!activeToolResultBatch) {
      return;
    }
    if (response && response.pending) {
      setStatus(`等待工具确认：${activeToolResultBatch.completed}/${activeToolResultBatch.expected}`);
    } else if (response) {
      setStatus(getToolBatchRunningStatus());
    }
  });
}

function removeRunningToolCall(call) {
  if (!activeToolResultBatch || !Array.isArray(activeToolResultBatch.runningCalls)) {
    return;
  }
  const index = activeToolResultBatch.runningCalls.indexOf(call);
  if (index !== -1) {
    activeToolResultBatch.runningCalls.splice(index, 1);
    return;
  }
  const key = getToolCallKey(call);
  const fallbackIndex = activeToolResultBatch.runningCalls.findIndex((item) => getToolCallKey(item) === key);
  if (fallbackIndex !== -1) {
    activeToolResultBatch.runningCalls.splice(fallbackIndex, 1);
  }
}

function getToolBatchRunningStatus() {
  if (!activeToolResultBatch) {
    return '工具批次执行中';
  }
  return `工具执行中：已完成 ${activeToolResultBatch.completed}/${activeToolResultBatch.expected}，并行 ${activeToolResultBatch.running}/${toolCallParallelLimit}`;
}

function getToolResultBatchTimeoutMs(callsToSend) {
  return callsToSend.some((call) => NETWORK_TIMEOUT_TOOLS.has(call.tool))
    ? networkToolTimeoutMs
    : toolResultContinueTimeoutMs;
}

function noteToolResultForBatch(call) {
  if (!activeToolResultBatch) {
    return false;
  }
  removeRunningToolCall(call);
  activeToolResultBatch.running = Math.max(0, activeToolResultBatch.running - 1);
  activeToolResultBatch.completed += 1;
  launchQueuedToolCalls();
  return true;
}

function maybeContinueWithCompletedToolBatch() {
  if (!activeToolResultBatch) {
    return false;
  }
  const { completed, expected } = activeToolResultBatch;
  if (completed < expected) {
    setStatus(`已获取工具结果 ${completed}/${expected}，等待同批次其他工具`);
    return false;
  }
  activeToolResultBatch = null;
  if (pendingToolResults > 0) {
    continueWithToolResult();
  } else {
    clearToolResultContinueTimer();
    updatePanelStats();
    setStatus('同批次工具已完成，无需请求 DeepSeek 续写');
  }
  return true;
}

function shouldContinueWithToolResult(call, response) {
  if (call && call.tool === 'run_program') {
    const result = getToolResultPayload(response);
    // Only fire-and-forget GUI launches are pure actions. wait:true command results
    // include exitCode/stdout/stderr/timedOut/error and must be returned to the model.
    if (result && result.started === true && result.detached === true) {
      return false;
    }
  }
  return true;
}

function getToolResultPayload(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }
  if (response.result && typeof response.result === 'object') {
    return response.result;
  }
  return response;
}

function getDirectToolResultStatus(call, response) {
  const tool = call && call.tool ? call.tool : '工具';
  const result = getToolResultPayload(response);
  if (tool === 'run_program' && result && result.started === true) {
    return `已启动程序：${call.args && call.args.executable ? call.args.executable : '未知程序'}`;
  }
  return `已执行工具：${tool}`;
}

function getToolRunningStatus(call) {
  const tool = call && call.tool ? call.tool : '工具';
  return `正在执行 ${tool}，可能需要较长时间`;
}

function showToolResultContinue() {
  let button = document.getElementById('deepseekwebpp-continue');
  if (!button) {
    button = document.createElement('button');
    button.id = 'deepseekwebpp-continue';
    button.type = 'button';
    button.textContent = '继续处理工具结果';
    button.addEventListener('click', continueWithToolResult);
    const panel = document.getElementById('deepseekwebpp-panel');
    if (panel) {
      panel.appendChild(button);
    }
  }
}

async function continueWithToolResult() {
  if (toolResultContinueRequested) {
    return;
  }
  const stateVersion = toolStateVersion;
  const input = findComposerInput();
  if (!input) {
    showToolResultContinue();
    setStatus('未找到 DeepSeek 输入框，请手动发送：请基于工具结果继续完成原始任务');
    return;
  }
  setComposerText(input, '请基于工具结果继续完成原始任务；如果还需要修改文件或运行验证，请输出下一步 tool_call JSON，不要只说明计划。');
  if (!(await clickSendButtonWhenReady(input, stateVersion))) {
    if (!toolsEnabled || stateVersion !== toolStateVersion) {
      return;
    }
    showToolResultContinue();
    setStatus('工具结果已准备好，请发送当前消息');
    return;
  }
  toolResultContinueRequested = true;
  startSuppressingToolResultAnswerCalls();
  pendingToolResults = 0;
  clearToolResultContinueTimer();
  updatePanelStats();
  const continueButton = document.getElementById('deepseekwebpp-continue');
  if (continueButton) {
    continueButton.remove();
  }
  setStatus('已发送工具结果回答请求');
}

function startSuppressingToolResultAnswerCalls() {
  suppressToolCallsUntilUserTurn = true;
  clearSuppressToolCallsTimer();
  suppressToolCallsTimer = setTimeout(() => {
    suppressToolCallsUntilUserTurn = false;
    suppressToolCallsTimer = null;
  }, TOOL_RESULT_ANSWER_SUPPRESS_MS);
}

function shouldSuppressToolResultAnswerCalls() {
  return suppressToolCallsUntilUserTurn && toolResultContinueRequested;
}

function stopSuppressingToolResultAnswerCalls() {
  suppressToolCallsUntilUserTurn = false;
  clearSuppressToolCallsTimer();
}

function clearSuppressToolCallsTimer() {
  if (suppressToolCallsTimer) {
    clearTimeout(suppressToolCallsTimer);
    suppressToolCallsTimer = null;
  }
}

function findComposerInput() {
  const selectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
  for (const selector of selectors) {
    const inputs = [...document.querySelectorAll(selector)].filter((input) => {
      const rect = input.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !isPanelElement(input);
    });
    if (inputs.length) {
      return inputs[inputs.length - 1];
    }
  }
  return null;
}

function findSendButton(input) {
  const roots = [input.closest('form'), document].filter(Boolean);
  const buttons = [...new Set(roots.flatMap((root) => [...root.querySelectorAll('button, [role="button"]')]))].filter((button) => {
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !isPanelElement(button) && isSendButtonReady(button);
  });
  const preferred = buttons.find((button) => {
    const label = [
      button.getAttribute('aria-label') || '',
      button.getAttribute('title') || '',
      button.textContent || '',
      button.dataset.testid || '',
      button.innerHTML || '',
    ].join(' ');
    return /发送|send|submit/i.test(label);
  });
  return preferred || buttons[buttons.length - 1] || null;
}

function isSendButtonReady(button) {
  return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
}

async function clickSendButtonWhenReady(input, stateVersion) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (!toolsEnabled || stateVersion !== toolStateVersion) {
      return false;
    }
    const sendButton = findSendButton(input);
    if (sendButton) {
      clickElementLikeUser(sendButton);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

function clickElementLikeUser(element) {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus({ preventScroll: true });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    const event = createPointerOrMouseEvent(type);
    element.dispatchEvent(event);
  }
  element.click();
  const form = element.closest('form');
  if (!(element instanceof HTMLButtonElement) && form && typeof form.requestSubmit === 'function') {
    form.requestSubmit();
  }
}

function createPointerOrMouseEvent(type) {
  if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
    return new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', button: 0 });
  }
  return new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 });
}

function setComposerText(input, text) {
  programmaticComposerInput = true;
  try {
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(input, text);
      } else {
        input.value = text;
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  } finally {
    programmaticComposerInput = false;
  }
}

function setStatus(text) {
  const status = document.getElementById('deepseekwebpp-status');
  if (status) {
    status.textContent = text;
  }
}

function updatePanelStats() {
  const state = document.getElementById('deepseekwebpp-state');
  const lastTool = document.getElementById('deepseekwebpp-last-tool');
  const pendingCount = document.getElementById('deepseekwebpp-pending-count');
  if (state) {
    state.textContent = toolsEnabled ? '已启动' : '已禁用';
  }
  if (lastTool) {
    lastTool.textContent = lastToolName;
  }
  if (pendingCount) {
    pendingCount.textContent = String(pendingToolResults);
  }
}

function enablePanelDrag(panel) {
  const handle = panel.querySelector('.deepseekwebpp-title');
  let dragState = null;

  handle.addEventListener('pointerdown', (event) => {
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: panel.getBoundingClientRect(),
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const left = clamp(dragState.rect.left + event.clientX - dragState.startX, 0, window.innerWidth - panel.offsetWidth);
    const top = clamp(dragState.rect.top + event.clientY - dragState.startY, 0, window.innerHeight - panel.offsetHeight);
    setPanelPosition(panel, { left, top });
  });

  handle.addEventListener('pointerup', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    dragState = null;
    const rect = panel.getBoundingClientRect();
    chrome.storage.local.set({ panelPosition: { left: rect.left, top: rect.top } });
  });
}

function restorePanelPosition(panel) {
  chrome.storage.local.get({ panelPosition: null }, (data) => {
    if (data.panelPosition) {
      setPanelPosition(panel, data.panelPosition);
    }
  });
}

function setPanelPosition(panel, position) {
  panel.style.left = `${Math.round(position.left)}px`;
  panel.style.top = `${Math.round(position.top)}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.transform = 'none';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isPanelElement(element) {
  const panel = document.getElementById('deepseekwebpp-panel');
  return !!(panel && element && panel.contains(element));
}
