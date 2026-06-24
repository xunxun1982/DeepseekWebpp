const TOOL_CATALOG = [
  { name: 'list_files', group: '文件只读', risk: '低', summary: '列出目录下的文件和子目录。' },
  { name: 'directory_info', group: '文件只读', risk: '低', summary: '递归统计目录总大小、文件数和子目录数，只返回汇总。' },
  { name: 'read_file', group: '文件只读', risk: '中', summary: '读取文本文件，可限制行号范围。' },
  { name: 'glob_search', group: '文件只读', risk: '低', summary: '按通配符查找匹配路径。' },
  { name: 'grep_search', group: '文件只读', risk: '低', summary: '在文件内容中搜索文本或正则。' },
  { name: 'file_exists', group: '文件只读', risk: '低', summary: '检查文件或目录是否存在。' },
  { name: 'write_file', group: '文件变更', risk: '高', summary: '创建或覆盖文本文件，每次都需要确认。' },
  { name: 'edit_file', group: '文件变更', risk: '高', summary: '精确查找替换文本，每次都需要确认。' },
  { name: 'remove_path', group: '文件变更', risk: '高', summary: '删除文件或目录，每次都需要确认。' },
  { name: 'make_dir', group: '文件变更', risk: '中', summary: '创建目录，每次都需要确认。' },
  { name: 'multi_file_edit', group: '文件变更', risk: '高', summary: '批量编辑多个文件，每次都需要确认。' },
  { name: 'run_program', group: '系统', risk: '高', summary: '运行本机可执行程序。' },
  { name: 'disk_info', group: '系统', risk: '低', summary: '查询本机磁盘容量和可用空间。' },
  { name: 'web_search', group: '网络', risk: '低', summary: '联网搜索并返回标题、摘要、时间、URL 和摘录。' },
  { name: 'web_fetch', group: '网络', risk: '中', summary: '抓取指定 URL 的可读文本。' },
  { name: 'weather', group: '网络', risk: '低', summary: '查询当前天气，默认当地。' },
  { name: 'world_time', group: '系统', risk: '低', summary: '查询各地时间，默认北京时间。' },
];
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
const DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS = 30000;
const DEFAULT_NETWORK_TOOL_TIMEOUT_MS = 600000;
const DEFAULT_TOOL_CALL_BATCH_LIMIT = 5;
const DEFAULT_TOOL_CALL_PARALLEL_LIMIT = 5;

let rules = [];
let searchText = '';
let toolFilter = 'all';
let webSearchSettings = structuredClone(DEFAULT_WEB_SEARCH_SETTINGS);
let toolResultContinueTimeoutMs = DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS;
let networkToolTimeoutMs = DEFAULT_NETWORK_TOOL_TIMEOUT_MS;
let toolCallBatchLimit = DEFAULT_TOOL_CALL_BATCH_LIMIT;
let toolCallParallelLimit = DEFAULT_TOOL_CALL_PARALLEL_LIMIT;
let autoAllowAllTools = false;

const rulesContainer = document.getElementById('rules');
const summaryElement = document.getElementById('rules-summary');
const whitelistSaveButton = document.getElementById('save');
const searchInput = document.getElementById('rule-search');
const toolFilterInput = document.getElementById('tool-filter');
const webSearchProviderInput = document.getElementById('web-search-provider');
const webSearchNoApiSection = document.getElementById('web-search-no-api-section');
const webSearchMcpSection = document.getElementById('web-search-mcp-section');
const webSearchMcpInput = document.getElementById('web-search-mcp-json');
const webSearchStatus = document.getElementById('web-search-status');
const toolResultTimeoutInput = document.getElementById('tool-result-timeout-seconds');
const networkToolTimeoutInput = document.getElementById('network-tool-timeout-seconds');
const toolCallBatchLimitInput = document.getElementById('tool-call-batch-limit');
const toolCallParallelLimitInput = document.getElementById('tool-call-parallel-limit');
const autoAllowAllToolsInput = document.getElementById('auto-allow-all-tools');
const runtimeStatus = document.getElementById('runtime-status');

renderToolFilter();
renderToolCatalog();
renderRuntimeInfo();
renderWebSearchSettings();
renderRuntimeSettings();

