const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  listFiles,
  runProgram,
  diskInfo,
  callTool,
  readFile,
  writeFile,
  editFile,
  globSearch,
  grepSearch,
  fileExists,
  removePath,
  makeDir,
  multiFileEdit,
  webFetch,
  webSearch,
  weather,
  worldTime,
  TOOL_HANDLERS,
  resolveExecutable,
} = require('../native-host/tools');

test('listFiles returns directory entries with basic metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseekwebpp-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.mkdirSync(path.join(dir, 'folder'));

  const result = await listFiles({ path: dir });

  assert.deepEqual(
    result.entries.map((entry) => entry.name).sort(),
    ['a.txt', 'folder'],
  );
  assert.equal(result.path, dir);
  assert.equal(result.entries.find((entry) => entry.name === 'a.txt').type, 'file');
  assert.equal(result.entries.find((entry) => entry.name === 'folder').type, 'directory');
});

test('readFile reads optional line ranges', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deepseekwebpp-')), 'a.txt');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');

  const result = await readFile({ path: file, startLine: 2, endLine: 3 });

  assert.equal(result.path, file);
  assert.equal(result.content, 'two\nthree');
});

test('writeFile creates parent directories and editFile replaces exact text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseekwebpp-'));
  const file = path.join(dir, 'nested', 'a.txt');

  await writeFile({ path: file, content: 'alpha beta' });
  const edited = await editFile({ path: file, search: 'beta', replace: 'gamma' });

  assert.equal(edited.replacements, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'alpha gamma');
});

test('globSearch grepSearch fileExists makeDir removePath and multiFileEdit work together', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseekwebpp-'));
  const nested = path.join(dir, 'src');
  await makeDir({ path: nested });
  const a = path.join(nested, 'a.txt');
  const b = path.join(nested, 'b.log');
  fs.writeFileSync(a, 'hello world\n');
  fs.writeFileSync(b, 'hello log\n');

  assert.equal((await fileExists({ path: a })).exists, true);
  assert.deepEqual((await globSearch({ root: dir, pattern: '**/*.txt' })).matches.map((item) => item.replace(/\\/g, '/')), ['src/a.txt']);
  assert.equal((await grepSearch({ root: dir, pattern: 'hello', glob: '**/*.*' })).matches.length, 2);

  const edited = await multiFileEdit({
    edits: [
      { path: a, search: 'world', replace: 'agent' },
      { path: b, search: 'log', replace: 'trace' },
    ],
  });
  assert.equal(edited.files.length, 2);
  assert.equal(fs.readFileSync(a, 'utf8'), 'hello agent\n');

  await removePath({ path: nested, recursive: true });
  assert.equal(fs.existsSync(nested), false);
});

test('runProgram executes a fixed executable without shell expansion', async () => {
  const result = await runProgram({
    executable: process.execPath,
    args: ['-e', 'console.log("ok")'],
    timeoutMs: 5000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'ok');
  assert.equal(result.timedOut, false);
});

test('runProgram can launch GUI programs without waiting for process exit', async () => {
  const result = await runProgram({
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30000)'],
    timeoutMs: 5000,
    wait: false,
  });

  assert.equal(result.started, true);
  assert.equal(typeof result.pid, 'number');
  assert.equal(result.detached, true);
});

test('runProgram treats no-argument programs as GUI launches by default', async () => {
  const result = await runProgram({
    executable: process.execPath,
    args: [],
    timeoutMs: 5000,
  });

  assert.equal(result.started, true);
  assert.equal(result.detached, true);
});

test('resolveExecutable finds common Windows office app aliases outside PATH', () => {
  const env = {
    PATH: '',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local',
  };
  const registryLookup = (name) => {
    if (name === 'WINWORD.EXE') return 'C:\\Office\\WINWORD.EXE';
    if (name === 'wps.exe') return 'D:\\WPS\\office6\\wps.exe';
    return '';
  };

  assert.equal(
    resolveExecutable('winword', { env, registryLookup }),
    'C:\\Office\\WINWORD.EXE',
  );
  assert.equal(
    resolveExecutable('wps', { env, registryLookup }),
    'D:\\WPS\\office6\\wps.exe',
  );
});

