const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readProjectTextFiles(root) {
  const ignoredDirs = new Set(['.git', '.chrome-deepseekwebpp-profile', 'dist', 'node_modules']);
  const textExts = new Set(['.cmd', '.css', '.go', '.html', '.js', '.json', '.md', '.mod', '.ps1']);
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...readProjectTextFiles(fullPath));
      }
      continue;
    }
    if (textExts.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function readProjectPaths(root) {
  const ignoredDirs = new Set(['.git', '.chrome-deepseekwebpp-profile', 'dist', 'node_modules']);
  const paths = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    paths.push(fullPath);
    if (entry.isDirectory() && !ignoredDirs.has(entry.name)) {
      paths.push(...readProjectPaths(fullPath));
    }
  }
  return paths;
}

function assertOrderedIncludes(text, values) {
  let previousIndex = -1;
  for (const value of values) {
    const index = text.indexOf(value);
    assert.notEqual(index, -1, `${value} is missing`);
    assert.ok(index > previousIndex, `${value} is out of order`);
    previousIndex = index;
  }
}

test('content script asks background to open the options page', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(content, /type:\s*['"]options\.open['"]/);
  assert.match(content, /optionsButton\.addEventListener\('click',\s*\(\) => openOptionsPageFromPanel\(\)\)/);
  assert.match(content, /whitelistButton\.addEventListener\('click',\s*\(\) => openOptionsPageFromPanel\('whitelist'\)\)/);
  assert.match(content, /section \? \{ type: 'options\.open', section \} : \{ type: 'options\.open' \}/);
  assert.doesNotMatch(content, /chrome\.runtime\.openOptionsPage/);
  assert.match(background, /message\.type === ['"]options\.open['"]/);
  assert.match(background, /if \(message\.section\) \{/);
  assert.match(background, /chrome\.tabs\.create\(\{\s*url:\s*chrome\.runtime\.getURL\(`options\.html#\$\{encodeURIComponent\(message\.section\)\}`\)\s*\}/);
  assert.match(background, /chrome\.runtime\.openOptionsPage/);
});

test('content script avoids innerHTML writes in the page DOM', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');

  assert.doesNotMatch(content, /\.innerHTML\s*=/);
});

test('native host allows the currently loaded extension origin', () => {
  const manifest = JSON.parse(
    fs.readFileSync('native-host/com.deepseekwebpp.native_host.json', 'utf8'),
  );

  assert.equal(manifest.name, 'com.deepseekwebpp.native_host');
  assert.match(manifest.path, /deepseekwebpp-host\.exe$/);
  assert.equal(manifest.allowed_origins.length, 1);
  assert.match(manifest.allowed_origins[0], /^chrome-extension:\/\/[a-p]{32}\/$/);
});

test('extension branding uses DeepseekWeb++ across user-facing surfaces', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
  const nativeManifest = JSON.parse(fs.readFileSync('native-host/com.deepseekwebpp.native_host.json', 'utf8'));
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const optionsHtml = fs.readFileSync('extension/options.html', 'utf8');
  const readme = fs.readFileSync('README.md', 'utf8');

  assert.equal(manifest.name, 'DeepseekWeb++');
  assert.match(manifest.description, /DeepseekWeb\+\+/);
  assert.match(nativeManifest.description, /DeepseekWeb\+\+/);
  assert.match(content, /DeepseekWeb\+\+/);
  assert.match(optionsHtml, /DeepseekWeb\+\+/);
  assert.match(readme, /^# DeepseekWeb\+\+/m);
  assert.doesNotMatch(readme, new RegExp('deepseek' + '-pp', 'i'));
}
);

test('project ships GPLv3 license and compatible icon notices', () => {
  const license = fs.readFileSync('LICENSE', 'utf8');
  const notices = fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const packageScript = fs.readFileSync('scripts/package-release.ps1', 'utf8');

  assert.match(license, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 29 June 2007/);
  assert.equal(packageJson.license, 'GPL-3.0-only');
  assert.match(notices, /Lucide/);
  assert.match(notices, /ISC License/);
  assert.match(packageScript, /'LICENSE'/);
  assert.match(packageScript, /'THIRD_PARTY_NOTICES\.md'/);
});

test('extension manifest declares generated product icons', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));

  assert.deepEqual(manifest.icons, {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  });
  for (const size of [16, 48, 128]) {
    assert.equal(fs.existsSync(`extension/icons/icon-${size}.png`), true);
  }
  assert.equal(fs.existsSync('extension/icons/icon.svg'), true);
});

test('native host installer prefers the portable exe over the development cmd fallback', () => {
  const script = fs.readFileSync('scripts/install-native-host.ps1', 'utf8');
  const readme = fs.readFileSync('README.md', 'utf8');

  assert.match(script, /deepseekwebpp-host\.exe/);
  assert.match(script, /deepseekwebpp-host\.cmd/);
  assert.match(script, /function Get-NativeHostCandidatePaths/);
  assert.match(script, /bin\\windows-amd64\\deepseekwebpp-host\.exe/);
  assert.match(script, /bin\\windows-386\\deepseekwebpp-host\.exe/);
  assert.match(readme, /仅用于 Windows 系统|仅支持 Windows/);
  assert.match(readme, /windows-amd64\\deepseekwebpp-host\.exe/);
  assert.match(readme, /windows-386\\deepseekwebpp-host\.exe/);
  assert.match(readme, /根据当前 Windows 系统位数/);
  assert.match(script, /\$hostPath = \$candidate/);
  assert.match(script, /\$hostPath = 'deepseekwebpp-host\.cmd'/);
  assert.match(script, /\$manifest\.path = \$hostPath/);
});

test('native host origin sync scans Chrome secure preferences', () => {
  const script = fs.readFileSync('scripts/sync-native-host-origin.ps1', 'utf8');

  assert.match(script, /Secure Preferences/);
  assert.match(script, /function Add-PreferencesCandidates/);
  assert.match(script, /Add-PreferencesCandidates -ProfileDir/);
  assert.match(script, /-Encoding UTF8/);
  assert.match(script, /\$extensionPath = Join-Path \$ProjectRoot 'extension'/);
  assert.match(script, /GetFullPath/);
  assert.doesNotMatch(script, /\.chrome-deepseekwebpp-profile/);
  assert.doesNotMatch(script, /Join-Path \$ProjectRoot .*Preferences/);
});

test('extension launch script prints the matching origin sync command', () => {
  const script = fs.readFileSync('scripts/launch-chrome-with-extension.ps1', 'utf8');
  const readme = fs.readFileSync('README.md', 'utf8');

  assert.match(script, /sync-native-host-origin\.ps1 -UserDataDir/);
  assert.match(script, /sync-native-host-origin\.ps1 or pass the extension ID/);
  assert.match(readme, /chrome\.storage\.local/);
  assert.match(readme, /\$env:LOCALAPPDATA/);
  assert.doesNotMatch(readme, /\.chrome-deepseekwebpp-profile/);
});

test('package script creates and verifies the release zip', () => {
  const script = fs.readFileSync('scripts/package-release.ps1', 'utf8');

  assert.match(script, /\[string\]\$Version/);
  assert.match(script, /Compress-Archive -Path/);
  assert.match(script, /Test-Path -LiteralPath \$zipPath/);
  assert.match(script, /\$packageJson = Get-Content[^\n]+package\.json/);
  assert.match(script, /\$version = if \(\$Version\)/);
  assert.match(script, /-Version \$version/);
  assert.match(script, /\$packageName = "DeepseekWebpp-\$version"/);
  assert.doesNotMatch(script, /portable/);
  assert.doesNotMatch(script, /Compress-Archive -LiteralPath \(Join-Path \$staging '\*'\)/);
});

test('release workflow packages published releases as zip assets', () => {
  const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');

  assert.match(workflow, /^on:\n\s+release:\n\s+types:\s+\[published\]/m);
  assert.match(workflow, /^permissions:\n\s+contents:\s+write/m);
  assert.match(workflow, /GO_VERSION:\s+"1\.26\.3"/);
  assert.match(workflow, /NODE_VERSION:\s+"26\.3\.0"/);
  assert.match(workflow, /runs-on:\s+windows-latest/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-go@v6/);
  assert.match(workflow, /cache:\s+false/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /\$version = '\$\{\{ github\.event\.release\.tag_name \}\}'/);
  assert.match(workflow, /scripts\\package-release\.ps1 -Version \$version/);
  assert.match(workflow, /\$zipPath = "dist\\DeepseekWebpp-\$version\.zip"/);
  assert.match(workflow, /softprops\/action-gh-release@v3/);
  assert.match(workflow, /tag_name:\s+\$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /files:\s+dist\/DeepseekWebpp-\$\{\{ github\.event\.release\.tag_name \}\}\.zip/);
  assert.match(workflow, /fail_on_unmatched_files:\s+true/);
  assert.doesNotMatch(workflow, /docker/i);
});

test('gitignore excludes generated files and local dot directories only', () => {
  const gitignore = fs.readFileSync('.gitignore', 'utf8');

  assert.match(gitignore, /^\.\[!\.\]\*\/$/m);
  assert.match(gitignore, /^!\.git\/$/m);
  assert.match(gitignore, /^!\.gitignore$/m);
  assert.match(gitignore, /^!\.github\/$/m);
  assert.match(gitignore, /^!\.github\/\*\*$/m);
  assert.match(gitignore, /^\.chrome-\*\/$/m);
  assert.match(gitignore, /^\.agents\/$/m);
  assert.match(gitignore, /^dist\/$/m);
  assert.match(gitignore, /^dist\/DeepseekWebpp-\*\/$/m);
  assert.match(gitignore, /^dist\/DeepseekWebpp-\*\.zip$/m);
  assert.match(gitignore, /^native-host\/deepseekwebpp-host\.exe$/m);
  assert.match(gitignore, /^native-host\/bin\/$/m);
});

test('project version is sourced from package metadata', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
  const packageScript = fs.readFileSync('scripts/package-release.ps1', 'utf8');
  const nodeTools = fs.readFileSync('native-host/tools.js', 'utf8');
  const goHost = fs.readFileSync('native-host-go/main.go', 'utf8');

  assert.equal(packageJson.version, '0.0.1');
  assert.equal(manifest.version, packageJson.version);
  assert.match(packageScript, /\$version = if \(\$Version\) \{ \$Version \} else \{ \$packageJson\.version \}/);
  assert.match(nodeTools, /clientInfo: \{ name: 'DeepseekWebpp', version: packageVersion \}/);
  assert.match(nodeTools, /`DeepseekWebpp\/\$\{packageVersion\}`/);
  assert.match(goHost, /var appVersion = "0\.0\.0-dev"/);
  assert.match(goHost, /"version": appVersion/);
  assert.match(goHost, /"DeepseekWebpp\/"\+appVersion/);
});