chrome.storage.local.get({
  rules: [],
  webSearchSettings: DEFAULT_WEB_SEARCH_SETTINGS,
  toolResultContinueTimeoutMs: DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS,
  networkToolTimeoutMs: DEFAULT_NETWORK_TOOL_TIMEOUT_MS,
  toolCallBatchLimit: DEFAULT_TOOL_CALL_BATCH_LIMIT,
  toolCallParallelLimit: DEFAULT_TOOL_CALL_PARALLEL_LIMIT,
  autoAllowAllTools: false,
}, (data) => {
  rules = Array.isArray(data.rules) ? data.rules : [];
  webSearchSettings = normalizeWebSearchSettings(data.webSearchSettings);
  toolResultContinueTimeoutMs = normalizeToolResultContinueTimeout(data.toolResultContinueTimeoutMs);
  networkToolTimeoutMs = normalizeNetworkToolTimeout(data.networkToolTimeoutMs);
  toolCallBatchLimit = normalizeToolCallBatchLimit(data.toolCallBatchLimit);
  toolCallParallelLimit = normalizeToolCallParallelLimit(data.toolCallParallelLimit);
  autoAllowAllTools = data.autoAllowAllTools === true;
  renderWebSearchSettings();
  renderRuntimeSettings();
  render();
});

document.querySelectorAll('.settings-nav [data-section]').forEach((button) => {
  button.addEventListener('click', () => switchSection(button.dataset.section));
});
switchSection(getInitialSection());
window.addEventListener('hashchange', () => switchSection(getInitialSection()));

searchInput.addEventListener('input', () => {
  searchText = searchInput.value.trim().toLowerCase();
  render();
});

toolFilterInput.addEventListener('change', () => {
  toolFilter = toolFilterInput.value;
  render();
});

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.local.set({ rules }, () => {
    render();
    summaryElement.textContent = `已保存 ${rules.length} 条规则`;
  });
});

document.getElementById('save-web-search').addEventListener('click', saveWebSearchSettings);
document.getElementById('test-web-search-mcp').addEventListener('click', testWebSearchMcp);
document.getElementById('save-runtime-settings').addEventListener('click', saveRuntimeSettings);

webSearchProviderInput.addEventListener('change', updateWebSearchProviderFields);

function switchSection(section) {
  document.querySelectorAll('.settings-nav [data-section]').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === section);
  });
  document.querySelectorAll('.settings-section').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.sectionPanel === section);
  });
  updateWhitelistSaveVisibility(section);
}

