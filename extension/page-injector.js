(function initDeepseekWebppBridge() {
  if (window.__DeepseekWebppBridge) {
    return;
  }

  const state = {
    enabled: false,
    prompt: '',
    queuedToolResults: [],
    lastUserTask: '',
  };

  window.__DeepseekWebppBridge = state;

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (
      !message ||
      message.source !== 'DeepseekWebpp' ||
      (message.type !== 'DSWEBPP_CONFIG' && message.type !== 'DSWEBPP_TOOL_RESULT' && message.type !== 'DSWEBPP_CLEAR_TOOL_RESULTS')
    ) {
      return;
    }
    if (message.type === 'DSWEBPP_CLEAR_TOOL_RESULTS') {
      state.queuedToolResults = [];
      return;
    }
    if (message.type === 'DSWEBPP_TOOL_RESULT') {
      state.queuedToolResults.push(message.result);
      return;
    }
    state.enabled = !!message.enabled;
    state.prompt = String(message.prompt || '');
  });

  window.postMessage(
    {
      source: 'DeepseekWebpp',
      type: 'DSWEBPP_REQUEST_CONFIG',
    },
    '*',
  );

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const next = await patchFetchArgs(input, init);
    return originalFetch.call(this, next.input, next.init);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    return originalSend.call(this, patchBody(body));
  };

  async function patchFetchArgs(input, init) {
    if (!state.enabled || !state.prompt) {
      return { input, init };
    }

    if (init && typeof init.body === 'string') {
      return { input, init: { ...init, body: patchBody(init.body) } };
    }

    if (input instanceof Request && !init) {
      const body = await input.clone().text().catch(() => null);
      if (typeof body === 'string' && body) {
        return { input: new Request(input, { body: patchBody(body) }), init };
      }
    }

    return { input, init };
  }

  function patchBody(body) {
    if (!state.enabled || !state.prompt || typeof body !== 'string' || !looksLikeChatPayload(body)) {
      return body;
    }

    try {
      const data = JSON.parse(body);
      if (!injectToolContext(data)) {
        return body;
      }
      return JSON.stringify(data);
    } catch (_) {
      return body;
    }
  }

  function looksLikeChatPayload(body) {
    return body.includes('chat') || body.includes('message') || body.includes('prompt') || body.includes('content');
  }

  function injectToolContext(value) {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const messages = findMessagesArray(value);
    if (messages) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message && message.role === 'user' && injectIntoMessageObject(message)) {
          return true;
        }
      }
    }

    return injectIntoMessageObject(value);
  }

  function findMessagesArray(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    if (Array.isArray(value.messages)) {
      return value.messages;
    }
    if (Array.isArray(value.conversation)) {
      return value.conversation;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const found = findMessagesArray(child);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  function injectIntoMessageObject(message) {
    for (const key of ['content', 'prompt', 'message', 'text', 'query', 'input']) {
      const context = buildToolContext();
      if (typeof message[key] === 'string' && message[key].trim() && !message[key].includes(context.slice(0, 24))) {
        const originalText = message[key];
        if (!state.queuedToolResults.length) {
          state.lastUserTask = originalText;
        }
        message[key] = `${context}\n\n用户消息：\n${originalText}`;
        state.queuedToolResults = [];
        notifyUserRequestSent();
        return true;
      }
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part.text === 'string' && part.text.trim()) {
          const originalText = part.text;
          const context = buildToolContext();
          if (!state.queuedToolResults.length) {
            state.lastUserTask = originalText;
          }
          part.text = `${context}\n\n用户消息：\n${originalText}`;
          state.queuedToolResults = [];
          notifyUserRequestSent();
          return true;
        }
      }
    }

    return false;
  }

  function buildToolContext() {
    const blocks = [`可调用工具上下文：\n${state.prompt}`];
    if (state.queuedToolResults.length) {
      blocks.push('本次请求已经包含工具结果。请优先基于这些结果直接回答用户；如果原始用户任务明确要求根据结果继续修改、写入、删除文件或运行验证命令，请继续只输出下一步 tool_call JSON，不要用自然语言假装已经执行；否则不要继续输出新的 tool_call。run_program wait:true 的验证结果会包含 exitCode、stdout、stderr、timedOut 或 error，无论成功还是失败都必须基于这些字段判断。结果为空或失败时，请说明失败原因和可选下一步。');
      if (state.lastUserTask) {
        blocks.push(`原始用户任务：\n${state.lastUserTask}`);
      }
      blocks.push(`已完成的工具调用结果：\n${JSON.stringify(state.queuedToolResults, null, 2)}`);
    }
    return blocks.join('\n\n');
  }

  function notifyUserRequestSent() {
    window.postMessage(
      {
        source: 'DeepseekWebpp',
        type: 'DSWEBPP_USER_REQUEST_SENT',
      },
      '*',
    );
  }

})();
