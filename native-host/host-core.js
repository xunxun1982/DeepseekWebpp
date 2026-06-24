const { callTool } = require('./tools');

async function handleMessage(message, deps = {}) {
  const id = message && message.id;
  try {
    if (!message || message.type !== 'tool.call') {
      throw new Error(`Unsupported message type: ${message && message.type}`);
    }

    const result = await (deps.callTool || callTool)(message.tool, message.args || {});
    return { id, ok: true, result };
  } catch (error) {
    return {
      id,
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

module.exports = {
  handleMessage,
};
