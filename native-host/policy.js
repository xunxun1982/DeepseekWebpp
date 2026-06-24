const path = require('node:path');
const MUTATING_FILE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'remove_path',
  'make_dir',
  'multi_file_edit',
  'delete_file',
  'move_file',
  'copy_file',
]);
const PATH_SCOPED_TOOLS = new Set([
  'list_files',
  'directory_info',
  'read_file',
  'glob_search',
  'grep_search',
  'file_exists',
]);

function normalizeWindowsPath(value) {
  return path.win32.normalize(String(value || '')).replace(/[\\\/]+$/, '').toLowerCase();
}

function isPathInside(basePath, candidatePath) {
  const base = normalizeWindowsPath(basePath);
  const candidate = normalizeWindowsPath(candidatePath);
  return candidate === base || candidate.startsWith(`${base}\\`);
}

function ruleMatchesRequest(rule, request) {
  if (!rule || !request || rule.tool !== request.tool) {
    return false;
  }
  if (MUTATING_FILE_TOOLS.has(request.tool)) {
    return false;
  }

  const scope = rule.scope || {};
  if (scope.mode === 'any') {
    return true;
  }

  if (PATH_SCOPED_TOOLS.has(request.tool) && scope.mode === 'path') {
    return isPathInside(scope.path, getRequestPath(request));
  }

  if (request.tool === 'run_program' && scope.mode === 'program') {
    return (
      normalizeWindowsPath(scope.executable) ===
      normalizeWindowsPath(request.args && request.args.executable)
    );
  }

  return false;
}

function getRequestPath(request) {
  return request.args && (request.args.path || request.args.root);
}

module.exports = {
  ruleMatchesRequest,
  isPathInside,
};
