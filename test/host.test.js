const assert = require('node:assert/strict');
const test = require('node:test');
const { handleMessage } = require('../native-host/host-core');

test('handleMessage dispatches tool.call requests', async () => {
  const response = await handleMessage(
    { id: '1', type: 'tool.call', tool: 'echo', args: { value: 42 } },
    {
      callTool: async (tool, args) => ({ tool, args }),
    },
  );

  assert.deepEqual(response, {
    id: '1',
    ok: true,
    result: { tool: 'echo', args: { value: 42 } },
  });
});

test('handleMessage returns structured errors for unknown message types', async () => {
  const response = await handleMessage({ id: '2', type: 'missing' });

  assert.equal(response.id, '2');
  assert.equal(response.ok, false);
  assert.match(response.error, /Unsupported message type/);
});