function getInitialSection() {
  const section = decodeURIComponent((window.location.hash || '').replace(/^#/, ''));
  const availableSections = [...document.querySelectorAll('.settings-nav [data-section]')]
    .map((button) => button.dataset.section);
  return availableSections.includes(section) ? section : 'overview';
}

function updateWhitelistSaveVisibility(section) {
  whitelistSaveButton.hidden = section !== 'whitelist';
}

function renderToolFilter() {
  for (const tool of TOOL_CATALOG) {
    const option = document.createElement('option');
    option.value = tool.name;
    option.textContent = tool.name;
    toolFilterInput.appendChild(option);
  }
}

function renderToolCatalog() {
  const grid = document.getElementById('tools-grid');
  grid.innerHTML = '';
  for (const tool of TOOL_CATALOG) {
    const card = document.createElement('section');
    card.className = 'tool-card';
    card.innerHTML = `
      <div class="tool-card-header">
        <strong>${escapeHtml(tool.name)}</strong>
        <span>${escapeHtml(tool.risk)}风险</span>
      </div>
      <p>${escapeHtml(tool.summary)}</p>
      <small>${escapeHtml(tool.group)}</small>
    `;
    grid.appendChild(card);
  }
}

function renderRuntimeInfo() {
  const manifest = chrome.runtime.getManifest();
  document.getElementById('host-path').textContent = 'com.deepseekwebpp.native_host -> native-host\\deepseekwebpp-host.exe';
  document.getElementById('extension-id').textContent = `${chrome.runtime.id} / v${manifest.version}`;
}

function renderRuntimeSettings() {
  toolResultTimeoutInput.value = String(Math.round(toolResultContinueTimeoutMs / 1000));
  networkToolTimeoutInput.value = String(Math.round(networkToolTimeoutMs / 1000));
  toolCallBatchLimitInput.value = String(toolCallBatchLimit);
  toolCallParallelLimitInput.value = String(toolCallParallelLimit);
  autoAllowAllToolsInput.checked = autoAllowAllTools;
}

function saveRuntimeSettings() {
  const nextAutoAllowAllTools = autoAllowAllToolsInput.checked === true;
  if (!autoAllowAllTools && nextAutoAllowAllTools && !confirmAutoAllowAllTools()) {
    renderRuntimeSettings();
    runtimeStatus.textContent = '已取消启用全部自动允许';
    return;
  }
  toolResultContinueTimeoutMs = normalizeToolResultContinueTimeout(Number(toolResultTimeoutInput.value) * 1000);
  networkToolTimeoutMs = normalizeNetworkToolTimeout(Number(networkToolTimeoutInput.value) * 1000);
  toolCallBatchLimit = normalizeToolCallBatchLimit(toolCallBatchLimitInput.value);
  toolCallParallelLimit = normalizeToolCallParallelLimit(toolCallParallelLimitInput.value);
  autoAllowAllTools = nextAutoAllowAllTools;
  chrome.storage.local.set({ toolResultContinueTimeoutMs, networkToolTimeoutMs, toolCallBatchLimit, toolCallParallelLimit, autoAllowAllTools }, () => {
    renderRuntimeSettings();
    runtimeStatus.textContent = '运行设置已保存';
  });
}

function confirmAutoAllowAllTools() {
  return window.confirm('启用“全部自动允许”后，文件写入、删除、运行程序等高风险工具也会跳过确认直接执行。仅在你完全信任当前对话和工具调用内容时开启。');
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

function renderWebSearchSettings() {
  webSearchProviderInput.value = webSearchSettings.provider || DEFAULT_WEB_SEARCH_SETTINGS.provider;
  webSearchMcpInput.value = JSON.stringify(webSearchSettings.mcp || DEFAULT_WEB_SEARCH_SETTINGS.mcp, null, 2);
  updateWebSearchProviderFields();
}

function updateWebSearchProviderFields() {
  webSearchNoApiSection.hidden = webSearchProviderInput.value === 'mcp';
  webSearchMcpSection.hidden = webSearchProviderInput.value !== 'mcp';
}

function saveWebSearchSettings() {
  let next;
  try {
    next = getWebSearchSettingsFromForm();
  } catch (error) {
    webSearchStatus.textContent = error.message;
    return;
  }
  webSearchSettings = next;
  chrome.storage.local.set({ webSearchSettings }, () => {
    webSearchStatus.textContent = 'web_search 设置已保存';
  });
}

function testWebSearchMcp() {
  let settings;
  try {
    settings = getWebSearchSettingsFromForm();
  } catch (error) {
    webSearchStatus.textContent = error.message;
    return;
  }
  if (settings.provider !== 'mcp') {
    webSearchStatus.textContent = '请先切换到本地 MCP';
    return;
  }
  const started = performance.now();
  webSearchStatus.textContent = '正在测试 MCP 搜索...';
  chrome.runtime.sendMessage({ type: 'webSearch.test', settings }, (response) => {
    const elapsedMs = Math.round(performance.now() - started);
    if (!response || !response.ok) {
      webSearchStatus.textContent = `MCP 搜索测试失败，耗时 ${elapsedMs} ms：${response && response.error ? response.error : '无返回'}`;
      return;
    }
    const preview = getResultPreview(response.result);
    webSearchStatus.textContent = `MCP 搜索测试成功，耗时 ${elapsedMs} ms：${preview}`;
  });
}

function getResultPreview(result) {
  const text = JSON.stringify(result || {});
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function getWebSearchSettingsFromForm() {
  return normalizeWebSearchSettings({
    provider: webSearchProviderInput.value,
    mcp: parseWebSearchJson(webSearchMcpInput.value, 'MCP JSON'),
  });
}

function parseWebSearchJson(text, label) {
  const source = text.trim();
  if (!source) {
    return {};
  }
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} 必须是 JSON 对象`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label} 解析失败：${error.message}`);
  }
}

function normalizeWebSearchSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const provider = ['bing', 'duckduckgo', 'mcp'].includes(source.provider) ? source.provider : DEFAULT_WEB_SEARCH_SETTINGS.provider;
  return {
    provider,
    mcp: { ...DEFAULT_WEB_SEARCH_SETTINGS.mcp, ...(source.mcp || {}) },
  };
}