test('native host exe build strips debug metadata without upx', () => {
  const script = fs.readFileSync('scripts/build-native-host-exe.ps1', 'utf8');

  assert.match(script, /\[string\]\$Version/);
  assert.match(script, /\$version = if \(\$Version\) \{ \$Version \} else \{ \$packageJson\.version \}/);
  assert.match(script, /-trimpath/);
  assert.match(script, /-buildvcs=false/);
  assert.match(script, /\$ldflags = "-s -w -buildid= -X main\.appVersion=\$version"/);
  assert.match(script, /function Invoke-GoBuild/);
  assert.match(script, /'-ldflags',\s*\$ldflags/);
  assert.match(script, /& go @arguments/);
  assert.match(script, /\$LASTEXITCODE -ne 0/);
  assert.match(script, /CGO_ENABLED = '0'/);
  assert.doesNotMatch(script, /-ldflags=\$ldflags/);
  assert.doesNotMatch(script, /upx/i);
});

test('background keeps file mutation tools out of whitelist auto-allow', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(background, /const MUTATING_FILE_TOOLS = new Set/);
  assert.match(background, /async function getAutoAllowAllTools/);
  assert.match(background, /autoAllowAllTools:\s*false/);
  assert.match(background, /if \(await getAutoAllowAllTools\(\)\) \{/);
  assert.match(background, /return deliverToolResultToTab\(call,\s*result,\s*tabId\)/);
  assert.match(background, /const SAFE_AUTO_TOOLS = new Set/);
  assert.match(background, /'weather'/);
  assert.match(background, /'world_time'/);
  assert.match(background, /'disk_info'/);
  assert.match(background, /'directory_info'/);
  assert.match(background, /'web_search'/);
  assert.match(background, /SAFE_AUTO_TOOLS\.has\(call\.tool\)/);
  assert.match(background, /'delete_file'/);
  assert.match(background, /'move_file'/);
  assert.match(background, /'copy_file'/);
  assert.match(background, /MUTATING_FILE_TOOLS\.has\(request\.tool\)/);
});

