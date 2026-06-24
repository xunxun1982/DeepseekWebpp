const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const packageVersion = require('../package.json').version;
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 600000;
const MAX_MCP_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_MCP_STDERR_CHARS = 16 * 1024;
const SEARCH_REQUEST_ATTEMPTS = 2;

const SEARCH_URL_TEMPLATES = {
  bing: 'https://www.bing.com/search?q={query}',
  duckduckgo: 'https://html.duckduckgo.com/html/?q={query}',
};
const SEARCH_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

async function listFiles(args) {
  const targetPath = requireString(args, 'path');
  const entries = await fs.readdir(targetPath, { withFileTypes: true });

  return {
    path: targetPath,
    entries: entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    })),
  };
}

async function directoryInfo(args) {
  const targetPath = requireString(args, 'path');
  const rootInfo = await fs.lstat(targetPath);
  if (!rootInfo.isDirectory()) {
    throw new Error('path must be a directory');
  }
  let totalBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const pendingDirs = [targetPath];

  while (pendingDirs.length) {
    const current = pendingDirs.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (_) {
      errorCount += 1;
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        skippedCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        directoryCount += 1;
        pendingDirs.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        skippedCount += 1;
        continue;
      }
      try {
        const info = await fs.stat(entryPath);
        if (info.isFile()) {
          fileCount += 1;
          totalBytes += info.size;
        } else {
          skippedCount += 1;
        }
      } catch (_) {
        errorCount += 1;
      }
    }
  }

  return {
    path: targetPath,
    totalBytes,
    totalGb: bytesToGb(totalBytes),
    fileCount,
    directoryCount,
    skippedCount,
    errorCount,
  };
}

async function readFile(args) {
  const targetPath = requireString(args, 'path');
  const content = await fs.readFile(targetPath, 'utf8');
  if (!args.startLine && !args.endLine) {
    return { path: targetPath, content };
  }

  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Number(args.startLine || 1));
  const end = Math.min(lines.length, Number(args.endLine || lines.length));
  return {
    path: targetPath,
    startLine: start,
    endLine: end,
    content: lines.slice(start - 1, end).join('\n'),
  };
}

async function writeFile(args) {
  const targetPath = requireString(args, 'path');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, String(args.content || ''), 'utf8');
  return { path: targetPath, bytes: Buffer.byteLength(String(args.content || ''), 'utf8') };
}

async function editFile(args) {
  const targetPath = requireString(args, 'path');
  const search = requireString(args, 'search');
  const replace = String(args.replace || '');
  const content = await fs.readFile(targetPath, 'utf8');
  const next = content.split(search).join(replace);
  const replacements = content.split(search).length - 1;
  if (!replacements) {
    throw new Error('search text not found');
  }
  await fs.writeFile(targetPath, next, 'utf8');
  return { path: targetPath, replacements };
}

async function globSearch(args) {
  const root = requireString(args, 'root');
  const pattern = requireString(args, 'pattern');
  const files = await walkFiles(root);
  const matches = files
    .map((file) => path.relative(root, file).replace(/\\/g, '/'))
    .filter((relative) => globToRegExp(pattern).test(relative));
  return { root, pattern, matches };
}

async function grepSearch(args) {
  const root = requireString(args, 'root');
  const pattern = requireString(args, 'pattern');
  const glob = args.glob || '**/*';
  const regexp = new RegExp(pattern, args.caseSensitive ? '' : 'i');
  const files = await walkFiles(root);
  const matches = [];
  for (const file of files) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    if (!globToRegExp(glob).test(relative)) {
      continue;
    }
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (_) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (regexp.test(lines[index])) {
        matches.push({ path: relative, line: index + 1, text: lines[index] });
      }
    }
  }
  return { root, pattern, matches };
}

async function fileExists(args) {
  const targetPath = requireString(args, 'path');
  try {
    const stat = await fs.stat(targetPath);
    return {
      path: targetPath,
      exists: true,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: targetPath, exists: false };
    }
    throw error;
  }
}

async function removePath(args) {
  const targetPath = requireString(args, 'path');
  await fs.rm(targetPath, { recursive: !!args.recursive, force: !!args.force });
  return { path: targetPath, removed: true };
}

