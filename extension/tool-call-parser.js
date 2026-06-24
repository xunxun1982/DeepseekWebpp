(function init(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DeepSeekToolParser = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function factory() {
  function parseToolCall(text) {
    return parseToolCalls(text)[0] || null;
  }

  function parseToolCalls(text) {
    const source = String(text || '');
    const fencedCandidates = [];
    const fenced = source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
    for (const match of fenced) {
      fencedCandidates.push(match[1]);
    }
    const jsonObjectCandidates = extractJsonObjects(source);
    const visibleReasoning = looksLikeVisibleReasoning(source);
    if (visibleReasoning && !hasExplicitToolCallCandidates(fencedCandidates, jsonObjectCandidates)) {
      return [];
    }

    const candidates = [...fencedCandidates, ...jsonObjectCandidates];
    if (!visibleReasoning) {
      candidates.push(source);
    }

    const calls = [];
    const seen = new Set();
    for (const call of extractXmlToolCalls(source)) {
      addCall(calls, seen, call);
    }
    for (const call of extractMarkdownToolCalls(source)) {
      addCall(calls, seen, call);
    }
    for (const candidate of candidates) {
      const variants = [candidate.trim(), repairJson(candidate)];
      for (const variant of variants) {
        if (!variant) {
          continue;
        }
        try {
          const parsed = JSON.parse(variant);
          for (const call of collectCalls(parsed)) {
            addCall(calls, seen, call);
          }
        } catch (_) {
          // Try next variant.
        }
      }
    }
    return calls;
  }

  function hasExplicitToolCallCandidates(fencedCandidates, jsonObjectCandidates) {
    return (
      fencedCandidates.some((candidate) => String(candidate || '').includes('tool_call')) ||
      jsonObjectCandidates.length > 1
    );
  }

  function addCall(calls, seen, call) {
    const key = JSON.stringify(call);
    if (!seen.has(key)) {
      seen.add(key);
      calls.push(call);
    }
  }

  function collectCalls(parsed) {
    const values = Array.isArray(parsed && parsed.tool_calls) ? parsed.tool_calls : [parsed && (parsed.tool_call || parsed)];
    return values
      .map((call) => {
        if (!call || typeof call.tool !== 'string') {
          return null;
        }
        return { tool: call.tool, args: call.args || {} };
      })
      .filter(Boolean);
  }

  function extractMarkdownToolCalls(source) {
    const value = String(source || '');
    if (!/\bCalling\s*:/i.test(value) || !/\bArguments\s*:/i.test(value)) {
      return [];
    }
    const calls = [];
    const callingPattern = /(?:^|\n)\s*(?:\*\*)?\s*Calling\s*:\s*(?:\*\*)?\s*`?([A-Za-z_][\w.-]*)`?/gi;
    let match = callingPattern.exec(value);
    while (match) {
      const tool = String(match[1] || '').trim();
      const segmentStart = callingPattern.lastIndex;
      const nextCalling = findNextMarkdownCalling(value, segmentStart);
      const segmentEnd = nextCalling === -1 ? value.length : nextCalling;
      const argsMarker = findMarkdownArgumentsMarker(value, segmentStart, segmentEnd);
      if (tool && argsMarker !== -1) {
        const objectStart = value.indexOf('{', argsMarker);
        if (objectStart !== -1 && objectStart < segmentEnd) {
          const rawArgs = readJsonObjectAt(value, objectStart, segmentEnd);
          const args = parseArgumentsObject(rawArgs);
          if (args) {
            calls.push({ tool, args });
          }
        }
      }
      callingPattern.lastIndex = segmentEnd;
      match = callingPattern.exec(value);
    }
    return calls;
  }

  function findNextMarkdownCalling(source, startIndex) {
    const match = /(?:^|\n)\s*(?:\*\*)?\s*Calling\s*:/i.exec(source.slice(startIndex));
    return match ? startIndex + match.index : -1;
  }

  function findMarkdownArgumentsMarker(source, startIndex, endIndex) {
    const segment = source.slice(startIndex, endIndex);
    const match = /(?:^|\n)\s*(?:\*\*)?\s*Arguments\s*:\s*(?:\*\*)?/i.exec(segment);
    return match ? startIndex + match.index + match[0].length : -1;
  }

  function readJsonObjectAt(source, startIndex, endIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = startIndex; index < endIndex; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(startIndex, index + 1);
        }
      }
    }
    return null;
  }

  function parseArgumentsObject(rawArgs) {
    if (!rawArgs) {
      return null;
    }
    const variants = [String(rawArgs).trim(), repairArgumentJson(rawArgs)];
    for (const variant of variants) {
      if (!variant) {
        continue;
      }
      try {
        const parsed = JSON.parse(variant);
        if (isPlainObject(parsed)) {
          return parsed;
        }
      } catch (_) {
        // Try next variant.
      }
    }
    return null;
  }

  function repairArgumentJson(candidate) {
    let value = String(candidate || '').trim();
    if (!value) {
      return null;
    }
    value = value
      .replace(/^json\s*/i, '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null');

    const start = value.indexOf('{');
    if (start > 0) {
      value = value.slice(start);
    }
    value = value.replace(/,\s*([}\]])/g, '$1');
    value = repairContentStringQuotes(value);
    value = quoteUnquotedKeys(value);
    value = replaceSingleQuotedStrings(value);
    value = escapeInvalidJsonStringBackslashes(value);
    value = closeOpenStructures(value);
    value = value.replace(/,\s*([}\]])/g, '$1');
    return value;
  }

  function extractXmlToolCalls(source) {
    if (!String(source || '').includes('<tool_call')) {
      return [];
    }
    const calls = [];
    const tagPattern = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi;
    let match = tagPattern.exec(source);
    while (match) {
      const tool = extractXmlToolName(match[1]);
      if (tool) {
        try {
          const args = JSON.parse(match[2].trim());
          if (isPlainObject(args)) {
            calls.push({ tool, args });
          }
        } catch (_) {
          // XML tool_call compatibility only accepts valid JSON argument bodies.
        }
      }
      match = tagPattern.exec(source);
    }
    return calls;
  }

  function extractXmlToolName(attributes) {
    const match = String(attributes || '').match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i);
    return match ? String(match[1] || match[2] || match[3] || '').trim() : '';
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function looksLikeVisibleReasoning(source) {
    const beforeMarker = source.slice(0, source.indexOf('tool_call'));
    const afterLastBrace = source.slice(source.lastIndexOf('}') + 1);
    return (
      beforeMarker.trim().length > 20 &&
      !/```(?:json)?\s*$/i.test(beforeMarker.trim()) &&
      !/^json\s*$/i.test(beforeMarker.trim()) &&
      /(?:I need|我需要|思考|用户|搜索|工具|然后|总结|基于)/i.test(beforeMarker) &&
      afterLastBrace.trim().length > 10
    );
  }

  function repairJson(candidate) {
    let value = String(candidate || '').trim();
    if (!value.includes('tool_call') && !value.includes('tool_calls')) {
      return null;
    }
    value = value
      .replace(/^json\s*/i, '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null');

    const start = value.indexOf('{');
    if (start > 0) {
      value = value.slice(start);
    }
    if (hasUnclosedToolCallsArray(value)) {
      return null;
    }
    value = value.replace(/,\s*([}\]])/g, '$1');
    value = repairContentStringQuotes(value);
    value = quoteUnquotedKeys(value);
    value = replaceSingleQuotedStrings(value);
    value = escapeInvalidJsonStringBackslashes(value);
    value = closeOpenStructures(value);
    value = value.replace(/,\s*([}\]])/g, '$1');
    return value;
  }

  function hasUnclosedToolCallsArray(value) {
    const keyIndex = String(value || '').indexOf('"tool_calls"');
    if (keyIndex === -1) {
      return false;
    }
    const arrayStart = findArrayStartAfter(value, keyIndex);
    if (arrayStart === -1) {
      return true;
    }
    return !isArrayClosed(value, arrayStart);
  }

  function findArrayStartAfter(value, startIndex) {
    let inString = false;
    let escaped = false;
    for (let index = startIndex; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString && char === '[') {
        return index;
      }
    }
    return -1;
  }

  function isArrayClosed(value, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = startIndex; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === '[') {
        depth += 1;
      } else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          return true;
        }
      }
    }
    return false;
  }

  function quoteUnquotedKeys(value) {
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        output += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        output += char;
        continue;
      }
      if (char !== '{' && char !== ',') {
        output += char;
        continue;
      }
      const quoted = readUnquotedKey(value, index);
      if (!quoted) {
        output += char;
        continue;
      }
      output += `${char}${quoted.leading}"${quoted.key}"${quoted.beforeColon}:`;
      index = quoted.endIndex;
    }
    return output;
  }

  function readUnquotedKey(value, delimiterIndex) {
    let index = delimiterIndex + 1;
    let leading = '';
    while (/\s/.test(value[index] || '')) {
      leading += value[index];
      index += 1;
    }
    const keyStart = index;
    if (!/[A-Za-z_$]/.test(value[index] || '')) {
      return null;
    }
    index += 1;
    while (/[\w$-]/.test(value[index] || '')) {
      index += 1;
    }
    const key = value.slice(keyStart, index);
    let beforeColon = '';
    while (/\s/.test(value[index] || '')) {
      beforeColon += value[index];
      index += 1;
    }
    if (value[index] !== ':') {
      return null;
    }
    return { leading, key, beforeColon, endIndex: index };
  }

  function replaceSingleQuotedStrings(value) {
    let output = '';
    let inDoubleString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (inDoubleString) {
        output += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inDoubleString = false;
        }
        continue;
      }
      if (char === '"') {
        inDoubleString = true;
        output += char;
        continue;
      }
      if (char !== "'") {
        output += char;
        continue;
      }
      const quoted = readSingleQuotedString(value, index);
      if (!quoted) {
        output += char;
        continue;
      }
      output += `"${quoted.inner.replace(/"/g, '\\"')}"`;
      index = quoted.endIndex;
    }
    return output;
  }

  function readSingleQuotedString(value, startIndex) {
    let inner = '';
    let escaped = false;
    for (let index = startIndex + 1; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        inner += `\\${char}`;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === "'") {
        return { inner, endIndex: index };
      }
      inner += char;
    }
    return null;
  }

  function repairContentStringQuotes(value) {
    const pattern = /("content"\s*:\s*")/g;
    let output = '';
    let cursor = 0;
    let match = pattern.exec(value);
    while (match) {
      const contentStart = pattern.lastIndex;
      const contentEnd = findContentStringEnd(value, contentStart);
      if (contentEnd === -1) {
        break;
      }
      output += value.slice(cursor, contentStart);
      output += value.slice(contentStart, contentEnd).replace(/"/g, '\\"');
      output += '"';
      cursor = contentEnd + 1;
      pattern.lastIndex = cursor;
      match = pattern.exec(value);
    }
    return output ? output + value.slice(cursor) : value;
  }

  function findContentStringEnd(value, startIndex) {
    let escaped = false;
    let candidate = -1;
    for (let index = startIndex; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"' && isLikelyJsonStringEnd(value, index)) {
        candidate = index;
      }
    }
    return candidate;
  }

  function isLikelyJsonStringEnd(value, quoteIndex) {
    let index = quoteIndex + 1;
    while (/\s/.test(value[index] || '')) {
      index += 1;
    }
    const next = value[index];
    if (next === '}' || next === ']') {
      return true;
    }
    if (next !== ',') {
      return false;
    }
    index += 1;
    while (/\s/.test(value[index] || '')) {
      index += 1;
    }
    return value[index] === '"' || /[A-Za-z_$}]/.test(value[index] || '');
  }

  function escapeInvalidJsonStringBackslashes(value) {
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (!inString) {
        output += char;
        if (char === '"') {
          inString = true;
        }
        continue;
      }
      if (escaped) {
        const shouldEscapeLiteralBackslash = !isJsonEscapeChar(char) || (char !== '\\' && isWindowsPathStringSoFar(output));
        output += shouldEscapeLiteralBackslash ? '\\\\' : '\\';
        output += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      output += char;
      if (char === '"') {
        inString = false;
      }
    }
    if (escaped) {
      output += '\\\\';
    }
    return output;
  }

  function isJsonEscapeChar(char) {
    return /["\\/bfnrtu]/.test(char);
  }

  function isWindowsPathStringSoFar(output) {
    const quoteIndex = output.lastIndexOf('"');
    const current = quoteIndex === -1 ? output : output.slice(quoteIndex + 1);
    return /(?:^|[^A-Za-z])[A-Za-z]:(?:\\\\|\\)?[^"]*$/.test(current);
  }

  function closeOpenStructures(value) {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if ((char === '}' || char === ']') && stack[stack.length - 1] === char) {
        stack.pop();
      }
    }
    return `${value}${stack.reverse().join('')}`;
  }

  function extractJsonObjects(source) {
    const results = [];
    const markerPattern = /"tool_calls?"/g;
    let match = markerPattern.exec(source);
    while (match) {
      const markerIndex = match.index;
      const start = source.lastIndexOf('{', markerIndex);
      if (start === -1) {
        break;
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) {
          continue;
        }
        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            results.push(source.slice(start, index + 1));
            break;
          }
        }
      }
      if (depth > 0 && !inString) {
        const partial = source.slice(start);
        if (!hasUnclosedToolCallsArray(partial)) {
          results.push(`${partial}${'}'.repeat(depth)}`);
        }
      }
      markerPattern.lastIndex = markerIndex + match[0].length;
      match = markerPattern.exec(source);
    }
    return results;
  }

  return { parseToolCall, parseToolCalls };
});