test('background returns focus to the original DeepSeek tab after confirmation', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(background, /async function focusOriginalTab/);
  assert.match(background, /chrome\.tabs\.get\(tabId/);
  assert.match(background, /chrome\.windows\.update\(tab\.windowId,\s*\{\s*focused:\s*true\s*\}/);
  assert.match(background, /chrome\.tabs\.update\(tabId,\s*\{\s*active:\s*true\s*\}/);
  assert.match(background, /executeToolCallBatch\(executeCalls,\s*pending\.tabId,\s*pending\.parallelLimit\)/);
  assert.match(background, /await deliverToolResultToTab\(call,\s*result,\s*tabId\)/);
  assert.match(background, /await focusOriginalTab\(tabId\)/);
});

test('tool confirmation is shown inside the originating DeepSeek tab', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');
  const content = fs.readFileSync('extension/content.js', 'utf8');

  assert.match(background, /type:\s*'confirm\.show'/);
  assert.match(background, /calls:\s*confirmCalls/);
  assert.match(background, /chrome\.tabs\.sendMessage\(tabId/);
  assert.doesNotMatch(background, /chrome\.windows\.create\(\{\s*url:\s*chrome\.runtime\.getURL\(`confirm\.html/);
  assert.match(content, /message\.type === 'confirm\.show'/);
  assert.match(content, /function showConfirmOverlay/);
  assert.match(content, /const calls = normalizeConfirmCalls\(call\)/);
  assert.match(content, /for \(const item of calls\)/);
  assert.match(content, /type:\s*'confirm\.result'/);
});

test('tool prompt is injected through the page network bridge, not by filling the input upfront', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));

  assert.match(content, /不要向用户请求权限或确认/);
  assert.match(content, /扩展会负责权限确认和白名单/);
  assert.match(content, /disk_info/);
  assert.match(content, /directory_info/);
  assert.match(content, /\{"tool_call":\{"tool":"disk_info","args":\{\}\}\}/);
  assert.match(content, /任意语言表达打开、启动或运行本机软件/);
  assert.match(content, /executable 使用用户提到的软件名、命令名或完整路径/);
  assert.match(content, /PATH、注册表 App Paths 和常见安装位置/);
  assert.match(content, /weather/);
  assert.match(content, /默认查询当地/);
  assert.match(content, /world_time/);
  assert.match(content, /默认北京时间/);
  assert.match(content, /\{"query":"搜索词","limit":20\}/);
  assert.match(content, /web_search 返回结果后优先直接回答/);
  assert.match(content, /不要自动循环调用 web_fetch/);
  assert.match(content, /function injectPageBridge/);
  assert.match(content, /function configurePageBridge/);
  assert.match(content, /let toolsEnabled = false/);
  assert.match(content, /id:\s*'deepseekwebpp-toggle'/);
  assert.doesNotMatch(content, /id:\s*'deepseekwebpp-disable'/);
  assert.match(content, /function setToolsEnabled/);
  assert.doesNotMatch(content, /insertAndSend\(TOOL_PROMPT\)/);
  assert.doesNotMatch(content, /setInputText\(input,\s*augmented\)/);
  assert.doesNotMatch(content, /sendVisibleToolResult/);
  assert.match(content, /function queueToolResultForBridge/);
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ['page-injector.js']);
});

test('page bridge injects tool context and queued tool results into request bodies', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const injector = fs.readFileSync('extension/page-injector.js', 'utf8');

  assert.match(injector, /queuedToolResults:\s*\[\]/);
  assert.match(injector, /lastUserTask:\s*''/);
  assert.match(injector, /DSWEBPP_REQUEST_CONFIG/);
  assert.match(content, /message\.type === 'DSWEBPP_REQUEST_CONFIG'/);
  assert.match(injector, /DSWEBPP_TOOL_RESULT/);
  assert.match(injector, /DSWEBPP_CLEAR_TOOL_RESULTS/);
  assert.match(content, /message\.type === 'tool\.result'/);
  assert.match(content, /function clearPendingToolResults/);
  assert.match(content, /function showToolResultContinue/);
  assert.match(content, /id = 'deepseekwebpp-continue'/);
  assert.doesNotMatch(injector, /scheduleToolResultFollowup/);
  assert.doesNotMatch(injector, /buttons\[buttons\.length - 1\]/);
  assert.match(injector, /message\.type !== 'DSWEBPP_CONFIG' && message\.type !== 'DSWEBPP_TOOL_RESULT' && message\.type !== 'DSWEBPP_CLEAR_TOOL_RESULTS'/);
  assert.match(injector, /DSWEBPP_USER_REQUEST_SENT/);
  assert.match(injector, /notifyUserRequestSent\(\)/);
  assert.match(content, /message\.type === 'DSWEBPP_USER_REQUEST_SENT'/);
  assert.match(injector, /可调用工具/);
  assert.match(injector, /injectToolContext/);
  assert.match(injector, /本次请求已经包含工具结果/);
  assert.match(injector, /原始用户任务/);
  assert.match(injector, /state\.lastUserTask = originalText/);
  assert.match(injector, /if \(!state\.queuedToolResults\.length\)/);
  assert.match(injector, /不要继续输出新的 tool_call/);
  assert.doesNotMatch(injector, /工具结果 list_files/);
});

test('background never uses native global keyboard input for automatic continuation', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.doesNotMatch(background, /function continueOriginalTab/);
  assert.doesNotMatch(background, new RegExp(`tool:\\s*'${['send', 'keys'].join('_')}'`));
  assert.doesNotMatch(background, /text:\s*'继续'/);
});

test('content automatically asks DeepSeek to answer from queued tool results', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const readme = fs.readFileSync('README.md', 'utf8');

  assert.match(content, /async function continueWithToolResult/);
  assert.match(content, /请基于工具结果继续完成原始任务/);
  assert.match(content, /function shouldContinueWithToolResult/);
  assert.match(content, /call && call\.tool === 'run_program'/);
  assert.match(content, /result\.started === true && result\.detached === true/);
  assert.match(content, /wait:true/);
  assert.match(content, /exitCode/);
  assert.match(content, /stdout/);
  assert.match(content, /stderr/);
  assert.match(content, /error/);
  assert.match(content, /无论成功还是失败/);
  assert.match(content, /return false/);
  assert.match(content, /function findSendButton/);
  assert.match(content, /async function clickSendButtonWhenReady/);
  assert.match(content, /button, \[role="button"\]/);
  assert.match(content, /getAttribute\('aria-disabled'\)/);
  assert.match(content, /const stateVersion = toolStateVersion/);
  assert.match(content, /await clickSendButtonWhenReady\(input,\s*stateVersion\)/);
  assert.match(content, /stateVersion !== toolStateVersion/);
  assert.match(content, /setTimeout\(resolve,\s*120\)/);
  assert.match(content, /function clickElementLikeUser/);
  assert.match(content, /new PointerEvent/);
  assert.match(content, /new MouseEvent/);
  assert.match(content, /element\.dispatchEvent\(event\)/);
  assert.match(content, /element\.click\(\)/);
  assert.match(content, /form\.requestSubmit/);
  assert.match(content, /const DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS = 30000/);
  assert.match(content, /toolResultContinueTimeoutMs/);
  assert.match(content, /chrome\.storage\.local\.get\(\{\s*toolResultContinueTimeoutMs:\s*DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS\s*\}/);
  assert.match(content, /chrome\.storage\.onChanged\.addListener/);
  assert.match(content, /function scheduleToolResultContinueExpiry/);
  assert.match(content, /clearPendingToolResults\(\);\s*setStatus\('工具结果等待发送超时，已重置'\)/);
  assert.match(content, /function clearToolResultContinueTimer/);
  assert.doesNotMatch(content, /sendVisibleToolResult/);
  assert.doesNotMatch(content, /keydown/);
  assert.match(readme, /信息类结果会自动注入/);
  assert.match(readme, /请基于工具结果继续完成原始任务/);
  assert.match(readme, /exitCode/);
  assert.match(readme, /stdout/);
  assert.match(readme, /stderr/);
  assert.match(readme, /error/);
  assert.match(readme, /无论成功还是失败/);
});

test('content batches parallel tool results before asking DeepSeek once', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(content, /const DEFAULT_NETWORK_TOOL_TIMEOUT_MS = 600000/);
  assert.match(content, /const DEFAULT_TOOL_CALL_BATCH_LIMIT = 5/);
  assert.match(content, /const DEFAULT_TOOL_CALL_PARALLEL_LIMIT = 5/);
  assert.match(content, /const NETWORK_TIMEOUT_TOOLS = new Set\(\['web_search',\s*'web_fetch'\]\)/);
  assert.match(background, /const DEFAULT_TOOL_CALL_PARALLEL_LIMIT = 5/);
  assert.match(background, /const SERIAL_TOOL_CALL_TOOLS = new Set\(\['run_program'\]\)/);
  assert.match(background, /function executeToolCallBatch/);
  assert.match(background, /function canLaunchBatchToolCall/);
  assert.match(background, /function hasRunningSerialToolCall/);
  assert.match(content, /let networkToolTimeoutMs = DEFAULT_NETWORK_TOOL_TIMEOUT_MS/);
  assert.match(content, /let toolCallParallelLimit = DEFAULT_TOOL_CALL_PARALLEL_LIMIT/);
  assert.match(content, /networkToolTimeoutMs:\s*DEFAULT_NETWORK_TOOL_TIMEOUT_MS/);
  assert.match(content, /toolCallParallelLimit:\s*DEFAULT_TOOL_CALL_PARALLEL_LIMIT/);
  assert.match(content, /function getToolResultBatchTimeoutMs/);
  assert.match(content, /NETWORK_TIMEOUT_TOOLS\.has\(call\.tool\)/);
  assert.match(content, /let activeToolResultBatch = null/);
  assert.match(content, /let toolResultContinueRequested = false/);
  assert.match(content, /let suppressToolCallsUntilUserTurn = false/);
  assert.match(content, /let suppressToolCallsTimer = null/);
  assert.match(content, /let programmaticComposerInput = false/);
  assert.match(content, /document\.addEventListener\('input',\s*handleComposerUserInput,\s*true\)/);
  assert.match(content, /const callsToSend = \[\]/);
  assert.match(content, /callsToSend\.push\(call\)/);
  assert.match(content, /startToolResultBatch\(callsToSend\)/);
  assert.match(content, /launchQueuedToolCalls\(\)/);
  assert.match(content, /type:\s*'tool\.batch\.call'/);
  assert.match(content, /calls,\s*parallelLimit:\s*toolCallParallelLimit/);
  assert.match(content, /activeToolResultBatch\.queue\.splice\(0\)/);
  assert.match(content, /function startToolResultBatch/);
  assert.match(content, /function launchQueuedToolCalls/);
  assert.match(content, /function removeRunningToolCall/);
  assert.match(content, /runningCalls:\s*\[\]/);
  assert.match(content, /activeToolResultBatch\.runningCalls\.push\(\.\.\.calls\)/);
  assert.match(content, /function noteToolResultForBatch/);
  assert.match(content, /removeRunningToolCall\(call\)/);
  assert.match(content, /function maybeContinueWithCompletedToolBatch/);
  assert.match(content, /maybeContinueWithCompletedToolBatch\(\)/);
  assert.match(content, /if \(toolResultContinueRequested\) \{/);
  assert.match(content, /toolResultContinueRequested = true/);
  assert.match(content, /toolResultContinueRequested = false/);
  assert.match(content, /startSuppressingToolResultAnswerCalls\(\)/);
  assert.match(content, /shouldSuppressToolResultAnswerCalls\(\)/);
  assert.match(content, /suppressToolCallsUntilUserTurn = true/);
  assert.match(content, /suppressToolCallsUntilUserTurn = false/);
  assert.match(content, /function handleComposerUserInput/);
  assert.match(content, /if \(!suppressToolCallsUntilUserTurn \|\| programmaticComposerInput\) \{/);
  assert.match(content, /toolResultContinueRequested = false/);
  assert.match(content, /programmaticComposerInput = true/);
  assert.doesNotMatch(content, /queueToolResultForBridge\(message\.call,\s*message\.result\);\s*continueWithToolResult\(\);/);
  assert.doesNotMatch(content, /setStatus\(`已发送工具请求：\$\{call\.tool\}`\)/);
});

test('content allows confirmation-required follow-up tools from tool-result answers', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const injector = fs.readFileSync('extension/page-injector.js', 'utf8');

  assert.match(content, /const TOOL_RESULT_CONTINUATION_TOOLS = new Set\(\[/);
  for (const tool of ['write_file', 'edit_file', 'remove_path', 'make_dir', 'multi_file_edit', 'run_program']) {
    assert.match(content, new RegExp(`'${tool}'`));
  }
  assert.match(content, /运行验证命令/);
  assert.match(injector, /运行验证命令/);
  assert.match(injector, /不要用自然语言假装已经执行/);
  assert.match(content, /function getToolResultContinuationCalls/);
  assert.match(content, /TOOL_RESULT_CONTINUATION_TOOLS\.has\(call\.tool\)/);
  assert.match(content, /findIndex\(\(\{ call \}\) => call\.tool === 'run_program'\)/);
  assert.match(content, /continuationCalls\.slice\(0,\s*runIndex\)/);
  assert.match(content, /const continuationCalls = getToolResultContinuationCalls\(freshCalls\)/);
  assert.match(content, /if \(!continuationCalls\.length\) \{/);
  assert.match(content, /for \(const \{ call, key \} of continuationCalls\)/);
});

test('background serializes run_program without blocking non-program tools', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(background, /let serialToolCallQueue = Promise\.resolve\(\)/);
  assert.match(background, /const nextIndex = queue\.findIndex\(\(call\) => canLaunchBatchToolCall\(call,\s*runningCalls\)\)/);
  assert.match(background, /const \[call\] = queue\.splice\(nextIndex,\s*1\)/);
  assert.match(background, /function runSerialBatchToolCall/);
  assert.match(background, /if \(SERIAL_TOOL_CALL_TOOLS\.has\(call\.tool\)\) \{\s*return !hasRunningSerialToolCall\(runningCalls\);\s*\}\s*return true;/);
});

test('background delays auto-allowed batch calls until pending confirmations resolve', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(background, /pendingRequests\.set\(id,\s*\{\s*id,\s*calls:\s*confirmCalls,\s*executeCalls:\s*preparedCalls,/);
  assert.match(background, /const executeCalls = Array\.isArray\(pending\.executeCalls\) \? pending\.executeCalls : calls/);
  assert.match(background, /executeToolCallBatch\(executeCalls,\s*pending\.tabId,\s*pending\.parallelLimit\)/);
  assert.match(background, /const rejectedCalls = Array\.isArray\(pending\.executeCalls\) \? pending\.executeCalls : calls/);
  assert.match(background, /if \(!confirmCalls\.length\) \{\s*executeToolCallBatch\(autoCalls,\s*tabId,\s*parallelLimit\)/);
  assert.doesNotMatch(background, /if \(autoCalls\.length\) \{\s*executeToolCallBatch\(autoCalls,\s*tabId,\s*parallelLimit\)/);
});

test('background continues the originating tab for whitelist auto-allowed calls', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(background, /async function deliverToolResultToTab/);
  assert.match(background, /return deliverToolResultToTab\(call,\s*result,\s*tabId\)/);
  assert.match(background, /type:\s*'tool\.result'/);
  assert.doesNotMatch(background, /await continueOriginalTab\(tabId\)/);
});

test('content does not queue direct sendResponse results after tool.call', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');

  assert.doesNotMatch(content, /else if \(response\) \{\s*queueToolResultForBridge\(call,\s*response\);/);
  assert.match(content, /setStatus\(getToolBatchRunningStatus\(\)\)/);
});

test('background reports long-running native tool execution to the originating tab', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(background, /async function notifyToolRunning/);
  assert.match(background, /type:\s*'tool\.running'/);
  assert.match(background, /await notifyToolRunning\(call,\s*tabId\)/);
  assert.match(background, /executeToolCallBatch\(executeCalls,\s*pending\.tabId,\s*pending\.parallelLimit\)/);
});

test('content shows a long-running tool status while waiting for native results', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');

  assert.match(content, /message\.type === 'tool\.running'/);
  assert.match(content, /function getToolRunningStatus/);
  assert.match(content, /setStatus\(getToolRunningStatus\(message\.call\)\)/);
  assert.match(content, /可能需要较长时间/);
});

test('network native tool calls use the configurable 600 second timeout', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');
  const nodeTools = fs.readFileSync('native-host/tools.js', 'utf8');
  const goHost = fs.readFileSync('native-host-go/main.go', 'utf8');

  assert.match(background, /const DEFAULT_NETWORK_TOOL_TIMEOUT_MS = 600000/);
  assert.match(background, /async function getNetworkToolTimeoutMs/);
  assert.match(background, /networkToolTimeoutMs:\s*DEFAULT_NETWORK_TOOL_TIMEOUT_MS/);
  assert.match(background, /function getToolTimeoutMs/);
  assert.match(background, /\['web_search',\s*'web_fetch'\]/);
  assert.match(background, /await callNativeTool\(call,\s*await getToolTimeoutMs\(call\)\)/);
  assert.match(background, /let finished = false/);
  assert.match(background, /const timeout = setTimeout/);
  assert.match(background, /clearTimeout\(timeout\)/);
  assert.match(background, /工具执行超时/);
  assert.match(nodeTools, /const DEFAULT_MCP_TOOL_TIMEOUT_MS = 600000/);
  assert.match(nodeTools, /mcp\.timeoutMs \|\| DEFAULT_MCP_TOOL_TIMEOUT_MS/);
  assert.match(goHost, /const defaultMCPToolTimeoutMs = 600000/);
  assert.match(goHost, /intArg\(mcp, "timeoutMs", defaultMCPToolTimeoutMs\)/);
});

test('content gates tool execution on page requests instead of startup priming', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');

  assert.match(content, /let pendingToolCallRequest = false/);
  assert.match(content, /const ignoredToolCallNodes = new WeakSet\(\)/);
  assert.match(content, /function startToolCallRequestGate/);
  assert.match(content, /ignoreToolCallNodes\(collectToolCallNodes\(\)\)/);
  assert.match(content, /if \(!pendingToolCallRequest\) \{\s*ignoreToolCallNodes\(nodes\);\s*return;\s*\}/);
  assert.match(content, /if \(ignoredToolCallNodes\.has\(node\)\) \{\s*continue;\s*\}/);
  assert.match(content, /clearToolCallRequestGate\(\)/);
  assert.doesNotMatch(content, /toolCallScannerPrimed/);
  assert.doesNotMatch(content, /primeExistingToolCalls/);
  assert.doesNotMatch(content, /TOOL_CALL_HISTORY_PRIME_MS/);
  assert.doesNotMatch(content, /contentScriptStartedAt/);
});

test('content script scans recent tool calls after filtering tool_call nodes', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');

  assert.match(content, /function startToolCallScanner/);
  assert.match(content, /new MutationObserver/);
  assert.match(content, /function scheduleToolCallScan/);
  assert.match(content, /clearTimeout\(scanTimer\)/);
  assert.match(content, /function normalizeToolCallNode/);
  assert.match(content, /SCAN_FALLBACK_INTERVAL_MS/);
  assert.match(content, /const DEFAULT_TOOL_CALL_BATCH_LIMIT = 5/);
  assert.match(content, /let toolCallBatchLimit = DEFAULT_TOOL_CALL_BATCH_LIMIT/);
  assert.match(content, /DeepSeekToolParser\.parseToolCalls\(text\)/);
  assert.match(content, /callsToSend\.length >= toolCallBatchLimit/);
  assert.match(content, /toolCallBatchLimit:\s*DEFAULT_TOOL_CALL_BATCH_LIMIT/);
  assert.doesNotMatch(content, /consecutiveToolCalls/);
  assert.doesNotMatch(content, /function shouldRunToolCall/);
  assert.doesNotMatch(content, /连续工具调用过多/);
  assert.match(content, /const processedToolCalls = new Set\(\)/);
  assert.match(content, /filter\(\(node\) => getNodeText\(node\)\.includes\('tool_call'\) && !isEditableToolCallNode\(node\)\)/);
  assert.match(content, /normalizeToolCallNode\(node\)/);
  assert.match(content, /node\.closest\('pre'\) \|\| node\.closest\('code'\)/);
  assert.match(content, /if \(nodes\.size > 0\)/);
  assert.match(content, /document\.createTreeWalker/);
  assert.match(content, /NodeFilter\.SHOW_TEXT/);
  assert.match(content, /normalizeToolCallNode\(textNode\.parentElement\)/);
  assert.match(content, /function isEditableToolCallNode/);
  assert.match(content, /node\.closest\('textarea, input, \[contenteditable="true"\], \[role="textbox"\]'\)/);
  assert.match(content, /node\.querySelector\('textarea, input, \[contenteditable="true"\], \[role="textbox"\]'\)/);
  assert.match(content, /if \(isEditableToolCallNode\(node\)\) \{\s*return null;\s*\}/);
  assert.doesNotMatch(content, /if \(!toolsEnabled \|\| scanTimer\) \{/);
  assert.doesNotMatch(content, /closest\('pre, code, p, article, section, main, li, div, span'\)/);
  assert.doesNotMatch(content, /nodes\.slice\(-80\)/);
});

test('content script persists and restores the enabled tool state', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');

  assert.match(content, /restoreToolsEnabledState\(\)/);
  assert.match(content, /chrome\.storage\.local\.get\(\{\s*toolsEnabled:\s*false\s*\}/);
  assert.match(content, /chrome\.storage\.local\.set\(\{\s*toolsEnabled:\s*enabled\s*\}\)/);
  assert.match(content, /setToolsEnabled\(!toolsEnabled,\s*\{\s*persist:\s*true\s*\}\)/);
  assert.match(content, /if \(!enabled\) \{\s*clearPendingToolResults\(\);\s*processedToolCalls\.clear\(\);/);
  assert.match(content, /pendingToolResults = 0/);
  assert.match(content, /continueButton\.remove\(\)/);
  assert.match(content, /type:\s*'DSWEBPP_CLEAR_TOOL_RESULTS'/);
});

test('floating panel defaults to the right middle and supports dragging', () => {
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const styles = fs.readFileSync('extension/styles.css', 'utf8');

  assert.match(content, /function enablePanelDrag/);
  assert.match(content, /className:\s*'deepseekwebpp-brand'/);
  assert.match(content, /id:\s*'deepseekwebpp-state'/);
  assert.match(content, /id:\s*'deepseekwebpp-last-tool'/);
  assert.match(content, /id:\s*'deepseekwebpp-pending-count'/);
  assert.match(content, /id:\s*'deepseekwebpp-whitelist'/);
  assert.match(styles, /top:\s*50%/);
  assert.match(styles, /right:\s*16px/);
  assert.match(styles, /transform:\s*translateY\(-50%\)/);
  assert.match(styles, /#deepseekwebpp-toggle\.enabled/);
  assert.match(styles, /#deepseekwebpp-toggle\.disabled/);
  assert.match(styles, /\.deepseekwebpp-console-grid/);
  assert.match(styles, /\.deepseekwebpp-stat/);
});

test('options page supports dashboard sections and searchable whitelist management', () => {
  const html = fs.readFileSync('extension/options.html', 'utf8');
  const js = fs.readFileSync('extension/options.js', 'utf8');
  const styles = fs.readFileSync('extension/styles.css', 'utf8');

  assert.match(html, /id="section-overview"/);
  assert.match(html, /id="section-tools"/);
  assert.match(html, /id="section-whitelist"/);
  assert.match(html, /id="section-runtime"/);
  assert.match(html, /id="section-appearance"/);
  assert.match(html, /id="save"[^>]+hidden/);
  assert.match(html, /id="tools-grid"/);
  assert.match(html, /id="host-path"/);
  assert.match(html, /id="extension-id"/);
  assert.match(html, /id="tool-result-timeout-seconds"/);
  assert.match(html, /id="network-tool-timeout-seconds"/);
  assert.match(html, /id="tool-call-batch-limit"/);
  assert.match(html, /id="tool-call-parallel-limit"/);
  assert.match(html, /id="auto-allow-all-tools"/);
  assert.match(html, /id="save-runtime-settings"/);
  assert.match(html, /id="runtime-status"/);
  assert.match(html, /data-section="whitelist"/);
  assert.match(html, /id="rule-search"/);
  assert.match(html, /id="tool-filter"/);
  assert.doesNotMatch(html, /id="tool-call-limit"/);
  assert.doesNotMatch(html, /连续工具调用上限/);
  assert.match(html, /id="rules-summary"/);
  assert.match(js, /const TOOL_CATALOG = \[/);
  assert.match(js, /directory_info/);
  assert.match(js, /function renderToolCatalog/);
  assert.match(js, /function switchSection/);
  assert.match(js, /function getInitialSection/);
  assert.match(js, /window\.location\.hash/);
  assert.match(js, /switchSection\(getInitialSection\(\)\)/);
  assert.match(js, /const whitelistSaveButton = document\.getElementById\('save'\)/);
  assert.match(js, /function updateWhitelistSaveVisibility/);
  assert.match(js, /whitelistSaveButton\.hidden = section !== 'whitelist'/);
  assert.match(js, /function renderRuntimeInfo/);
  assert.match(js, /const DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS = 30000/);
  assert.match(js, /const DEFAULT_NETWORK_TOOL_TIMEOUT_MS = 600000/);
  assert.match(js, /const DEFAULT_TOOL_CALL_BATCH_LIMIT = 5/);
  assert.match(js, /const DEFAULT_TOOL_CALL_PARALLEL_LIMIT = 5/);
  assert.match(js, /let autoAllowAllTools = false/);
  assert.match(js, /toolResultContinueTimeoutMs/);
  assert.match(js, /networkToolTimeoutMs/);
  assert.match(js, /toolCallBatchLimit/);
  assert.match(js, /toolCallParallelLimit/);
  assert.match(js, /function renderRuntimeSettings/);
  assert.match(js, /function saveRuntimeSettings/);
  assert.match(js, /toolResultContinueTimeoutMs: DEFAULT_TOOL_RESULT_CONTINUE_TIMEOUT_MS/);
  assert.match(js, /networkToolTimeoutMs:\s*DEFAULT_NETWORK_TOOL_TIMEOUT_MS/);
  assert.match(js, /toolCallBatchLimit:\s*DEFAULT_TOOL_CALL_BATCH_LIMIT/);
  assert.match(js, /toolCallParallelLimit:\s*DEFAULT_TOOL_CALL_PARALLEL_LIMIT/);
  assert.match(js, /autoAllowAllTools:\s*false/);
  assert.match(js, /confirmAutoAllowAllTools/);
  assert.match(js, /window\.confirm/);
  assert.match(js, /chrome\.storage\.local\.set\(\{\s*toolResultContinueTimeoutMs,\s*networkToolTimeoutMs,\s*toolCallBatchLimit,\s*toolCallParallelLimit,\s*autoAllowAllTools\s*\}/);
  assert.match(js, /function getRuleSummary/);
  assert.match(js, /function getFilteredRules/);
  assert.match(js, /function renderGroupedRules/);
  assert.match(js, /className = 'tool-group'/);
  assert.match(styles, /\.settings-nav/);
  assert.match(styles, /\.settings-section/);
  assert.match(styles, /\.tool-card/);
  assert.match(styles, /\.rules-toolbar/);
  assert.match(styles, /\.rule-summary/);
});

test('options page exposes provider-specific web_search settings', () => {
  const html = fs.readFileSync('extension/options.html', 'utf8');
  const js = fs.readFileSync('extension/options.js', 'utf8');
  const styles = fs.readFileSync('extension/styles.css', 'utf8');
  const readme = fs.readFileSync('README.md', 'utf8');

  assert.match(html, /id="section-web-search"/);
  assert.match(html, /data-section="web-search"/);
  assert.match(html, /id="web-search-provider"/);
  assert.match(html, /value="bing"/);
  assert.match(html, /value="duckduckgo"/);
  assert.match(html, /value="mcp"/);
  assert.match(html, /id="web-search-no-api-section"/);
  assert.match(html, /id="web-search-mcp-json"/);
  assert.match(html, /id="web-search-mcp-section"[^>]+hidden/);
  assert.match(html, /id="test-web-search-mcp"/);
  assert.match(html, /GrokSearch-rs/);
  assert.doesNotMatch(html, /value="custom"/);
  assert.doesNotMatch(html, /value="api"/);
  assert.doesNotMatch(html, /web-search-search-url/);
  assert.doesNotMatch(html, /web-search-api-json/);
  assert.match(js, /const DEFAULT_WEB_SEARCH_SETTINGS = /);
  assert.match(js, /provider:\s*'duckduckgo'/);
  assert.match(js, /mcpServers/);
  assert.match(js, /'grok-search-rs'/);
  assert.match(readme, /`duckduckgo`：默认值/);
  assert.doesNotMatch(readme, /`bing`：默认值/);
  assertOrderedIncludes(js, [
    'GROK_SEARCH_API_KEY',
    'GROK_SEARCH_URL',
    'GROK_SEARCH_MODEL',
    'TAVILY_API_KEY',
    'TAVILY_API_URL',
    'FIRECRAWL_API_KEY',
  ]);
  assertOrderedIncludes(readme, [
    'GROK_SEARCH_API_KEY',
    'GROK_SEARCH_URL',
    'GROK_SEARCH_MODEL',
    'TAVILY_API_KEY',
    'TAVILY_API_URL',
    'FIRECRAWL_API_KEY',
  ]);
  assert.match(js, /function renderWebSearchSettings/);
  assert.match(js, /function saveWebSearchSettings/);
  assert.match(js, /function testWebSearchMcp/);
  assert.match(js, /type:\s*'webSearch\.test'/);
  assert.match(js, /performance\.now\(\)/);
  assert.match(js, /耗时/);
  assert.match(js, /function getWebSearchSettingsFromForm/);
  assert.match(js, /function parseWebSearchJson/);
  assert.match(js, /function updateWebSearchProviderFields/);
  assert.match(js, /webSearchNoApiSection\.hidden = webSearchProviderInput\.value === 'mcp'/);
  assert.match(js, /webSearchMcpSection\.hidden = webSearchProviderInput\.value !== 'mcp'/);
  assert.doesNotMatch(js, /webSearchApiInput/);
  assert.doesNotMatch(js, /webSearchUrlInput/);
  assert.match(js, /webSearchSettings/);
  assert.match(styles, /\.web-search-grid/);
  assert.match(styles, /\.settings-code-input/);
  assert.match(styles, /\[hidden\]\s*\{[\s\S]*display:\s*none\s*!important;[\s\S]*\}/);
  assert.match(styles, /\.settings-code-input\s*\{[\s\S]*min-height:\s*280px;[\s\S]*\}/);
});

test('background merges stored web_search settings before calling native host', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(background, /const DEFAULT_WEB_SEARCH_SETTINGS = /);
  assert.match(background, /provider:\s*'duckduckgo'/);
  assert.match(background, /async function getWebSearchSettings/);
  assert.match(background, /function mergeWebSearchSettings/);
  assert.match(background, /if \(call\.tool === 'web_search'\)/);
  assert.match(background, /chrome\.storage\.local\.get\(\{\s*webSearchSettings:\s*DEFAULT_WEB_SEARCH_SETTINGS\s*\}\)/);
  assert.match(background, /provider:\s*settings\.provider/);
  assert.match(background, /mcp:\s*settings\.mcp/);
  assert.match(background, /mcpServers/);
  assertOrderedIncludes(background, [
    'GROK_SEARCH_API_KEY',
    'GROK_SEARCH_URL',
    'GROK_SEARCH_MODEL',
    'TAVILY_API_KEY',
    'TAVILY_API_URL',
    'FIRECRAWL_API_KEY',
  ]);
  assert.doesNotMatch(background, /provider === 'custom'/);
  assert.doesNotMatch(background, /provider === 'api'/);
  assert.doesNotMatch(background, /settings\.api/);
});

test('background can test web_search settings from the options page', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');

  assert.match(background, /message\.type === 'webSearch\.test'/);
  assert.match(background, /async function handleWebSearchTest/);
  assert.match(background, /tool:\s*'web_search'/);
  assert.match(background, /query:\s*'DeepseekWeb\+\+ MCP test'/);
  assert.match(background, /settings:\s*message\.settings/);
  assert.match(background, /callNativeTool\(call,\s*await getToolTimeoutMs\(call\)\)/);
});

test('go native host reads large MCP stdio responses', () => {
  const goHost = fs.readFileSync('native-host-go/main.go', 'utf8');

  assert.match(goHost, /const maxMCPResponseBytes = 64 \* 1024 \* 1024/);
  assert.match(goHost, /reader := bufio\.NewReader\(stdout\)/);
  assert.match(goHost, /readMCPJSONLine\(reader,\s*maxMCPResponseBytes\)/);
  assert.match(goHost, /stopMCPProcess\(cmd\)/);
});

test('node native host bounds MCP stdout buffering', () => {
  const nodeTools = fs.readFileSync('native-host/tools.js', 'utf8');

  assert.match(nodeTools, /const MAX_MCP_RESPONSE_BYTES = 64 \* 1024 \* 1024/);
  assert.match(nodeTools, /stdoutBytes \+= chunk\.length/);
  assert.match(nodeTools, /MCP response exceeds \$\{MAX_MCP_RESPONSE_BYTES\} bytes/);
  assert.match(nodeTools, /stderr = truncateBufferText\(stderr \+ chunk\.toString\('utf8'\), MAX_MCP_STDERR_CHARS\)/);
});

test('native web_search defaults to twenty results', () => {
  const nodeTools = fs.readFileSync('native-host/tools.js', 'utf8');
  const goHost = fs.readFileSync('native-host-go/main.go', 'utf8');

  assert.match(nodeTools, /Number\(args\.limit \|\| 20\)/);
  assert.match(goHost, /intArg\(args, "limit", 20\)/);
  assert.doesNotMatch(nodeTools, /args\.limit \|\| 8/);
  assert.doesNotMatch(goHost, /intArg\(args, "limit", 8\)/);
});

test('project internal identifiers remain stable while visible brand uses DeepseekWeb++', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const retired = [
    new RegExp(['Deepseek', 'Web', 'Plus'].join('')),
    new RegExp(['Deepseek', 'Web', 'Tool', 'use'].join('')),
    new RegExp(['com', 'dsweb' + 'tools', 'deepseek_tools'].join('\\.')),
    new RegExp(['deepseek', 'tools', 'host'].join('-')),
    new RegExp(['DSWEB', 'TOOLS'].join('')),
    new RegExp(['dsweb', 'tools'].join('')),
    new RegExp(['deepseek', 'pp'].join('-'), 'i'),
  ];

  assert.equal(packageJson.name, 'deepseekwebpp');
  assert.equal(path.basename(process.cwd()), 'DeepseekWebpp');

  for (const projectPath of readProjectPaths('.')) {
    const normalized = projectPath.replace(/\\/g, '/');
    for (const pattern of retired) {
      assert.doesNotMatch(normalized, pattern, `${projectPath} path should not contain retired identifiers`);
    }
  }

  for (const file of readProjectTextFiles('.')) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of retired) {
      assert.doesNotMatch(content, pattern, `${file} should not contain retired identifiers`);
    }
  }
});
