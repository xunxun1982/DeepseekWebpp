# DeepseekWeb++

DeepseekWeb++ 是一个 Chrome MV3 扩展，让 `https://chat.deepseek.com/` 网页端可以通过对话调用本机工具，例如列目录、读写文件、运行程序、联网搜索、查天气和查时间。

当前项目仅用于 Windows 系统。Native Messaging Host、安装脚本、程序别名解析和发布包里的可执行文件都按 Windows 设计；macOS 和 Linux 暂不支持。

整体不依赖第三方后端服务。网页扩展负责注入工具说明、识别 `tool_call`、显示确认框和管理白名单；真正访问文件、运行程序和发起网络请求的是本地 Native Messaging Host。

## 功能概览

- DeepSeek 页面右侧中部显示本地工具控制台，可拖动。
- “启动工具 / 禁用工具”是同一个按钮：启动状态为绿色，禁用状态为红色。
- 工具说明和工具结果通过页面请求桥注入，不提前写入输入框，也不默认显示在聊天内容里。
- 权限确认在当前 DeepSeek 标签页内弹出，不跳转到扩展页面。
- 支持多个 DeepSeek 标签页，确认和结果会回到发起调用的标签页。
- 白名单可事后搜索、筛选、编辑和删除，作用范围可改为路径、程序或任意参数。
- 文件写入、编辑、删除、创建目录和批量编辑类工具始终要求当次确认，不会因为白名单静默执行。
- 设置页可开启“全部自动允许”。该选项默认关闭，开启前会显示危险提示；开启后所有工具都会跳过确认直接执行。
- 发布运行使用 Go 版 Windows 可执行文件，目标电脑不需要安装 Node、Go、.NET 或 Python。

## 支持的工具

文件系统只读：

- `list_files`：列出目录内容。
- `directory_info`：递归统计目录总大小、文件数和子目录数，只返回汇总信息。
- `read_file`：读取文本文件，可指定行号范围。
- `glob_search`：按通配符查找文件。
- `grep_search`：在文件内容中搜索文本或正则。
- `file_exists`：检查文件或目录是否存在。

文件系统变更：

- `write_file`：创建或覆盖文本文件。
- `edit_file`：精确查找替换。
- `remove_path`：删除文件或目录。
- `make_dir`：创建目录。
- `multi_file_edit`：批量编辑多个文件。

系统与网络：

- `run_program`：运行本机可执行程序；打开 GUI 程序时使用 `wait:false`。Windows 下会先按 PATH 和注册表 App Paths 解析常见程序别名。
- `disk_info`：查询本机磁盘容量、已用空间和可用空间。
- `web_search`：联网搜索，默认 DuckDuckGo，可切换 Bing 或本地 MCP。
- `web_fetch`：抓取指定 URL 的文本内容。
- `weather`：查询当前天气，默认当地，也可指定 `location`。
- `world_time`：查询各地时间，默认北京时间，也可指定 `location`。

## 安装

1. 构建或确认 Native Host exe 存在：

   ```powershell
   Test-Path .\native-host\deepseekwebpp-host.exe
   ```

   仅支持 Windows。安装脚本会按系统位数优先选择 `native-host\bin\windows-amd64\deepseekwebpp-host.exe` 或 `native-host\bin\windows-386\deepseekwebpp-host.exe`；如果这些文件不存在，才回退到 `native-host\deepseekwebpp-host.exe`。

   如果修改过 Go 版 Native Host 源码，重新构建：

   ```powershell
   .\scripts\build-native-host-exe.ps1
   ```

2. 打开 Chrome 扩展管理页，并确定本次使用的 Chrome profile。

   使用系统 Chrome 的当前 profile：

   ```powershell
   .\scripts\launch-chrome-with-extension.ps1
   ```

   使用便携 Chrome 或指定 Chrome 程序：

   ```powershell
   .\scripts\launch-chrome-with-extension.ps1 -ChromePath "D:\Chrome\chrome.exe"
   ```

   扩展设置通过 `chrome.storage.local` 保存在 Chrome profile 中，不写入扩展目录。如需隔离调试 profile，可显式传入浏览器用户数据目录；后续同步扩展 ID 时必须传入同一个目录。不传 `-UserDataDir` 时使用当前 Chrome profile：

   ```powershell
   $debugProfile = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\DeepseekWebpp-Debug"
   .\scripts\launch-chrome-with-extension.ps1 -UserDataDir $debugProfile
   ```