async function makeDir(args) {
  const targetPath = requireString(args, 'path');
  await fs.mkdir(targetPath, { recursive: true });
  return { path: targetPath, created: true };
}

async function multiFileEdit(args) {
  if (!Array.isArray(args.edits) || !args.edits.length) {
    throw new Error('edits is required');
  }
  const files = [];
  for (const edit of args.edits) {
    files.push(await editFile(edit));
  }
  return { files };
}

function runProgram(args) {
  const executable = resolveExecutable(requireString(args, 'executable'));
  const programArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 30000;
  const wait = args.wait === undefined ? programArgs.length > 0 : args.wait !== false;

  if (!wait) {
    const child = spawn(executable, programArgs, {
      cwd: args.cwd || undefined,
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return Promise.resolve({ started: true, pid: child.pid, detached: true });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, programArgs, {
      cwd: args.cwd || undefined,
      shell: false,
      windowsHide: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function resolveExecutable(executable, options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || fileExistsSync;
  const registryLookup = options.registryLookup || lookupAppPathRegistry;
  const value = String(executable || '').trim();
  if (!value) {
    return value;
  }
  if (/[\\/]/.test(value) || path.isAbsolute(value)) {
    return value;
  }

  const names = executableNames(value);
  for (const name of names) {
    const pathMatch = findOnPath(name, env, exists);
    if (pathMatch) {
      return pathMatch;
    }
  }
  for (const name of names) {
    const registryMatch = registryLookup(name);
    if (registryMatch) {
      return registryMatch;
    }
  }
  for (const candidate of commonExecutableCandidates(names, env)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return executable;
}

function executableNames(value) {
  const lower = value.toLowerCase();
  const aliases = {
    word: 'WINWORD.EXE',
    winword: 'WINWORD.EXE',
    excel: 'EXCEL.EXE',
    powerpoint: 'POWERPNT.EXE',
    powerpnt: 'POWERPNT.EXE',
    ppt: 'POWERPNT.EXE',
    wps: 'wps.exe',
    et: 'et.exe',
    wpp: 'wpp.exe',
  };
  const primary = aliases[lower] || value;
  const names = [primary];
  if (!path.extname(primary)) {
    if (process.platform === 'win32') {
      names.unshift(`${primary}.cmd`);
      names.unshift(`${primary}.exe`);
    } else {
      names.push(`${primary}.exe`);
      names.push(`${primary}.cmd`);
    }
  }
  return [...new Set(names)];
}

function findOnPath(executable, env, exists) {
  const pathDirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, executable);
    if (exists(candidate)) {
      return candidate;
    }
  }
  return '';
}

function lookupAppPathRegistry(executable) {
  if (process.platform !== 'win32') {
    return '';
  }
  const keys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`,
    `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`,
  ];
  for (const key of keys) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const line = output.split(/\r?\n/).find((item) => /\bREG_SZ\b/i.test(item));
      if (line) {
        return line.replace(/^.*?\bREG_SZ\b\s+/i, '').trim();
      }
    } catch (_) {
      // Missing App Paths entries are normal.
    }
  }
  return '';
}

function commonExecutableCandidates(names, env) {
  const roots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'D:\\Program Files',
    'D:\\Program Files (x86)',
  ].filter(Boolean);
  const subdirs = [
    'Microsoft Office\\root\\Office16',
    'Microsoft Office\\Office16',
    'Kingsoft\\WPS Office\\office6',
  ];
  const npmRoots = [
    env.APPDATA && path.join(env.APPDATA, 'npm'),
    'C:\\Users\\User\\AppData\\Roaming\\npm',
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    for (const subdir of subdirs) {
      for (const name of names) {
        candidates.push(path.join(root, subdir, name));
      }
    }
  }
  for (const root of npmRoots) {
    for (const name of names) {
      candidates.push(path.join(root, name));
    }
  }
  return candidates;
}

function fileExistsSync(candidate) {
  try {
    return require('node:fs').existsSync(candidate);
  } catch (_) {
    return false;
  }
}

async function diskInfo() {
  const output = await runProgram({
    executable: 'powershell.exe',
    args: [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | Select-Object DeviceID,Size,FreeSpace,VolumeName | ConvertTo-Json -Compress",
    ],
    timeoutMs: 10000,
  });

  if (output.exitCode !== 0) {
    throw new Error(output.stderr || 'Failed to query disk information');
  }

  const parsed = JSON.parse(output.stdout || '[]');
  const disks = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((disk) => {
    const sizeBytes = Number(disk.Size || 0);
    const freeBytes = Number(disk.FreeSpace || 0);
    return {
      deviceId: String(disk.DeviceID || ''),
      volumeName: disk.VolumeName ? String(disk.VolumeName) : '',
      sizeBytes,
      freeBytes,
      usedBytes: Math.max(0, sizeBytes - freeBytes),
      sizeGb: bytesToGb(sizeBytes),
      freeGb: bytesToGb(freeBytes),
      usedGb: bytesToGb(Math.max(0, sizeBytes - freeBytes)),
    };
  });

  return { disks };
}

async function webFetch(args, fetchImpl = fetch) {
  const url = requireString(args, 'url');
  const response = await fetchImpl(url, webFetchOptions(url));
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    url: response.url || url,
    text: stripHtml(text).slice(0, Number(args.maxChars || 12000)),
  };
}

function webFetchOptions(url) {
  if (isDuckDuckGoUrl(url)) {
    return { redirect: 'follow', headers: SEARCH_REQUEST_HEADERS };
  }
  return { redirect: 'follow' };
}

async function webSearch(args, fetchImpl = fetch, mcpCaller = callMcpTool) {
  const query = requireString(args, 'query');
  const provider = String(args.provider || 'duckduckgo').toLowerCase();
  if (provider === 'mcp') {
    try {
      const mcpResult = await webSearchViaMcp(query, args, mcpCaller);
      const mcpError = getMcpSearchError(mcpResult.result);
      if (mcpError) {
        return await webSearchFallbackChain(query, args, fetchImpl, mcpCaller, 'mcp', mcpError);
      }
      if (!hasSearchResults(mcpResult)) {
        return await webSearchFallbackChain(query, args, fetchImpl, mcpCaller, 'mcp', getMcpEmptyResultMessage(mcpResult.result));
      }
      return mcpResult;
    } catch (error) {
      return await webSearchFallbackChain(query, args, fetchImpl, mcpCaller, 'mcp', error);
    }
  }

  const urlTemplate = args.searchUrl || SEARCH_URL_TEMPLATES[provider] || SEARCH_URL_TEMPLATES.duckduckgo;
  const url = urlTemplate.replace('{query}', encodeURIComponent(query));
  const response = await fetchSearchResponseWithRetry(url, provider, fetchImpl);
  const html = await response.text();
  const results = extractSearchResults(html).slice(0, Number(args.limit || 20));
  if (args.includeContent !== false) {
    await addSearchResultExcerpts(results, args, fetchImpl);
  }
  return {
    ok: response.ok,
    status: response.status,
    provider,
    url: response.url || url,
    guidance: 'Answer from these search results when they contain enough title, snippet, date, and excerpt context. Do not call web_fetch automatically unless the user explicitly asks to read a link or the excerpts are insufficient.',
    results,
  };
}

async function webSearchFallbackChain(query, args, fetchImpl, mcpCaller, fallbackFrom, fallbackError) {
  const fallbackProviders = ['bing', 'duckduckgo'];
  const errors = [];
  for (const provider of fallbackProviders) {
    try {
      const fallback = await webSearch(
        { ...args, provider, searchUrl: SEARCH_URL_TEMPLATES[provider], mcp: undefined },
        fetchImpl,
        mcpCaller,
      );
      if (!hasSearchResults(fallback)) {
        errors.push(`${provider}: empty results`);
        continue;
      }
      return {
        ...fallback,
        fallbackFrom,
        fallbackError: getErrorMessage(fallbackError),
        fallbackProviders,
      };
    } catch (error) {
      errors.push(`${provider}: ${getErrorMessage(error)}`);
    }
  }
  throw new Error(`${fallbackFrom} search failed: ${getErrorMessage(fallbackError)}; fallback failed: ${errors.join('; ')}`);
}

function hasSearchResults(result) {
  return !!result && Array.isArray(result.results) && result.results.length > 0;
}

async function fetchSearchResponseWithRetry(url, provider, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < SEARCH_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetchImpl(url, searchFetchOptions(provider));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function getMcpSearchError(result) {
  for (const candidate of getMcpPayloadObjects(result)) {
    if (candidate.ok === false && (candidate.error || candidate.message)) {
      return String(candidate.error || candidate.message);
    }
    if (candidate.error && (!Array.isArray(candidate.results) || candidate.results.length === 0)) {
      return String(candidate.error);
    }
    if (candidate.isError === true && (candidate.error || candidate.message || candidate.content)) {
      return String(candidate.error || candidate.message || candidate.content);
    }
  }
  return '';
}

function getMcpEmptyResultMessage(result) {
  const text = getFirstMcpContentText(result);
  return text ? `MCP search returned empty results: ${text.slice(0, 500)}` : 'MCP search returned empty results';
}

function searchFetchOptions(provider) {
  if (provider === 'duckduckgo') {
    return { redirect: 'follow', headers: SEARCH_REQUEST_HEADERS };
  }
  return { redirect: 'follow' };
}

function isDuckDuckGoUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().endsWith('duckduckgo.com');
  } catch (_) {
    return false;
  }
}

async function webSearchViaMcp(query, args, mcpCaller) {
  const mcp = args.mcp || {};
  const server = resolveMcpServer(mcp);
  const tool = String(mcp.tool || 'web_search');
  const toolArgs = {
    ...(isPlainObject(mcp.arguments) ? mcp.arguments : {}),
    query,
  };
  const result = await mcpCaller(server, tool, toolArgs);
  return {
    ok: true,
    provider: 'mcp',
    mcpTool: tool,
    guidance: 'Answer from the stdio MCP search result. GrokSearch-rs and compatible MCP servers usually return a synthesized answer plus sources.',
    result,
    results: normalizeMcpSearchResults(result),
  };
}

function resolveMcpServer(mcp) {
  if (isPlainObject(mcp.mcpServers)) {
    const serverName = String(mcp.server || Object.keys(mcp.mcpServers)[0] || '');
    const server = isPlainObject(mcp.mcpServers[serverName]) ? mcp.mcpServers[serverName] : {};
    return {
      ...server,
      timeoutMs: mcp.timeoutMs || server.timeoutMs,
    };
  }
  return mcp;
}

function normalizeMcpSearchResults(result) {
  for (const candidate of getMcpPayloadObjects(result)) {
    const sources = Array.isArray(candidate.sources) ? candidate.sources : candidate.results;
    if (!Array.isArray(sources) || sources.length === 0) {
      continue;
    }
    const normalized = sources.map((source) => ({
      title: String(source.title || source.name || source.url || ''),
      url: String(source.url || ''),
      snippet: source.snippet || source.description || source.content,
      date: source.date || source.published_date,
    })).filter((source) => source.title || source.url);
    if (normalized.length) {
      return normalized;
    }
  }
  return [];
}

function getMcpPayloadObjects(result) {
  if (!result || typeof result !== 'object') {
    return [];
  }
  const payloads = [result];
  if (isPlainObject(result.structuredContent)) {
    payloads.push(result.structuredContent);
  }
  for (const item of Array.isArray(result.content) ? result.content : [result.content]) {
    const text = typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '';
    const parsed = parseJsonObject(text);
    if (parsed) {
      payloads.push(parsed);
    }
  }
  return payloads;
}

function getFirstMcpContentText(result) {
  if (!result || typeof result !== 'object') {
    return '';
  }
  for (const item of Array.isArray(result.content) ? result.content : [result.content]) {
    const text = typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '';
    if (text.trim()) {
      return text.trim();
    }
  }
  return '';
}

function parseJsonObject(value) {
  const text = String(value || '').trim();
  if (!text || !text.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function callMcpTool(mcp, tool, toolArgs) {
  const requestedCommand = requireString(mcp, 'command');
  const command = resolveExecutable(requestedCommand);
  if (command === requestedCommand && !/[\\/]/.test(requestedCommand) && !path.isAbsolute(requestedCommand)) {
    throw new Error(`MCP tool command not found: ${requestedCommand}`);
  }
  const args = Array.isArray(mcp.args) ? mcp.args.map(String) : [];
  const timeoutMs = Math.max(1000, Number(mcp.timeoutMs || DEFAULT_MCP_TOOL_TIMEOUT_MS));
  const env = { ...process.env, ...normalizeStringMap(mcp.env) };

  return new Promise((resolve, reject) => {
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd: typeof mcp.cwd === 'string' && mcp.cwd.trim() ? mcp.cwd : undefined,
      env,
      shell: needsShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`MCP tool timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (settled) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_MCP_RESPONSE_BYTES) {
        finish(new Error(`MCP response exceeds ${MAX_MCP_RESPONSE_BYTES} bytes`));
        return;
      }
      stdout += chunk.toString('utf8');
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        handleMcpLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = truncateBufferText(stderr + chunk.toString('utf8'), MAX_MCP_STDERR_CHARS);
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (!settled) {
        finish(new Error(`MCP process exited before response${code === null ? '' : `, code ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    });

    writeMcpMessage(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'DeepseekWebpp', version: packageVersion } } });
    writeMcpMessage(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    writeMcpMessage(child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: toolArgs } });

    function handleMcpLine(line) {
      if (!line.trim()) {
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        return;
      }
      if (message.id !== 2) {
        return;
      }
      if (message.error) {
        finish(new Error(message.error.message || JSON.stringify(message.error)));
        return;
      }
      const result = message.result && (message.result.structuredContent || parseMcpTextContent(message.result.content));
      finish(null, result || message.result);
    }

    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }
  });
}