test('resolveExecutable finds npm command shims on PATH', () => {
  const env = { PATH: 'C:\\Users\\User\\AppData\\Roaming\\npm' };
  const exists = (candidate) => candidate === 'C:\\Users\\User\\AppData\\Roaming\\npm\\grok-search-rs'
    || candidate === 'C:\\Users\\User\\AppData\\Roaming\\npm\\grok-search-rs.cmd';

  assert.equal(
    resolveExecutable('grok-search-rs', { env, exists, registryLookup: () => '' }),
    'C:\\Users\\User\\AppData\\Roaming\\npm\\grok-search-rs.cmd',
  );
});

test('resolveExecutable falls back to default npm command directories', () => {
  const env = { PATH: '', APPDATA: 'C:\\Users\\User\\AppData\\Roaming' };
  const exists = (candidate) => candidate === 'C:\\Users\\User\\AppData\\Roaming\\npm\\grok-search-rs.cmd';

  assert.equal(
    resolveExecutable('grok-search-rs', { env, exists, registryLookup: () => '' }),
    'C:\\Users\\User\\AppData\\Roaming\\npm\\grok-search-rs.cmd',
  );
});

test('webSearch MCP falls back to Bing when the command is missing', async () => {
  const fetchedUrls = [];
  const result = await webSearch(
    {
      query: 'missing mcp',
      provider: 'mcp',
      mcp: {
        command: 'definitely-missing-grok-search-rs',
        args: [],
      },
      includeContent: false,
    },
    async (url) => {
      fetchedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => `
          <li class="b_algo">
            <h2><a href="https://example.com/bing-fallback">Bing Fallback Result</a></h2>
          </li>
        `,
      };
    },
  );

  assert.equal(result.provider, 'bing');
  assert.equal(result.fallbackFrom, 'mcp');
  assert.match(result.fallbackError, /MCP tool command not found: definitely-missing-grok-search-rs/);
  assert.deepEqual(result.fallbackProviders, ['bing', 'duckduckgo']);
  assert.deepEqual(result.results, [
    { title: 'Bing Fallback Result', url: 'https://example.com/bing-fallback' },
  ]);
  assert.equal(fetchedUrls.every((url) => url.startsWith('https://www.bing.com/search')), true);
});

test('webSearch MCP falls back through Bing to DuckDuckGo when MCP returns a provider error', async () => {
  const fetchedUrls = [];
  const result = await webSearch(
    {
      query: 'latest news',
      provider: 'mcp',
      mcp: {
        command: 'grok-search-rs',
        args: [],
      },
      includeContent: false,
    },
    async (url) => {
      fetchedUrls.push(String(url));
      if (String(url).startsWith('https://www.bing.com/search')) {
        throw new Error('Bing network error');
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<a class="result__a" href="https://example.com/duck-fallback">DuckDuckGo Fallback Result</a>',
      };
    },
    async () => ({
      ok: false,
      error: 'grok_provider_error',
      message: 'Grok provider failed',
      results: [],
    }),
  );

  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.fallbackFrom, 'mcp');
  assert.match(result.fallbackError, /grok_provider_error/);
  assert.deepEqual(result.fallbackProviders, ['bing', 'duckduckgo']);
  assert.deepEqual(result.results, [
    { title: 'DuckDuckGo Fallback Result', url: 'https://example.com/duck-fallback' },
  ]);
  assert.equal(fetchedUrls.some((url) => url.startsWith('https://www.bing.com/search')), true);
  assert.equal(fetchedUrls.some((url) => url.startsWith('https://html.duckduckgo.com/html/')), true);
});

test('webSearch MCP falls back when the MCP content text contains a provider error JSON', async () => {
  const result = await webSearch(
    {
      query: 'latest news',
      provider: 'mcp',
      mcp: {
        command: 'grok-search-rs',
        args: [],
      },
      includeContent: false,
    },
    async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => `
        <li class="b_algo">
          <h2><a href="https://example.com/bing-content-error-fallback">Bing Content Error Fallback</a></h2>
        </li>
      `,
    }),
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: 'grok_provider_error',
            message: 'Grok provider failed',
            sources_count: 0,
            results: [],
          }),
        },
      ],
    }),
  );

  assert.equal(result.provider, 'bing');
  assert.equal(result.fallbackFrom, 'mcp');
  assert.match(result.fallbackError, /grok_provider_error/);
  assert.deepEqual(result.fallbackProviders, ['bing', 'duckduckgo']);
  assert.deepEqual(result.results, [
    { title: 'Bing Content Error Fallback', url: 'https://example.com/bing-content-error-fallback' },
  ]);
});