3. 在 `chrome://extensions` 开启“开发者模式”，点击“加载已解压的扩展程序”，选择：

   ```text
   <项目目录>\extension
   ```

4. 注册 Native Messaging Host 并同步扩展 ID。

   如果第 2 步使用系统 Chrome 当前 profile，自动从系统 Chrome 配置中查找扩展 ID：

   ```powershell
   .\scripts\sync-native-host-origin.ps1
   ```

   如果第 2 步传入过 `-UserDataDir`，这里必须传入同一个用户数据目录：

   ```powershell
   .\scripts\sync-native-host-origin.ps1 -UserDataDir $debugProfile
   ```

   如果使用便携 Chrome，也传入它的用户数据目录，而不是只传 `chrome.exe` 路径：

   ```powershell
   .\scripts\sync-native-host-origin.ps1 -UserDataDir "D:\Chrome\User Data"
   ```

   `sync-native-host-origin.ps1` 会扫描 Chrome profile 下的 `Preferences` 和 `Secure Preferences`。如果自动查找不到，说明扩展没有加载在脚本扫描的 profile 中；在 `chrome://extensions` 复制扩展 ID 后手工传入：

   ```powershell
   .\scripts\install-native-host.ps1 -ExtensionId "<扩展ID>"
   ```

5. 打开并登录：

   ```text
   https://chat.deepseek.com/
   ```

6. 在 DeepSeek 页面右侧中部点击“启动工具”。

Chrome 扩展不能在未注册 Native Host 前自行写注册表或运行本机程序，因此无法做到纯扩展自动注册。这是 Chrome Native Messaging 的安全边界；本项目需要通过脚本或安装器在当前系统用户下注册一次。

## 便携使用

复制整个项目目录到另一台电脑后，通常只需要：

```powershell
.\scripts\install-native-host.ps1 -ExtensionId "<扩展ID>"
```

或者先加载扩展，再运行：

```powershell
.\scripts\sync-native-host-origin.ps1
```

如果加载扩展时使用了独立用户数据目录，则同步时同样传入该目录：

```powershell
$debugProfile = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\DeepseekWebpp-Debug"
.\scripts\sync-native-host-origin.ps1 -UserDataDir $debugProfile
```

Native Host manifest 中的 host 路径使用相对路径，例如 `deepseekwebpp-host.exe`，不会写死当前电脑上的 exe 绝对路径。注册表中必须写 manifest 的绝对路径，这是 Chrome 的要求。

## web_search 设置

扩展设置页提供独立的 `web_search` 分区，默认保持 DuckDuckGo。

- `duckduckgo`：默认值，使用 DuckDuckGo HTML 搜索，无 API key。
- `bing`：无 API key；如果当前网络访问 DuckDuckGo 不稳定，可切回 Bing。
- `mcp`：通过本地 stdio MCP 调用搜索工具，适合接入 GrokSearch-rs 等本地 MCP。

GrokSearch-rs 示例 MCP JSON：

```json
{
  "mcpServers": {
    "grok-search-rs": {
      "command": "grok-search-rs",
      "args": [],
      "env": {
        "GROK_SEARCH_API_KEY": "sk-123456789",
        "GROK_SEARCH_URL": "http://172.28.100.252:28335",
        "GROK_SEARCH_MODEL": "grok-4.20-fast",
        "TAVILY_API_KEY": "tvly-dev-123456789",
        "TAVILY_API_URL": "https://api.tavily.com",
        "FIRECRAWL_API_KEY": "fc-123456789"
      }
    }
  }
}
```

默认只写命令名，不写死本机路径。如果命令不在 `PATH`，把 `command` 改成你自己机器上的可执行文件路径即可。

`web_search` 的返回结果会尽量包含标题、摘要、时间、URL 和正文摘录。提示词要求模型优先基于一次搜索结果回答，除非用户明确要求阅读链接或摘要明显不足，否则不要循环调用 `web_fetch`。