function truncateBufferText(value, maxChars) {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function writeMcpMessage(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function parseMcpTextContent(content) {
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text.text);
  } catch (_) {
    return { content: text.text };
  }
}

async function weather(args = {}, fetchImpl = fetch) {
  const { location, defaulted } = await resolveLocation(args, fetchImpl, getLocalIpLocation);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m');
  url.searchParams.set('timezone', location.timezone || 'auto');

  const data = await fetchJson(url, fetchImpl, 'weather forecast');
  const current = data.current || {};
  return {
    defaulted,
    provider: 'Open-Meteo',
    location: publicLocation(location),
    current: {
      time: current.time || '',
      temperatureC: numberOrNull(current.temperature_2m),
      apparentTemperatureC: numberOrNull(current.apparent_temperature),
      humidityPercent: numberOrNull(current.relative_humidity_2m),
      weatherCode: numberOrNull(current.weather_code),
      weatherText: weatherCodeText(current.weather_code),
      windSpeedKmh: numberOrNull(current.wind_speed_10m),
    },
  };
}

async function worldTime(args = {}, fetchImpl = fetch, now = new Date()) {
  const { location, defaulted } = await resolveLocation(args, fetchImpl, () => ({
        name: '北京',
        country: '中国',
        latitude: 39.9042,
        longitude: 116.4074,
        timezone: 'Asia/Shanghai',
      }));
  const parts = formatZonedTime(now, location.timezone || 'Asia/Shanghai');
  return {
    defaulted,
    provider: 'local-system-clock',
    location: publicLocation(location),
    timeZone: location.timezone || 'Asia/Shanghai',
    date: parts.date,
    time: parts.time,
    iso: now.toISOString(),
  };
}