test('webSearch MCP falls back when MCP returns an empty source result without an error field', async () => {
  const result = await webSearch(
    {
      query: 'latest news',
      provider: 'mcp',
      mcp: {
        command: 'grok-search-rs',
        args: [],
      },
      includeContent: false,
    },
    async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => `
        <li class="b_algo">
          <h2><a href="https://example.com/bing-empty-mcp-fallback">Bing Empty MCP Fallback</a></h2>
        </li>
      `,
    }),
    async () => ({
      content: [
        {
          type: 'text',
          text: 'Grok Responses search did not return a verifiable answer. Source fallback returned 0 source(s).',
        },
      ],
      sources: [],
    }),
  );

  assert.equal(result.provider, 'bing');
  assert.equal(result.fallbackFrom, 'mcp');
  assert.match(result.fallbackError, /empty results|0 source/);
  assert.deepEqual(result.fallbackProviders, ['bing', 'duckduckgo']);
  assert.deepEqual(result.results, [
    { title: 'Bing Empty MCP Fallback', url: 'https://example.com/bing-empty-mcp-fallback' },
  ]);
});

test('webSearch MCP skips empty Bing fallback results and tries DuckDuckGo', async () => {
  const fetchedUrls = [];
  const result = await webSearch(
    {
      query: 'latest news',
      provider: 'mcp',
      mcp: {
        command: 'grok-search-rs',
        args: [],
      },
      includeContent: false,
    },
    async (url) => {
      fetchedUrls.push(String(url));
      if (String(url).startsWith('https://www.bing.com/search')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => 'text/html; charset=utf-8' },
          text: async () => '<html><body>No results</body></html>',
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<a class="result__a" href="https://example.com/duck-after-empty">DuckDuckGo After Empty</a>',
      };
    },
    async () => ({
      ok: false,
      error: 'grok_provider_error',
      results: [],
    }),
  );

  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.fallbackFrom, 'mcp');
  assert.match(result.fallbackError, /grok_provider_error/);
  assert.deepEqual(result.results, [
    { title: 'DuckDuckGo After Empty', url: 'https://example.com/duck-after-empty' },
  ]);
  assert.equal(fetchedUrls.some((url) => url.startsWith('https://www.bing.com/search')), true);
  assert.equal(fetchedUrls.some((url) => url.startsWith('https://html.duckduckgo.com/html/')), true);
});

test('diskInfo returns Windows logical disk capacity information', async () => {
  const result = await diskInfo();

  assert.equal(Array.isArray(result.disks), true);
  assert.ok(result.disks.length > 0);
  assert.equal(typeof result.disks[0].deviceId, 'string');
  assert.equal(typeof result.disks[0].sizeBytes, 'number');
  assert.equal(typeof result.disks[0].freeBytes, 'number');
});

test('callTool dispatches disk_info requests', async () => {
  const result = await callTool('disk_info', {});

  assert.equal(Array.isArray(result.disks), true);
});

test('callTool dispatches directory_info requests with aggregate-only output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseekwebpp-directory-info-'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'abc');
  fs.writeFileSync(path.join(root, 'nested', 'b.txt'), '12345');

  const result = await callTool('directory_info', { path: root });

  assert.equal(result.path, root);
  assert.equal(result.totalBytes, 8);
  assert.equal(result.fileCount, 2);
  assert.equal(result.directoryCount, 1);
  assert.equal(result.errorCount, 0);
  assert.equal(Array.isArray(result.entries), false);
  assert.equal(Array.isArray(result.files), false);
});

test('native tools are registered through a single handler table', () => {
  assert.equal(typeof TOOL_HANDLERS.list_files, 'function');
  assert.equal(typeof TOOL_HANDLERS.directory_info, 'function');
  assert.equal(typeof TOOL_HANDLERS.weather, 'function');
  assert.equal(typeof TOOL_HANDLERS.world_time, 'function');
  assert.equal(TOOL_HANDLERS[['send', 'keys'].join('_')], undefined);
});

test('callTool dispatches world_time requests', async () => {
  const result = await callTool('world_time', {});

  assert.equal(result.timeZone, 'Asia/Shanghai');
});