## 工具结果回答流程

当模型输出 `tool_call` 后，扩展会执行工具。天气、时间、搜索、读取文件、命令输出等信息类结果会自动注入下一次 DeepSeek 请求；工具结果返回后，页面脚本会在 DeepSeek 输入框写入 `请基于工具结果继续完成原始任务；如果还需要修改文件或运行验证，请输出下一步 tool_call JSON，不要只说明计划。`，并尝试点击页面内的发送按钮。续写请求会携带上一条真实用户任务，方便模型在读文件后继续写入、运行验证或给出最终回答。主协议仍是 JSON `tool_call/tool_calls`；模型偶尔输出的 `**Calling:**` + `**Arguments:** {...}` Markdown 格式也会按同一权限链路兼容解析。

如果原始任务明确要求“读取后再修改/写入/删除文件”或“修改后运行验证命令”，工具结果回答里继续输出的文件变更类 `tool_call` 或验证用 `run_program` 会进入正常确认流程；其他搜索、读取等信息类二次工具调用仍会被忽略，避免循环调用。若同一次工具结果回答同时包含文件变更和 `run_program`，扩展会先执行文件变更，等待结果返回后再处理运行验证。

验证用 `run_program` 应使用 `wait:true`。这类结果无论成功还是失败都会作为工具结果再次注入给模型，包含 `exitCode`、`stdout`、`stderr`、`timedOut` 或 `error` 等字段，让模型能判断运行是否正确、错误原因是什么，以及是否还需要下一步修改。

同一回复可以包含多个独立工具调用，例如同时打开多个程序，或同时查询当前时间、天气和联网信息。扩展侧会按设置页“运行环境”中的“单次最大执行工具数”截断总任务数，默认 5 个、最大 5 个；再按“最大并行工具数”排队并行执行，默认 5 个、最大 5 个。信息类工具会等待同批次结果全部返回后再统一请求 DeepSeek 总结；包含 `web_search` 或 `web_fetch` 的批次按网络工具超时设置等待。

纯动作类结果不会自动续写。例如 `run_program` 以 `wait:false` 启动 Word、WPS、Excel 等 GUI 程序时，扩展只在浮窗显示已启动状态，不再把工具结果续写请求写入输入框。

如果页面结构变化导致自动点击失败，浮窗会保留“继续处理工具结果”按钮作为兜底；点击后仍会把同一句话写入输入框。待续写结果默认 30 秒没有发送会自动重置，避免重开对话后误发送旧结果；这个超时时间可在设置页“运行环境”中按秒调整。扩展不会使用系统级键盘输入，也不会向其他窗口发送按键。

## 发布打包