async function addSearchResultExcerpts(results, args, fetchImpl) {
  const maxResults = Math.max(0, Math.min(results.length, Number(args.contentResults || 3)));
  const maxChars = Math.max(200, Math.min(Number(args.maxContentChars || 2000), 8000));
  for (const result of results.slice(0, maxResults)) {
    if (!/^https?:\/\//i.test(result.url || '')) {
      continue;
    }
    try {
      const response = await fetchImpl(result.url, { redirect: 'follow', headers: SEARCH_REQUEST_HEADERS });
      const contentType = response.headers && response.headers.get ? String(response.headers.get('content-type') || '') : '';
      if (contentType && !/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
        continue;
      }
      const text = stripHtml(await response.text());
      if (text) {
        result.excerpt = text.slice(0, maxChars);
      }
    } catch (_) {
      // Search results should remain usable even when a linked page blocks fetching.
    }
  }
}

async function callTool(tool, args) {
  const handler = TOOL_HANDLERS[tool];
  if (handler) return handler(args || {});
  throw new Error(`Unknown tool: ${tool}`);
}

const TOOL_HANDLERS = {
  list_files: listFiles,
  directory_info: directoryInfo,
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  glob_search: globSearch,
  grep_search: grepSearch,
  file_exists: fileExists,
  remove_path: removePath,
  make_dir: makeDir,
  multi_file_edit: multiFileEdit,
  run_program: runProgram,
  disk_info: diskInfo,
  web_fetch: webFetch,
  web_search: webSearch,
  weather,
  world_time: worldTime,
};