test('weather queries current weather for default local location', async () => {
  const requestedUrls = [];
  const result = await weather(
    {},
    async (url) => {
      requestedUrls.push(String(url));
      if (String(url).startsWith('https://ipwho.is/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            city: 'Shanghai',
            country: 'China',
            latitude: 31.23,
            longitude: 121.47,
            timezone: { id: 'Asia/Shanghai' },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          current: {
            time: '2026-06-22T15:00',
            temperature_2m: 28.4,
            apparent_temperature: 31.2,
            relative_humidity_2m: 72,
            weather_code: 3,
            wind_speed_10m: 9.5,
          },
        }),
      };
    },
  );

  assert.equal(result.defaulted, true);
  assert.equal(result.location.name, 'Shanghai');
  assert.equal(result.location.timezone, 'Asia/Shanghai');
  assert.equal(result.current.temperatureC, 28.4);
  assert.equal(result.current.weatherText, '阴');
  assert.equal(requestedUrls.some((url) => url.includes('api.open-meteo.com/v1/forecast')), true);
});

test('weather geocodes named locations before querying forecast', async () => {
  const result = await weather(
    { location: '东京' },
    async (url) => {
      if (String(url).includes('geocoding-api.open-meteo.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [{
              name: 'Tokyo',
              country: 'Japan',
              latitude: 35.68,
              longitude: 139.76,
              timezone: 'Asia/Tokyo',
            }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          current: {
            time: '2026-06-22T16:00',
            temperature_2m: 30,
            apparent_temperature: 33,
            relative_humidity_2m: 65,
            weather_code: 1,
            wind_speed_10m: 8,
          },
        }),
      };
    },
  );

  assert.equal(result.defaulted, false);
  assert.equal(result.location.name, 'Tokyo');
  assert.equal(result.location.country, 'Japan');
  assert.equal(result.current.weatherText, '大致晴朗');
});

test('worldTime defaults to Beijing time and geocodes named locations', async () => {
  const beijing = await worldTime({}, null, new Date('2026-06-22T08:00:00Z'));

  assert.equal(beijing.defaulted, true);
  assert.equal(beijing.location.name, '北京');
  assert.equal(beijing.timeZone, 'Asia/Shanghai');
  assert.equal(beijing.date, '2026/06/22');
  assert.equal(beijing.time, '16:00:00');

  const paris = await worldTime(
    { location: 'Paris' },
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          name: 'Paris',
          country: 'France',
          latitude: 48.85,
          longitude: 2.35,
          timezone: 'Europe/Paris',
        }],
      }),
    }),
    new Date('2026-06-22T08:00:00Z'),
  );

  assert.equal(paris.defaulted, false);
  assert.equal(paris.location.name, 'Paris');
  assert.equal(paris.timeZone, 'Europe/Paris');
});

test('weather and worldTime use fallback geocoding for Chinese location names', async () => {
  const requestedUrls = [];
  const fetchLocation = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes('geocoding-api.open-meteo.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      };
    }
    if (String(url).includes('nominatim.openstreetmap.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          display_name: 'New York, United States',
          lat: '40.7128',
          lon: '-74.0060',
          address: { country: 'United States' },
        }]),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        timezone: 'America/New_York',
        current: {
          time: '2026-06-22T04:00',
          temperature_2m: 20,
          apparent_temperature: 21,
          relative_humidity_2m: 60,
          weather_code: 0,
          wind_speed_10m: 5,
        },
      }),
    };
  };
  const newYorkTime = await worldTime(
    { location: '纽约' },
    fetchLocation,
    new Date('2026-06-22T08:00:00Z'),
  );

  assert.equal(newYorkTime.defaulted, false);
  assert.equal(newYorkTime.location.name, 'New York');
  assert.equal(newYorkTime.timeZone, 'America/New_York');

  const newYorkWeather = await weather(
    { location: '纽约' },
    fetchLocation,
  );

  assert.equal(newYorkWeather.location.name, 'New York');
  assert.equal(newYorkWeather.location.timezone, 'America/New_York');
  assert.equal(newYorkWeather.current.weatherText, '晴');
  assert.equal(requestedUrls.some((url) => url.includes('nominatim.openstreetmap.org')), true);
});

test('webFetch reads URL text content', async () => {
  const result = await webFetch({ url: 'data:text/plain,hello%20web' });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello web');
});

test('webFetch uses DuckDuckGo browser headers only for DuckDuckGo URLs', async () => {
  const calls = [];
  await webFetch(
    { url: 'https://html.duckduckgo.com/html/?q=test' },
    async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        url,
        text: async () => 'duck',
      };
    },
  );
  await webFetch(
    { url: 'https://www.bing.com/search?q=test' },
    async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        url,
        text: async () => 'bing',
      };
    },
  );

  assert.match(calls[0].options.headers['User-Agent'], /Mozilla\/5\.0/);
  assert.equal(calls[1].options.headers, undefined);
});

