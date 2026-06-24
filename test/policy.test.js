const assert = require('node:assert/strict');
const test = require('node:test');
const { ruleMatchesRequest } = require('../native-host/policy');

test('path scoped readonly file rules allow child paths and deny siblings', () => {
  for (const tool of ['read_file', 'directory_info']) {
    const rule = {
      tool,
      scope: { mode: 'path', path: 'C:\\Users\\Alice\\Downloads' },
    };

    assert.equal(
      ruleMatchesRequest(rule, {
        tool,
        args: { path: 'C:\\Users\\Alice\\Downloads\\docs' },
      }),
      true,
    );

    assert.equal(
      ruleMatchesRequest(rule, {
        tool,
        args: { path: 'C:\\Users\\Alice\\Desktop' },
      }),
      false,
    );
  }
});

test('any scoped rule allows matching tool regardless of arguments', () => {
  const rule = { tool: 'list_files', scope: { mode: 'any' } };

  assert.equal(
    ruleMatchesRequest(rule, {
      tool: 'list_files',
      args: { path: 'D:\\Anything' },
    }),
    true,
  );
});

test('mutating file tools ignore whitelist rules and require confirmation', () => {
  for (const tool of ['write_file', 'edit_file', 'remove_path', 'make_dir', 'multi_file_edit', 'delete_file', 'move_file', 'copy_file']) {
    assert.equal(
      ruleMatchesRequest(
        { tool, scope: { mode: 'any' } },
        { tool, args: { path: 'C:\\Users\\Alice\\Desktop\\x.txt' } },
      ),
      false,
    );
  }
});

test('program scoped run_program rule matches exact executable only', () => {
  const rule = {
    tool: 'run_program',
    scope: { mode: 'program', executable: 'C:\\Tools\\app.exe' },
  };

  assert.equal(
    ruleMatchesRequest(rule, {
      tool: 'run_program',
      args: { executable: 'C:\\Tools\\app.exe', args: [] },
    }),
    true,
  );

  assert.equal(
    ruleMatchesRequest(rule, {
      tool: 'run_program',
      args: { executable: 'C:\\Tools\\other.exe', args: [] },
    }),
    false,
  );
});