async function walkFiles(root) {
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  await walk(root);
  return results;
}

function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSearchResults(html) {
  const results = [];
  for (const match of String(html || '').matchAll(/<li[^>]+class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi)) {
    const block = match[0];
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!link) {
      continue;
    }
    const snippet = (block.match(/<div[^>]+class=["'][^"']*\bb_caption\b[^"']*["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
    results.push(createSearchResult(link[2], link[1], snippet));
  }

  const patterns = [
    /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    /<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      results.push(createSearchResult(match[2], match[1]));
    }
  }
  return results.filter((item, index, array) => item.url && array.findIndex((other) => other.url === item.url) === index);
}

function createSearchResult(title, url, snippet) {
  const result = {
    title: decodeHtml(stripHtml(title)),
    url: normalizeSearchResultUrl(url),
  };
  const cleanSnippet = decodeHtml(stripHtml(snippet || ''));
  if (cleanSnippet) {
    const date = extractResultDate(cleanSnippet);
    if (date) {
      result.date = date;
    }
    result.snippet = cleanSnippet;
  }
  return result;
}

function normalizeSearchResultUrl(value) {
  const decoded = decodeHtml(value);
  if (!decoded) {
    return '';
  }
  const absoluteUrl = decoded.startsWith('//') ? `https:${decoded}` : decoded;
  let parsed;
  try {
    parsed = new URL(absoluteUrl);
  } catch (_) {
    return decoded;
  }

  const host = parsed.hostname.toLowerCase();
  if (host.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
    const target = parsed.searchParams.get('uddg');
    if (target) {
      return target;
    }
  }

  if (host.endsWith('bing.com') && parsed.pathname === '/ck/a') {
    const target = decodeBingRedirectTarget(parsed.searchParams.get('u'));
    if (target) {
      return target;
    }
  }

  return parsed.href;
}

function decodeBingRedirectTarget(value) {
  if (!value) {
    return '';
  }
  const raw = decodeHtml(value);
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const candidates = raw.startsWith('a1') ? [raw.slice(2), raw] : [raw];
  for (const candidate of candidates) {
    try {
      const decoded = Buffer.from(candidate, 'base64url').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
    } catch (_) {
      // Try the next Bing redirect encoding variant.
    }
  }
  return '';
}

async function resolveLocation(args, fetchImpl, getDefaultLocation) {
  const locationText = typeof args.location === 'string' ? args.location.trim() : '';
  if (locationText) {
    return { location: await geocodeLocation(locationText, fetchImpl), defaulted: false };
  }
  return { location: await getDefaultLocation(fetchImpl), defaulted: true };
}

async function geocodeLocation(location, fetchImpl) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', location);
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'zh');
  url.searchParams.set('format', 'json');
  const data = await fetchJson(url, fetchImpl, 'geocoding');
  const first = Array.isArray(data.results) ? data.results[0] : null;
  if (first) {
    return {
      name: first.name || location,
      country: first.country || '',
      latitude: first.latitude,
      longitude: first.longitude,
      timezone: first.timezone || 'UTC',
    };
  }
  const fallback = await geocodeLocationFallback(location, fetchImpl);
  if (fallback) {
    return fallback;
  }
  throw new Error(`location not found: ${location}`);
}