test('webSearch parses search result links', async () => {
  const result = await webSearch(
    { query: 'agent tools', includeContent: false },
    async () => ({
      ok: true,
      status: 200,
      url: 'https://duckduckgo.com/html/',
      text: async () => '<a class="result__a" href="https://example.com/a">Agent Tools</a>',
    }),
  );

  assert.deepEqual(result.results, [{ title: 'Agent Tools', url: 'https://example.com/a' }]);
});

test('webSearch defaults to twenty results', async () => {
  const links = Array.from({ length: 25 }, (_, index) => (
    `<a class="result__a" href="https://example.com/${index}">Result ${index}</a>`
  )).join('');
  const result = await webSearch(
    { query: 'many results', includeContent: false },
    async () => ({
      ok: true,
      status: 200,
      url: 'https://duckduckgo.com/html/',
      text: async () => links,
    }),
  );

  assert.equal(result.results.length, 20);
  assert.equal(result.results.at(-1).title, 'Result 19');
  assert.equal(result.provider, 'duckduckgo');
});

test('webSearch supports DuckDuckGo preset without API keys', async () => {
  const fetchedUrls = [];
  const fetchOptions = [];
  const result = await webSearch(
    { query: 'rust mcp search', provider: 'duckduckgo', includeContent: false, limit: 2 },
    async (url, options) => {
      fetchedUrls.push(String(url));
      fetchOptions.push(options || {});
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<a class="result__a" href="https://example.com/ddg">Duck result</a>',
      };
    },
  );

  assert.match(fetchedUrls[0], /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
  assert.match(fetchOptions[0].headers['User-Agent'], /Mozilla\/5\.0/);
  assert.match(fetchOptions[0].headers['Accept-Language'], /zh-CN/);
  assert.equal(result.provider, 'duckduckgo');
  assert.deepEqual(result.results, [
    { title: 'Duck result', url: 'https://example.com/ddg' },
  ]);
});

test('webSearch parses Bing result snippets and numeric entities', async () => {
  const fetchedUrls = [];
  const result = await webSearch(
    { query: 'world cup schedule' },
    async (url) => {
      fetchedUrls.push(String(url));
      if (String(url).includes('example.com/schedule')) {
        return {
          ok: true,
          status: 200,
          url: 'https://example.com/schedule',
          headers: { get: () => 'text/html; charset=utf-8' },
          text: async () => `
            <html>
              <head><title>ignored</title><style>.x{}</style></head>
              <body>
                <main>
                  <h1>2026年世界杯6月22日赛程</h1>
                  <p>北京时间6月22日将进行多场小组赛，页面按日期列出对阵双方、开球时间和比赛城市。</p>
                  <p>球迷可以根据日期筛选完整赛程，并查看小组赛与淘汰赛阶段结构。</p>
                </main>
              </body>
            </html>
          `,
        };
      }
      return {
        ok: true,
        status: 200,
        url: 'https://www.bing.com/search?q=world+cup+schedule',
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => `
          <li class="b_algo">
            <h2><a href="https://example.com/schedule">2026&#24180;世界杯赛程</a></h2>
            <div class="b_caption"><p>2 天之前&ensp;&#0183;&ensp;按日期查看每日比赛。</p></div>
          </li>
        `,
      };
    },
  );

  assert.deepEqual(result.results, [
    {
      title: '2026年世界杯赛程',
      url: 'https://example.com/schedule',
      date: '2 天之前',
      snippet: '2 天之前 · 按日期查看每日比赛。',
      excerpt: '2026年世界杯6月22日赛程 北京时间6月22日将进行多场小组赛，页面按日期列出对阵双方、开球时间和比赛城市。 球迷可以根据日期筛选完整赛程，并查看小组赛与淘汰赛阶段结构。',
    },
  ]);
  assert.equal(fetchedUrls.includes('https://example.com/schedule'), true);
  assert.match(result.guidance, /answer from these search results/i);
  assert.match(result.guidance, /do not call web_fetch/i);
});

test('webSearch extracts English relative dates from Bing snippets', async () => {
  const result = await webSearch(
    { query: 'latest news', provider: 'bing', includeContent: false },
    async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => `
        <li class="b_algo">
          <h2><a href="https://example.com/news">Latest News</a></h2>
          <div class="b_caption"><p>1 day ago &ensp;&#0183;&ensp;World news summary.</p></div>
        </li>
      `,
    }),
  );

  assert.equal(result.results[0].date, '1 day ago');
});

