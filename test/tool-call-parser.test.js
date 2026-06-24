const assert = require('node:assert/strict');
const test = require('node:test');
const { parseToolCall, parseToolCalls } = require('../extension/tool-call-parser');

test('parseToolCall extracts tool_call JSON from fenced code block', () => {
  const call = parseToolCall(`
please wait
\`\`\`json
{"tool_call":{"tool":"list_files","args":{"path":"C:\\\\Users"}}}
\`\`\`
`);

  assert.deepEqual(call, {
    tool: 'list_files',
    args: { path: 'C:\\Users' },
  });
});

test('parseToolCall returns null when no valid tool call exists', () => {
  assert.equal(parseToolCall('plain reply'), null);
});

test('parseToolCall extracts inline tool_call JSON from surrounding text', () => {
  const call = parseToolCall('ok {"tool_call":{"tool":"list_files","args":{"path":"F:\\\\"}}}');

  assert.deepEqual(call, {
    tool: 'list_files',
    args: { path: 'F:\\' },
  });
});

test('parseToolCall repairs a tool_call JSON object missing trailing braces', () => {
  const call = parseToolCall(
    '{"tool_call":{"tool":"remove_path","args":{"path":"F:\\\\MyProjects\\\\tests\\\\x.png","recursive":false,"force":false}}',
  );

  assert.deepEqual(call, {
    tool: 'remove_path',
    args: {
      path: 'F:\\MyProjects\\tests\\x.png',
      recursive: false,
      force: false,
    },
  });
});

test('parseToolCall repairs common almost-json variants from LLM output', () => {
  const call = parseToolCall(`
json
{tool_call:{tool:'remove_path',args:{path:'F:\\\\MyProjects\\\\tests\\\\x.png',recursive:false,force:false,},},}
`);

  assert.deepEqual(call, {
    tool: 'remove_path',
    args: {
      path: 'F:\\MyProjects\\tests\\x.png',
      recursive: false,
      force: false,
    },
  });
});

test('parseToolCall ignores tool_call embedded in visible reasoning prose', () => {
  const call = parseToolCall(`
I need to use web_search for this.
json
{"tool_call":{"tool":"web_search","args":{"query":"today sports","limit":8}}}
Then I will summarize.
`);

  assert.equal(call, null);
});

test('parseToolCall accepts deep-thinking prose when the tool_call is the final action', () => {
  const call = parseToolCall(`
我们收到用户查询："今天世界杯比赛的比分"。需要提供今天（2026年6月23日）的世界杯比赛比分。我们需要搜索最新的世界杯比赛信息。

由于是2026年6月23日，可能是2026年世界杯。我们需要搜索今天的比赛和比分。

使用web_search工具来搜索。使用Bing搜索。

json
{"tool_call":{"tool":"web_search","args":{"query":"2026年6月23日 世界杯 比赛 比分","limit":10}}}
`);

  assert.deepEqual(call, {
    tool: 'web_search',
    args: { query: '2026年6月23日 世界杯 比赛 比分', limit: 10 },
  });
});

test('parseToolCall accepts a bare json-prefixed tool_call block', () => {
  const call = parseToolCall(`
json
{"tool_call":{"tool":"web_search","args":{"query":"today sports","limit":8}}}
`);

  assert.deepEqual(call, {
    tool: 'web_search',
    args: { query: 'today sports', limit: 8 },
  });
});

test('parseToolCalls extracts multiple tool_call JSON objects from one response', () => {
  const calls = parseToolCalls(`
\`\`\`json
{"tool_call":{"tool":"run_program","args":{"executable":"calc","args":[],"timeoutMs":30000,"wait":false}}}
{"tool_call":{"tool":"run_program","args":{"executable":"mspaint","args":[],"timeoutMs":30000,"wait":false}}}
\`\`\`
`);

  assert.deepEqual(calls, [
    {
      tool: 'run_program',
      args: { executable: 'calc', args: [], timeoutMs: 30000, wait: false },
    },
    {
      tool: 'run_program',
      args: { executable: 'mspaint', args: [], timeoutMs: 30000, wait: false },
    },
  ]);
});

test('parseToolCalls repairs Windows paths with unescaped backslashes', () => {
  const calls = parseToolCalls(String.raw`
{"tool_call":{"tool":"list_files","args":{"path":"F:\MyProjects\tests"}}}
{"tool_call":{"tool":"disk_info","args":{}}}
`);

  assert.deepEqual(calls, [
    { tool: 'list_files', args: { path: 'F:\\MyProjects\\tests' } },
    { tool: 'disk_info', args: {} },
  ]);
});

test('parseToolCall repairs a single Windows path with unescaped backslashes', () => {
  const call = parseToolCall(String.raw`{"tool_call":{"tool":"list_files","args":{"path":"F:\MyProjects"}}}`);

  assert.deepEqual(call, {
    tool: 'list_files',
    args: { path: 'F:\\MyProjects' },
  });
});

test('parseToolCall repairs a write_file Windows path without corrupting quoted content', () => {
  const call = parseToolCall(String.raw`{"tool_call":{"tool":"write_file","args":{"path":"F:\MyProjects\tests\hello_world.py","content":"import base64;exec(base64.b64decode(b'cHJpbnQoIkhlbGxvLCB3b3JsZCEiKQ==').decode())"}}}`);

  assert.deepEqual(call, {
    tool: 'write_file',
    args: {
      path: 'F:\\MyProjects\\tests\\hello_world.py',
      content: "import base64;exec(base64.b64decode(b'cHJpbnQoIkhlbGxvLCB3b3JsZCEiKQ==').decode())",
    },
  });
});