async function geocodeLocationFallback(location, fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    return null;
  }
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', location);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');
  const response = await fetchImpl(url.toString(), {
    redirect: 'follow',
    headers: { 'User-Agent': `DeepseekWebpp/${packageVersion}` },
  });
  if (!response || response.ok === false) {
    return null;
  }
  const results = await response.json();
  const first = Array.isArray(results) ? results[0] : null;
  if (!first) {
    return null;
  }
  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  const timezone = await fetchTimezoneForCoordinates(latitude, longitude, fetchImpl);
  return {
    name: String(first.display_name || location).split(',')[0].trim() || location,
    country: first.address && first.address.country ? String(first.address.country) : '',
    latitude,
    longitude,
    timezone,
  };
}

async function fetchTimezoneForCoordinates(latitude, longitude, fetchImpl) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', 'temperature_2m');
  url.searchParams.set('timezone', 'auto');
  const data = await fetchJson(url, fetchImpl, 'timezone');
  return data.timezone || 'UTC';
}

async function getLocalIpLocation(fetchImpl) {
  const data = await fetchJson('https://ipwho.is/', fetchImpl, 'local location');
  if (data.success === false || !Number.isFinite(Number(data.latitude)) || !Number.isFinite(Number(data.longitude))) {
    throw new Error('failed to detect local location; specify location explicitly');
  }
  return {
    name: data.city || '当地',
    country: data.country || '',
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: data.timezone && data.timezone.id ? data.timezone.id : 'auto',
  };
}