test('webSearch retries transient Bing request errors without changing provider', async () => {
  const fetchedUrls = [];
  const result = await webSearch(
    { query: 'latest news', provider: 'bing', includeContent: false },
    async (url) => {
      fetchedUrls.push(String(url));
      if (fetchedUrls.length === 1) {
        throw new Error('EOF');
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => `
          <li class="b_algo">
            <h2><a href="https://example.com/news">Latest News</a></h2>
          </li>
        `,
      };
    },
  );

  assert.equal(result.provider, 'bing');
  assert.equal(result.fallbackFrom, undefined);
  assert.deepEqual(result.results, [
    { title: 'Latest News', url: 'https://example.com/news' },
  ]);
  assert.equal(fetchedUrls.length, 2);
  assert.equal(fetchedUrls.every((url) => url.startsWith('https://www.bing.com/search')), true);
});

test('webSearch normalizes Bing and DuckDuckGo redirect result URLs', async () => {
  const bingTarget = 'https://example.com/bing-source';
  const bingEncodedTarget = Buffer.from(bingTarget, 'utf8').toString('base64url');
  const bingFetchedUrls = [];
  const bingResult = await webSearch(
    { query: 'source lookup', provider: 'bing' },
    async (url) => {
      bingFetchedUrls.push(String(url));
      if (String(url) === bingTarget) {
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => 'text/html; charset=utf-8' },
          text: async () => '<main><p>Bing source page content.</p></main>',
        };
      }
      return {
        ok: true,
        status: 200,
        url: 'https://www.bing.com/search?q=source+lookup',
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => `
          <li class="b_algo">
            <h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1${bingEncodedTarget}&ntb=1">Bing Source</a></h2>
            <div class="b_caption"><p>Useful source snippet.</p></div>
          </li>
        `,
      };
    },
  );

  assert.equal(bingResult.results[0].url, bingTarget);
  assert.equal(bingFetchedUrls.includes(bingTarget), true);
  assert.equal(bingResult.results[0].excerpt, 'Bing source page content.');

  const duckResult = await webSearch(
    { query: 'source lookup', provider: 'duckduckgo', includeContent: false },
    async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => `
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fduck-source&rut=abc">Duck Source</a>
      `,
    }),
  );

  assert.deepEqual(duckResult.results, [
    { title: 'Duck Source', url: 'https://example.com/duck-source' },
  ]);
});

test('webSearch can delegate to a stdio MCP web_search tool', async () => {
  const calls = [];
  const result = await webSearch(
    {
      query: 'today sports',
      provider: 'mcp',
      mcp: {
        mcpServers: {
          'grok-search-rs': {
            command: 'grok-search-rs',
            args: [],
            env: { GROK_SEARCH_AUTH_MODE: 'oauth' },
          },
        },
        server: 'grok-search-rs',
        tool: 'web_search',
        timeoutMs: 60000,
        arguments: {
          response_format: 'detailed',
          include_content: true,
        },
      },
    },
    async () => {
      throw new Error('MCP provider must not fetch a search engine HTML page');
    },
    async (mcp, tool, toolArgs) => {
      calls.push({ mcp, tool, toolArgs });
      return {
        content: '有两场比赛。',
        search_provider: 'grok_search_rs',
        sources: [{ title: '赛程', url: 'https://example.com/sports' }],
      };
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'web_search');
  assert.equal(calls[0].mcp.command, 'grok-search-rs');
  assert.deepEqual(calls[0].mcp.env, { GROK_SEARCH_AUTH_MODE: 'oauth' });
  assert.deepEqual(calls[0].toolArgs, {
    response_format: 'detailed',
    include_content: true,
    query: 'today sports',
  });
  assert.equal(result.provider, 'mcp');
  assert.equal(result.mcpTool, 'web_search');
  assert.equal(result.result.content, '有两场比赛。');
});

test('native host does not expose global keyboard simulation', () => {
  const source = fs.readFileSync('native-host/tools.js', 'utf8');

  assert.equal(TOOL_HANDLERS[['send', 'keys'].join('_')], undefined);
  assert.doesNotMatch(source, /System\.Windows\.Forms/);
  assert.doesNotMatch(source, new RegExp(['Send', 'Wait'].join('')));
});

test('MCP command shims run through the Windows command shell when needed', () => {
  const source = fs.readFileSync('native-host/tools.js', 'utf8');

  assert.match(source, /const needsShell = process\.platform === 'win32'/);
  assert.match(source, /cmd\|bat/);
  assert.match(source, /shell:\s*needsShell/);
});