test('parseToolCall repairs a write_file content string with unescaped double quotes', () => {
  const call = parseToolCall(String.raw`{"tool_call":{"tool":"write_file","args":{"path":"F:\MyProjects\tests\hello_world.py","content":"(lambda __g, __print: __print("Hello, world!"))(globals(), import('builtins').print)\n"}}}`);

  assert.deepEqual(call, {
    tool: 'write_file',
    args: {
      path: 'F:\\MyProjects\\tests\\hello_world.py',
      content: `(lambda __g, __print: __print("Hello, world!"))(globals(), import('builtins').print)\n`,
    },
  });
});

test('parseToolCalls extracts multiple different tools from one fenced JSON block', () => {
  const calls = parseToolCalls(`
\`\`\`json
{"tool_call":{"tool":"web_search","args":{"query":"A÷ AI公司"}}}
{"tool_call":{"tool":"world_time","args":{"location":"Paris"}}}
{"tool_call":{"tool":"weather","args":{"location":"London"}}}
\`\`\`
`);

  assert.deepEqual(calls, [
    { tool: 'web_search', args: { query: 'A÷ AI公司' } },
    { tool: 'world_time', args: { location: 'Paris' } },
    { tool: 'weather', args: { location: 'London' } },
  ]);
});

test('parseToolCalls extracts mixed malformed fenced and bare tool calls from transcript text', () => {
  const calls = parseToolCalls(`
搜索为什么A÷是某公司 巴黎时间和伦敦天气是什么

\`\`\`json
{"tool_call":{"tool":"web_search","args":{"query":"A÷ 某公司 品牌"}}
\`\`\`
{"tool_call":{"tool":"world_time","args":{"location":"Paris"}}}
{"tool_call":{"tool":"weather","args":{"location":"London"}}}
\`\`\`

请基于工具结果回答

关于您搜索的“A÷是某公司”，由于这个符号和表述比较特殊，搜索结果没有返回明确的关联信息。
以下是您查询的另外两项信息：
1. 巴黎时间
2. 伦敦天气
关于伦敦的天气查询暂时没有获取到有效结果。
`);

  assert.deepEqual(calls, [
    { tool: 'web_search', args: { query: 'A÷ 某公司 品牌' } },
    { tool: 'world_time', args: { location: 'Paris' } },
    { tool: 'weather', args: { location: 'London' } },
  ]);
});

test('parseToolCalls extracts a tool_calls array', () => {
  const calls = parseToolCalls(`
\`\`\`json
{"tool_calls":[
  {"tool":"run_program","args":{"executable":"calc","args":[],"timeoutMs":30000,"wait":false}},
  {"tool":"run_program","args":{"executable":"mspaint","args":[],"timeoutMs":30000,"wait":false}}
]}
\`\`\`
`);

  assert.deepEqual(calls.map((call) => call.args.executable), ['calc', 'mspaint']);
});

test('parseToolCalls waits for a tool_calls array to close before extracting calls', () => {
  const calls = parseToolCalls(`{
  "tool_calls": [
    {
      "tool": "web_search",
      "args": {
        "query": "A÷ AI公司",
        "limit": 10
      }
    }`);

  assert.deepEqual(calls, []);
});

test('parseToolCalls extracts different tools from a tool_calls array', () => {
  const calls = parseToolCalls(`
\`\`\`json
{"tool_calls":[
  {"tool":"world_time","args":{}},
  {"tool":"weather","args":{}}
]}
\`\`\`
`);

  assert.deepEqual(calls, [
    { tool: 'world_time', args: {} },
    { tool: 'weather', args: {} },
  ]);
});

test('parseToolCalls extracts XML wrapped tool_call entries', () => {
  const calls = parseToolCalls(`
<tool_calls>
<tool_call name="web_search">{"query": "为什么A/S是某公司", "limit": 10}</tool_call>
<tool_call name="world_time">{"location": "Washington DC"}</tool_call>
<tool_call name="weather">{"location": "Washington DC"}</tool_call>
</tool_calls>
`);

  assert.deepEqual(calls, [
    { tool: 'web_search', args: { query: '为什么A/S是某公司', limit: 10 } },
    { tool: 'world_time', args: { location: 'Washington DC' } },
    { tool: 'weather', args: { location: 'Washington DC' } },
  ]);
});

test('parseToolCall extracts markdown Calling and Arguments blocks', () => {
  const call = parseToolCall([
    '**Calling:** `read_file`',
    String.raw`**Arguments:** {"path":"F:\\MyProjects\\tests\\hello_world.py"}`,
  ].join('\n'));

  assert.deepEqual(call, {
    tool: 'read_file',
    args: { path: 'F:\\MyProjects\\tests\\hello_world.py' },
  });
});

test('parseToolCall repairs markdown Arguments with unescaped Windows paths', () => {
  const call = parseToolCall([
    '**Calling:** `read_file`',
    String.raw`**Arguments:** {"path":"F:\MyProjects\tests\hello_world.py"}`,
  ].join('\n'));

  assert.deepEqual(call, {
    tool: 'read_file',
    args: { path: 'F:\\MyProjects\\tests\\hello_world.py' },
  });
});