async function fetchJson(url, fetchImpl, label) {
  if (typeof fetchImpl !== 'function') {
    throw new Error(`${label} fetch is unavailable`);
  }
  const response = await fetchImpl(url.toString(), { redirect: 'follow' });
  if (!response || response.ok === false) {
    throw new Error(`${label} request failed with status ${response ? response.status : 'unknown'}`);
  }
  return response.json();
}

function publicLocation(location) {
  return {
    name: location.name || '',
    country: location.country || '',
    latitude: numberOrNull(location.latitude),
    longitude: numberOrNull(location.longitude),
    timezone: location.timezone || '',
  };
}

function formatZonedTime(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}/${parts.month}/${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function weatherCodeText(code) {
  const value = Number(code);
  const map = new Map([
    [0, '晴'],
    [1, '大致晴朗'],
    [2, '局部多云'],
    [3, '阴'],
    [45, '雾'],
    [48, '雾凇'],
    [51, '小毛毛雨'],
    [53, '中等毛毛雨'],
    [55, '大毛毛雨'],
    [61, '小雨'],
    [63, '中雨'],
    [65, '大雨'],
    [71, '小雪'],
    [73, '中雪'],
    [75, '大雪'],
    [80, '小阵雨'],
    [81, '中等阵雨'],
    [82, '强阵雨'],
    [95, '雷暴'],
    [96, '雷暴伴小冰雹'],
    [99, '雷暴伴大冰雹'],
  ]);
  return map.get(value) || '未知';
}

function extractResultDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^((?:\d+\s*(?:秒|分钟|小时|天|周|个月|年)之前)|(?:\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago)|(?:\d{4}年\d{1,2}月\d{1,2}日)|(?:\d{1,2}月\d{1,2}日)|(?:\d{4}-\d{1,2}-\d{1,2}))/i);
  return match ? match[1] : '';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function replaceQueryPlaceholders(value, query) {
  return String(value || '')
    .replaceAll('{query}', encodeURIComponent(query))
    .replaceAll('{queryRaw}', query);
}

function getByPath(value, pathText) {
  if (!pathText) {
    return value;
  }
  return String(pathText).split('.').filter(Boolean).reduce((current, part) => {
    if (current === undefined || current === null) {
      return undefined;
    }
    return current[part];
  }, value);
}

function normalizeStringMap(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null)
      .map(([key, item]) => [String(key), String(item)]),
  );
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(args, key) {
  const value = args && args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required`);
  }
  return value;
}

function bytesToGb(value) {
  return Math.round((Number(value || 0) / 1024 / 1024 / 1024) * 100) / 100;
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

module.exports = {
  listFiles,
  directoryInfo,
  readFile,
  writeFile,
  editFile,
  globSearch,
  grepSearch,
  fileExists,
  removePath,
  makeDir,
  multiFileEdit,
  runProgram,
  resolveExecutable,
  diskInfo,
  webFetch,
  webSearch,
  weather,
  worldTime,
  TOOL_HANDLERS,
  callTool,
};