function render() {
  const filteredRules = getFilteredRules();
  summaryElement.textContent = `共 ${rules.length} 条规则，当前显示 ${filteredRules.length} 条`;
  renderGroupedRules(filteredRules);
}

function getFilteredRules() {
  return rules.filter((rule) => {
    if (toolFilter !== 'all' && rule.tool !== toolFilter) {
      return false;
    }
    if (!searchText) {
      return true;
    }
    return getSearchText(rule).includes(searchText);
  });
}

function renderGroupedRules(filteredRules) {
  rulesContainer.innerHTML = '';
  if (!filteredRules.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = rules.length ? '没有匹配的白名单规则' : '还没有白名单规则';
    rulesContainer.appendChild(empty);
    return;
  }

  const groups = groupRulesByTool(filteredRules);
  for (const [tool, groupRules] of groups) {
    const group = document.createElement('section');
    group.className = 'tool-group';
    group.innerHTML = `
      <div class="tool-group-header">
        <h3>${escapeHtml(tool || '未命名工具')}</h3>
        <span>${groupRules.length} 条</span>
      </div>
    `;
    for (const rule of groupRules) {
      group.appendChild(createRuleElement(rule));
    }
    rulesContainer.appendChild(group);
  }
}

function groupRulesByTool(items) {
  const groups = new Map();
  for (const rule of items) {
    const key = rule.tool || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(rule);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function createRuleElement(rule) {
  const row = document.createElement('section');
  row.className = 'rule';
  row.dataset.id = rule.id;
  row.innerHTML = `
    <div class="rule-heading">
      <div>
        <strong>${escapeHtml(rule.tool || '未命名工具')}</strong>
        <div class="rule-summary">${escapeHtml(getRuleSummary(rule))}</div>
      </div>
      <button class="delete" type="button">删除</button>
    </div>
    <div class="rule-fields">
      <label>工具 <input class="tool" value="${escapeHtml(rule.tool)}"></label>
      <label>范围
        <select class="mode">
          <option value="path">目录</option>
          <option value="program">程序</option>
          <option value="any">任意</option>
        </select>
      </label>
      <label>目录 <input class="path" value="${escapeHtml(rule.scope && rule.scope.path)}"></label>
      <label>程序 <input class="executable" value="${escapeHtml(rule.scope && rule.scope.executable)}"></label>
    </div>
  `;

  const mode = row.querySelector('.mode');
  mode.value = (rule.scope && rule.scope.mode) || 'any';
  row.querySelector('.tool').addEventListener('input', (event) => {
    rule.tool = event.target.value.trim();
    updateRuleHeading(row, rule);
  });
  mode.addEventListener('change', (event) => {
    rule.scope = { ...(rule.scope || {}), mode: event.target.value };
    updateRuleHeading(row, rule);
  });
  row.querySelector('.path').addEventListener('input', (event) => {
    rule.scope = { ...(rule.scope || {}), path: event.target.value.trim() || undefined };
    updateRuleHeading(row, rule);
  });
  row.querySelector('.executable').addEventListener('input', (event) => {
    rule.scope = { ...(rule.scope || {}), executable: event.target.value.trim() || undefined };
    updateRuleHeading(row, rule);
  });
  row.querySelector('.delete').addEventListener('click', () => {
    rules = rules.filter((item) => item.id !== rule.id);
    render();
  });
  return row;
}

function updateRuleHeading(row, rule) {
  row.querySelector('strong').textContent = rule.tool || '未命名工具';
  row.querySelector('.rule-summary').textContent = getRuleSummary(rule);
}

function getRuleSummary(rule) {
  const scope = rule.scope || {};
  if (scope.mode === 'path') {
    return `目录：${scope.path || '未设置'}`;
  }
  if (scope.mode === 'program') {
    return `程序：${scope.executable || '未设置'}`;
  }
  return '任意范围';
}

function getSearchText(rule) {
  const scope = rule.scope || {};
  return [
    rule.tool,
    scope.mode,
    scope.path,
    scope.executable,
    getRuleSummary(rule),
  ].filter(Boolean).join(' ').toLowerCase();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}