本项目只支持 Windows 发布包。手动打包时可显式传入版本号：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\package-release.ps1 -Version 1.2.3
```

未传 `-Version` 时，脚本才会回退读取 `package.json` 的 `version`。显式版本会用于 `dist\DeepseekWebpp-<version>`、`dist\DeepseekWebpp-<version>.zip`，并传递给 Go Native Host 构建。

GitHub Release 发布后会自动运行 `.github\workflows\release.yml`。workflow 使用 Release tag 作为显式版本，运行测试和 Windows 打包脚本，并把 `dist\DeepseekWebpp-<tag>.zip` 上传到同一个 Release；beta tag 同样按原 tag 生成 zip 文件名。

## 天气和时间

天气默认使用 Open-Meteo Forecast/Geocoding API，原因是免费、无需注册、无需 API key，并覆盖中国天气模型。国内商业天气 API 访问通常更稳定，但一般需要 key 或注册，因此不作为默认源。

时间工具默认返回北京时间，不调用外部时间 API，只使用本机时间和 IANA 时区格式化。指定地点时会先用 Open-Meteo Geocoding 解析；如果中文地名等查询不到，会用通用地理编码兜底，再根据坐标向 Open-Meteo 反查 IANA 时区。提示词要求模型先把区县、街道、景点等细粒度地点归一为城市级英文名或 IANA 时区，例如用户问“北京海淀”时传入 `Beijing`。

## 运行常用程序

`run_program` 始终使用固定的 `executable + args` 结构，不拼 shell 命令。Windows 下如果传入 `winword`、`word`、`excel`、`powerpnt`、`ppt`、`wps`、`et`、`wpp` 等常见别名，Native Host 会按以下顺序解析：

1. 当前 `PATH`。
2. Windows 注册表 `App Paths`。
3. 常见 Office/WPS 安装目录兜底。

如果仍找不到，请传入程序的完整路径。

## 添加新工具

新增工具至少改四处：

1. `native-host-go\main.go`：发布用 Go Native Host 的实际实现。
2. `native-host\tools.js`：Node 参考实现和单元测试覆盖对象。
3. `extension\content.js`：`TOOL_PROMPT` 中加入工具说明，让 DeepSeek 知道可调用。
4. `test\*.test.js`：补工具行为、权限策略或接线测试。

如果工具涉及权限，还要检查：

- `extension\background.js`：是否属于文件变更工具、路径范围工具或程序范围工具。
- `native-host\policy.js`：Node 侧测试用策略是否同步。

维护原则：

- 工具名使用小写蛇形命名，例如 `open_url`。
- 参数和返回值都用 JSON 对象。
- 运行程序优先使用 `executable + args`，不要让模型拼 shell 命令。
- 类似参数解析逻辑放进 helper，避免复制多份。
- 危险操作默认保守，宁可弹确认，不要静默执行。

## 修改 Go 版 Native Host

Go 发布入口在 `native-host-go\main.go`。核心结构：

- 顶部 `tools` 注册表决定哪些工具名可被调用。
- 每个工具实现为 `func xxx(args map[string]any) (any, error)`。
- 参数解析复用 `requireString`、`stringArg`、`intArg`、`boolArg`、`stringSliceArg` 等 helper。

最小示例：

```go
func echo(args map[string]any) (any, error) {
    text := stringArg(args, "text", "")
    return map[string]any{
        "text": text,
        "length": len([]rune(text)),
    }, nil
}
```

然后加入注册表：

```go
var tools = map[string]toolFunc{
    "echo": echo,
}
```

修改后重新构建：

```powershell
.\scripts\build-native-host-exe.ps1
```

生成：

```text
native-host\deepseekwebpp-host.exe
```

## 打包发布

运行：

```powershell
.\scripts\package-release.ps1
```

未传 `-Version` 时版本号来自 `package.json`；发布 workflow 会传入 Release tag 作为显式版本。脚本会构建默认 Windows exe，并额外构建 `amd64` 和 `386` 版本，然后生成：

```text
dist\DeepseekWebpp-0.0.1
dist\DeepseekWebpp-0.0.1.zip
```

打包产物中的 Native Host manifest 仍使用相对 `deepseekwebpp-host.exe`，不会写死开发机路径。exe 使用去调试信息的 Go 构建参数缩小体积，不使用 UPX。

发布包同时包含 64 位和 32 位 Windows Host：

- `native-host\bin\windows-amd64\deepseekwebpp-host.exe`：64 位 Windows 优先使用。
- `native-host\bin\windows-386\deepseekwebpp-host.exe`：32 位 Windows 使用。
- `native-host\deepseekwebpp-host.exe`：默认构建产物，作为兜底入口保留。

`install-native-host.ps1` 会根据当前 Windows 系统位数写入对应的相对 host 路径，通常不需要手动改 manifest。

## 验证

常用命令：

```powershell
npm test
node --check extension\content.js
node --check extension\page-injector.js
node --check extension\background.js
node --check extension\options.js
node --check native-host\tools.js
```

Go 验证：

```powershell
cd native-host-go
go test ./...
```

打包验证：

```powershell
.\scripts\package-release.ps1
```

## 隐私和安全边界

- 扩展只匹配 `https://chat.deepseek.com/*`。
- 工具说明和工具结果只在工具启用时注入 DeepSeek 请求体。
- 默认情况下，文件变更类工具始终需要当前页面确认；若在设置页开启“全部自动允许”，所有工具都会跳过确认。
- Native Host 不通过 shell 拼接命令运行程序。
- 白名单存储在本机 Chrome 扩展存储中，不上传到第三方服务。
- 联网搜索会把查询词发送给所选搜索源；如使用 MCP，数据流由对应本地配置决定。
