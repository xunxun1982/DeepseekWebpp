package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type request struct {
	ID   any                    `json:"id,omitempty"`
	Type string                 `json:"type"`
	Tool string                 `json:"tool"`
	Args map[string]any         `json:"args"`
	Raw  map[string]interface{} `json:"-"`
}

type response struct {
	ID     any    `json:"id,omitempty"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type toolFunc func(map[string]any) (any, error)

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

var appVersion = "0.0.0-dev"
var fetchSearchTextFunc = fetchSearchText
var callMCPToolFunc = callMCPTool

const maxMCPResponseBytes = 64 * 1024 * 1024
const defaultMCPToolTimeoutMs = 600000
const searchRequestAttempts = 2
const defaultSearchProvider = "duckduckgo"
const searchRequestUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
const searchRequestAcceptLanguage = "zh-CN,zh;q=0.9,en;q=0.8"

var terminateProcessTreeFunc = terminateProcessTree

var tools = map[string]toolFunc{
	"list_files":      listFiles,
	"directory_info":  directoryInfo,
	"read_file":       readFile,
	"write_file":      writeFile,
	"edit_file":       editFile,
	"glob_search":     globSearch,
	"grep_search":     grepSearch,
	"file_exists":     fileExists,
	"remove_path":     removePath,
	"make_dir":        makeDir,
	"multi_file_edit": multiFileEdit,
	"run_program":     runProgram,
	"disk_info":       diskInfo,
	"web_fetch":       webFetch,
	"web_search":      webSearch,
	"weather":         weather,
	"world_time":      worldTime,
}

func main() {
	for {
		msg, err := readMessage(os.Stdin)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			writeMessage(os.Stdout, response{OK: false, Error: err.Error()})
			return
		}
		writeMessage(os.Stdout, handle(msg))
	}
}

func handle(req request) response {
	if req.Type != "tool.call" {
		return response{ID: req.ID, OK: false, Error: "Unsupported message type: " + req.Type}
	}
	handler := tools[req.Tool]
	if handler == nil {
		return response{ID: req.ID, OK: false, Error: "Unknown tool: " + req.Tool}
	}
	result, err := handler(req.Args)
	if err != nil {
		return response{ID: req.ID, OK: false, Error: err.Error()}
	}
	return response{ID: req.ID, OK: true, Result: result}
}

func readMessage(r io.Reader) (request, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return request{}, err
	}
	length := binary.LittleEndian.Uint32(header[:])
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return request{}, err
	}
	var req request
	err := json.Unmarshal(body, &req)
	return req, err
}

func writeMessage(w io.Writer, msg response) {
	body, _ := json.Marshal(msg)
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(body)))
	w.Write(header[:])
	w.Write(body)
}

func listFiles(args map[string]any) (any, error) {
	target, err := requireString(args, "path")
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]string, 0, len(entries))
	for _, entry := range entries {
		typ := "other"
		if entry.IsDir() {
			typ = "directory"
		} else if info, err := entry.Info(); err == nil && info.Mode().IsRegular() {
			typ = "file"
		}
		items = append(items, map[string]string{"name": entry.Name(), "type": typ})
	}
	return map[string]any{"path": target, "entries": items}, nil
}

func directoryInfo(args map[string]any) (any, error) {
	target, err := requireString(args, "path")
	if err != nil {
		return nil, err
	}
	rootInfo, err := os.Lstat(target)
	if err != nil {
		return nil, err
	}
	if !rootInfo.IsDir() {
		return nil, errors.New("path must be a directory")
	}
	var totalBytes int64
	var fileCount int64
	var directoryCount int64
	var skippedCount int64
	var errorCount int64
	err = walkWindowsDirectoryInfo(target, func(entry directoryInfoEntry) {
		if entry.isSkipped {
			skippedCount++
			return
		}
		if entry.isDirectory {
			directoryCount++
			return
		}
		fileCount++
		totalBytes += entry.size
	}, func() {
		errorCount++
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"path":           target,
		"totalBytes":     totalBytes,
		"totalGb":        bytesToGB(float64(totalBytes)),
		"fileCount":      fileCount,
		"directoryCount": directoryCount,
		"skippedCount":   skippedCount,
		"errorCount":     errorCount,
	}, nil
}

type directoryInfoEntry struct {
	isDirectory bool
	isSkipped   bool
	size        int64
}

func walkWindowsDirectoryInfo(root string, onEntry func(directoryInfoEntry), onError func()) error {
	const fileAttributeDirectory = 0x10
	const fileAttributeReparsePoint = 0x400

	pendingDirs := []string{root}
	for len(pendingDirs) > 0 {
		current := pendingDirs[len(pendingDirs)-1]
		pendingDirs = pendingDirs[:len(pendingDirs)-1]

		pattern, err := windowsFindPattern(current)
		if err != nil {
			return err
		}
		var data syscall.Win32finddata
		handle, err := syscall.FindFirstFile(pattern, &data)
		if err != nil {
			if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
				continue
			}
			onError()
			continue
		}
		for {
			name := syscall.UTF16ToString(data.FileName[:])
			if name != "." && name != ".." {
				attributes := data.FileAttributes
				if attributes&fileAttributeReparsePoint != 0 {
					onEntry(directoryInfoEntry{isSkipped: true})
				} else if attributes&fileAttributeDirectory != 0 {
					onEntry(directoryInfoEntry{isDirectory: true})
					pendingDirs = append(pendingDirs, filepath.Join(current, name))
				} else {
					size := int64(data.FileSizeHigh)<<32 | int64(data.FileSizeLow)
					onEntry(directoryInfoEntry{size: size})
				}
			}
			err = syscall.FindNextFile(handle, &data)
			if err == nil {
				continue
			}
			if !errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
				onError()
			}
			break
		}
		syscall.FindClose(handle)
	}
	return nil
}

func windowsFindPattern(dir string) (*uint16, error) {
	return syscall.UTF16PtrFromString(filepath.Join(dir, "*"))
}

func readFile(args map[string]any) (any, error) {
	target, err := requireString(args, "path")
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	content := string(data)
	if _, ok := args["startLine"]; !ok {
		if _, ok := args["endLine"]; !ok {
			return map[string]any{"path": target, "content": content}, nil
		}
	}
	lines := regexp.MustCompile(`\r?\n`).Split(content, -1)
	start := max(1, intArg(args, "startLine", 1))
	end := min(len(lines), intArg(args, "endLine", len(lines)))
	return map[string]any{"path": target, "startLine": start, "endLine": end, "content": strings.Join(lines[start-1:end], "\n")}, nil
}

func writeFile(args map[string]any) (any, error) {
	target, err := requireString(args, "path")
	if err != nil {
		return nil, err
	}
	content := stringArg(args, "content", "")
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(target, []byte(content), 0644); err != nil {
		return nil, err
	}
	return map[string]any{"path": target, "bytes": len([]byte(content))}, nil
}

func editFile(args map[string]any) (any, error) {
	target, err := requireString(args, "path")
	if err != nil {
		return nil, err
	}
	search, err := requireString(args, "search")
	if err != nil {
		return nil, err
	}
	replace := stringArg(args, "replace", "")
	data, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	content := string(data)
	count := strings.Count(content, search)
	if count == 0 {
		return nil, errors.New("search text not found")
	}
	next := strings.ReplaceAll(content, search, replace)
	if err := os.WriteFile(target, []byte(next), 0644); err != nil {
		return nil, err
	}
	return map[string]any{"path": target, "replacements": count}, nil
}

func globSearch(args map[string]any) (any, error) {
	root, err := requireString(args, "root")
	if err != nil {
		return nil, err
	}
	pattern, err := requireString(args, "pattern")
	if err != nil {
		return nil, err
	}
	re, err := globRegexp(pattern)
	if err != nil {
		return nil, err
	}
	files, err := walkFiles(root)
	if err != nil {
		return nil, err
	}
	var matches []string
	for _, file := range files {
		rel, _ := filepath.Rel(root, file)
		rel = filepath.ToSlash(rel)
		if re.MatchString(rel) {
			matches = append(matches, rel)
		}
	}
	return map[string]any{"root": root, "pattern": pattern, "matches": matches}, nil
}

func grepSearch(args map[string]any) (any, error) {
	root, err := requireString(args, "root")
	if err != nil {
		return nil, err
	}
	pattern, err := requireString(args, "pattern")
	if err != nil {
		return nil, err
	}
	glob := stringArg(args, "glob", "**/*")
	globRe, err := globRegexp(glob)
	if err != nil {
		return nil, err
	}
	flags := ""
	if !boolArg(args, "caseSensitive", false) {
		flags = "(?i)"
	}
	textRe, err := regexp.Compile(flags + pattern)
	if err != nil {
		return nil, err
	}
	files, err := walkFiles(root)
	if err != nil {
		return nil, err
	}
	var matches []map[string]any
	for _, file := range files {
		rel, _ := filepath.Rel(root, file)
		rel = filepath.ToSlash(rel)
		if !globRe.MatchString(rel) {
			continue
		}
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for index, line := range regexp.MustCompile(`\r?\n`).Split(string(data), -1) {
			if textRe.MatchString(line) {
				matches = append(matches, map[string]any{"path": rel, "line": index + 1, "text": line})
			}
		}
	}
	return map[string]any{"root": root, "pattern": pattern, "matches": matches}, nil
}

func fileExists(args map[string]any) (any, error) {
	target, err := requireString(args, "path")
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{"path": target, "exists": false}, nil
		}
		return nil, err
	}
	typ := "other"
	if info.IsDir() {
		typ = "directory"
	} else if info.Mode().IsRegular() {
		typ = "file"
	}
	return map[string]any{"path": target, "exists": true, "type": typ}, nil
}

func removePath(args map[string]any) (any, error) {
	target, err := requireString(args, "path")
	if err != nil {
		return nil, err
	}
	recursive := boolArg(args, "recursive", false)
	force := boolArg(args, "force", false)
	if recursive {
		err = os.RemoveAll(target)
	} else {
		err = os.Remove(target)
	}
	if err != nil && !(force && os.IsNotExist(err)) {
		return nil, err
	}
	return map[string]any{"path": target, "removed": true}, nil
}

func makeDir(args map[string]any) (any, error) {
	target, err := requireString(args, "path")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(target, 0755); err != nil {
		return nil, err
	}
	return map[string]any{"path": target, "created": true}, nil
}

func multiFileEdit(args map[string]any) (any, error) {
	edits, ok := args["edits"].([]any)
	if !ok || len(edits) == 0 {
		return nil, errors.New("edits is required")
	}
	var files []any
	for _, item := range edits {
		edit, ok := item.(map[string]any)
		if !ok {
			return nil, errors.New("invalid edit item")
		}
		result, err := editFile(edit)
		if err != nil {
			return nil, err
		}
		files = append(files, result)
	}
	return map[string]any{"files": files}, nil
}

func runProgram(args map[string]any) (any, error) {
	executable, err := requireString(args, "executable")
	if err != nil {
		return nil, err
	}
	programArgs := stringSliceArg(args, "args")
	wait := len(programArgs) > 0
	if value, ok := args["wait"].(bool); ok {
		wait = value
	}
	timeoutMs := intArg(args, "timeoutMs", 30000)
	executable = resolveExecutable(executable)

	if !wait {
		cmd := exec.Command(executable, programArgs...)
		if cwd := stringArg(args, "cwd", ""); cwd != "" {
			cmd.Dir = cwd
		}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		return map[string]any{"started": true, "pid": cmd.Process.Pid, "detached": true}, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, programArgs...)
	if cwd := stringArg(args, "cwd", ""); cwd != "" {
		cmd.Dir = cwd
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	timedOut := ctx.Err() == context.DeadlineExceeded
	exitCode := 0
	if err != nil {
		exitCode = 1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else if !timedOut {
			return nil, err
		}
	}
	return map[string]any{"exitCode": exitCode, "stdout": stdout.String(), "stderr": stderr.String(), "timedOut": timedOut}, nil
}

func resolveExecutable(executable string) string {
	value := strings.TrimSpace(executable)
	if value == "" || strings.ContainsAny(value, `\/`) || filepath.IsAbs(value) {
		return executable
	}
	names := executableNames(value)
	for _, name := range names {
		if found, err := exec.LookPath(name); err == nil && found != "" {
			return found
		}
	}
	if runtime.GOOS == "windows" {
		for _, name := range names {
			if found := lookupAppPathRegistry(name); found != "" {
				return found
			}
		}
		for _, candidate := range commonExecutableCandidates(names) {
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}
	return executable
}

func executableNames(value string) []string {
	aliases := map[string]string{
		"word":       "WINWORD.EXE",
		"winword":    "WINWORD.EXE",
		"excel":      "EXCEL.EXE",
		"powerpoint": "POWERPNT.EXE",
		"powerpnt":   "POWERPNT.EXE",
		"ppt":        "POWERPNT.EXE",
		"wps":        "wps.exe",
		"et":         "et.exe",
		"wpp":        "wpp.exe",
	}
	primary := value
	if alias, ok := aliases[strings.ToLower(value)]; ok {
		primary = alias
	}
	names := []string{primary}
	if filepath.Ext(primary) == "" {
		if runtime.GOOS == "windows" {
			names = append([]string{primary + ".exe", primary + ".cmd"}, names...)
		} else {
			names = append(names, primary+".exe")
			names = append(names, primary+".cmd")
		}
	}
	return uniqueStrings(names)
}

func lookupAppPathRegistry(executable string) string {
	keys := []string{
		`HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\` + executable,
		`HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\` + executable,
		`HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\` + executable,
	}
	for _, key := range keys {
		out, err := exec.Command("reg.exe", "query", key, "/ve").Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(out), "\n") {
			if !strings.Contains(strings.ToUpper(line), "REG_SZ") {
				continue
			}
			parts := strings.SplitN(line, "REG_SZ", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return ""
}

func commonExecutableCandidates(names []string) []string {
	roots := []string{
		os.Getenv("ProgramFiles"),
		os.Getenv("ProgramFiles(x86)"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs"),
		`C:\Program Files`,
		`C:\Program Files (x86)`,
		`D:\Program Files`,
		`D:\Program Files (x86)`,
	}
	subdirs := []string{
		`Microsoft Office\root\Office16`,
		`Microsoft Office\Office16`,
		`Kingsoft\WPS Office\office6`,
	}
	npmRoots := []string{
		filepath.Join(os.Getenv("APPDATA"), "npm"),
		`C:\Users\User\AppData\Roaming\npm`,
	}
	var candidates []string
	for _, root := range roots {
		if strings.TrimSpace(root) == "" {
			continue
		}
		for _, subdir := range subdirs {
			for _, name := range names {
				candidates = append(candidates, filepath.Join(root, subdir, name))
			}
		}
	}
	for _, root := range npmRoots {
		if strings.TrimSpace(root) == "" {
			continue
		}
		for _, name := range names {
			candidates = append(candidates, filepath.Join(root, name))
		}
	}
	return candidates
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	var result []string
	for _, value := range values {
		key := strings.ToLower(value)
		if seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, value)
	}
	return result
}

func diskInfo(args map[string]any) (any, error) {
	if runtime.GOOS != "windows" {
		return nil, errors.New("disk_info is only implemented on Windows")
	}
	out, err := runProgram(map[string]any{
		"executable": "powershell.exe",
		"args": []any{
			"-NoProfile",
			"-Command",
			"Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | Select-Object DeviceID,Size,FreeSpace,VolumeName | ConvertTo-Json -Compress",
		},
		"timeoutMs": 10000,
	})
	if err != nil {
		return nil, err
	}
	result := out.(map[string]any)
	if int(result["exitCode"].(int)) != 0 {
		return nil, errors.New(result["stderr"].(string))
	}
	var parsed any
	if err := json.Unmarshal([]byte(result["stdout"].(string)), &parsed); err != nil {
		return nil, err
	}
	items, ok := parsed.([]any)
	if !ok {
		items = []any{parsed}
	}
	var disks []map[string]any
	for _, item := range items {
		disk, ok := item.(map[string]any)
		if !ok {
			continue
		}
		size := floatArg(disk, "Size", 0)
		free := floatArg(disk, "FreeSpace", 0)
		used := math.Max(0, size-free)
		disks = append(disks, map[string]any{
			"deviceId":   stringArg(disk, "DeviceID", ""),
			"volumeName": stringArg(disk, "VolumeName", ""),
			"sizeBytes":  size,
			"freeBytes":  free,
			"usedBytes":  used,
			"sizeGb":     bytesToGB(size),
			"freeGb":     bytesToGB(free),
			"usedGb":     bytesToGB(used),
		})
	}
	return map[string]any{"disks": disks}, nil
}

func webFetch(args map[string]any) (any, error) {
	target, err := requireString(args, "url")
	if err != nil {
		return nil, err
	}
	resp, text, err := fetchText(target)
	if err != nil {
		return nil, err
	}
	maxChars := intArg(args, "maxChars", 12000)
	return map[string]any{"ok": resp.StatusCode >= 200 && resp.StatusCode < 300, "status": resp.StatusCode, "url": resp.Request.URL.String(), "text": truncate(stripHTML(text), maxChars)}, nil
}

func webSearch(args map[string]any) (any, error) {
	query, err := requireString(args, "query")
	if err != nil {
		return nil, err
	}
	provider := strings.ToLower(stringArg(args, "provider", defaultSearchProvider))
	if provider == "mcp" {
		result, err := webSearchMCP(query, args)
		if err != nil {
			return webSearchFallbackChain(query, args, "mcp", err)
		}
		if mcpResult, ok := result.(map[string]any); ok {
			if mcpErr := mcpSearchError(mapArg(mcpResult, "result")); mcpErr != "" {
				return webSearchFallbackChain(query, args, "mcp", errors.New(mcpErr))
			}
			if !hasSearchResults(mcpResult) {
				return webSearchFallbackChain(query, args, "mcp", errors.New(mcpEmptyResultMessage(mapArg(mcpResult, "result"))))
			}
		}
		return result, nil
	}
	tpl := stringArg(args, "searchUrl", defaultSearchURL(provider))
	searchURL := replaceQueryPlaceholders(tpl, query)
	resp, html, err := fetchSearchTextWithRetry(searchURL, provider)
	if err != nil {
		return nil, err
	}
	limit := intArg(args, "limit", 20)
	results := extractSearchResults(html)
	if len(results) > limit {
		results = results[:limit]
	}
	if include, ok := args["includeContent"].(bool); !ok || include {
		addExcerpts(results, intArg(args, "contentResults", 3), intArg(args, "maxContentChars", 2000))
	}
	return map[string]any{
		"ok":       resp.StatusCode >= 200 && resp.StatusCode < 300,
		"status":   resp.StatusCode,
		"provider": provider,
		"url":      resp.Request.URL.String(),
		"guidance": "Answer from these search results when they contain enough title, snippet, date, and excerpt context. Do not call web_fetch automatically unless the user explicitly asks to read a link or the excerpts are insufficient.",
		"results":  results,
	}, nil
}

func webSearchFallbackChain(query string, args map[string]any, fallbackFrom string, fallbackErr error) (any, error) {
	fallbackProviders := []string{"bing", "duckduckgo"}
	var failures []string
	for _, provider := range fallbackProviders {
		fallbackArgs := map[string]any{}
		for key, value := range args {
			fallbackArgs[key] = value
		}
		fallbackArgs["provider"] = provider
		fallbackArgs["searchUrl"] = defaultSearchURL(provider)
		delete(fallbackArgs, "mcp")
		result, err := webSearch(fallbackArgs)
		if err != nil {
			failures = append(failures, provider+": "+err.Error())
			continue
		}
		payload, ok := result.(map[string]any)
		if !ok {
			return result, nil
		}
		if !hasSearchResults(payload) {
			failures = append(failures, provider+": empty results")
			continue
		}
		payload["fallbackFrom"] = fallbackFrom
		payload["fallbackError"] = fallbackErr.Error()
		payload["fallbackProviders"] = fallbackProviders
		return payload, nil
	}
	return nil, fmt.Errorf("%s search failed: %v; fallback failed: %s", fallbackFrom, fallbackErr, strings.Join(failures, "; "))
}

func hasSearchResults(payload map[string]any) bool {
	switch results := payload["results"].(type) {
	case []map[string]any:
		return len(results) > 0
	case []any:
		return len(results) > 0
	default:
		return false
	}
}

func webSearchMCP(query string, args map[string]any) (any, error) {
	mcp := mapArg(args, "mcp")
	server := resolveMCPServer(mcp)
	tool := stringArg(mcp, "tool", "web_search")
	toolArgs := mapArg(mcp, "arguments")
	toolArgs["query"] = query
	result, err := callMCPToolFunc(server, tool, toolArgs)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":       true,
		"provider": "mcp",
		"mcpTool":  tool,
		"guidance": "Answer from the stdio MCP search result. GrokSearch-rs and compatible MCP servers usually return a synthesized answer plus sources.",
		"result":   result,
		"results":  normalizeMCPSearchResults(result),
	}, nil
}

func mcpSearchError(result map[string]any) string {
	for _, candidate := range mcpPayloadObjects(result) {
		if okValue, exists := candidate["ok"]; exists {
			if ok, isBool := okValue.(bool); isBool && !ok {
				if message := stringArg(candidate, "error", ""); message != "" {
					return message
				}
				return stringArg(candidate, "message", "")
			}
		}
		if message := stringArg(candidate, "error", ""); message != "" && !hasMCPPayloadResults(candidate) {
			return message
		}
		if isError, ok := candidate["isError"].(bool); ok && isError {
			if message := stringArg(candidate, "error", ""); message != "" {
				return message
			}
			if message := stringArg(candidate, "message", ""); message != "" {
				return message
			}
			if message := firstMCPContentText(candidate); message != "" {
				return message
			}
		}
	}
	return ""
}

func mcpEmptyResultMessage(result map[string]any) string {
	for _, candidate := range mcpPayloadObjects(result) {
		if text := strings.TrimSpace(firstMCPContentText(candidate)); text != "" {
			if len(text) > 500 {
				text = text[:500]
			}
			return "MCP search returned empty results: " + text
		}
	}
	return "MCP search returned empty results"
}

func resolveMCPServer(mcp map[string]any) map[string]any {
	servers := mapArg(mcp, "mcpServers")
	if len(servers) == 0 {
		return mcp
	}
	serverName := stringArg(mcp, "server", "")
	if serverName == "" {
		for key := range servers {
			serverName = key
			break
		}
	}
	server := mapArg(servers, serverName)
	if len(server) == 0 {
		return mcp
	}
	if _, ok := server["timeoutMs"]; !ok {
		if timeout, ok := mcp["timeoutMs"]; ok {
			server["timeoutMs"] = timeout
		}
	}
	return server
}

func callMCPTool(mcp map[string]any, tool string, toolArgs map[string]any) (any, error) {
	command, err := requireString(mcp, "command")
	if err != nil {
		return nil, err
	}
	resolvedCommand := resolveExecutable(command)
	if resolvedCommand == command && !strings.ContainsAny(command, `\/`) && !filepath.IsAbs(command) {
		return nil, fmt.Errorf("MCP tool command not found: %s", command)
	}
	timeout := time.Duration(intArg(mcp, "timeoutMs", defaultMCPToolTimeoutMs)) * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	commandArgs := stringSliceArg(mcp, "args")
	if runtime.GOOS == "windows" && isWindowsCommandShim(resolvedCommand) {
		commandArgs = append([]string{"/d", "/s", "/c", resolvedCommand}, commandArgs...)
		resolvedCommand = "cmd.exe"
	}
	cmd := exec.CommandContext(ctx, resolvedCommand, commandArgs...)
	if cwd := stringArg(mcp, "cwd", ""); cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = os.Environ()
	for key, value := range stringMapArg(mcp, "env") {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			stopMCPProcess(cmd)
			_ = stdout.Close()
			_ = stdin.Close()
		})
	}
	defer stop()
	go func() {
		<-ctx.Done()
		stop()
	}()
	writeJSONLine(stdin, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "DeepseekWebpp", "version": appVersion}}})
	writeJSONLine(stdin, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized", "params": map[string]any{}})
	writeJSONLine(stdin, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": toolArgs}})

	reader := bufio.NewReader(stdout)
	for {
		line, err := readMCPJSONLine(reader, maxMCPResponseBytes)
		if err != nil {
			stop()
			if ctx.Err() != nil {
				return nil, fmt.Errorf("mcp timeout after %s", timeout)
			}
			if errors.Is(err, io.EOF) {
				return nil, fmt.Errorf("mcp process exited before response: %s", strings.TrimSpace(stderr.String()))
			}
			return nil, err
		}
		var message map[string]any
		if err := json.Unmarshal(line, &message); err != nil {
			continue
		}
		if int(floatArg(message, "id", 0)) != 2 {
			continue
		}
		stop()
		if errValue, ok := message["error"]; ok {
			return nil, fmt.Errorf("mcp error: %v", errValue)
		}
		result := mapArg(message, "result")
		if structured, ok := result["structuredContent"]; ok {
			return structured, nil
		}
		if parsed := parseMCPTextContent(result["content"]); parsed != nil {
			return parsed, nil
		}
		return result, nil
	}
}

func stopMCPProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = terminateProcessTreeFunc(cmd.Process.Pid)
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

func readMCPJSONLine(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	var line []byte
	for {
		part, isPrefix, err := reader.ReadLine()
		if len(part) > 0 {
			if len(line)+len(part) > maxBytes {
				return nil, fmt.Errorf("MCP response line exceeds %d bytes", maxBytes)
			}
			line = append(line, part...)
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) > 0 {
				return line, nil
			}
			return nil, err
		}
		if !isPrefix {
			return line, nil
		}
	}
}

func collectProcessTreePIDs(root int, parentByPID map[int]int) []int {
	childrenByParent := map[int][]int{}
	for pid, parent := range parentByPID {
		childrenByParent[parent] = append(childrenByParent[parent], pid)
	}
	for parent := range childrenByParent {
		sort.Ints(childrenByParent[parent])
	}
	visited := map[int]bool{}
	var out []int
	var walk func(int)
	walk = func(pid int) {
		if visited[pid] {
			return
		}
		visited[pid] = true
		out = append(out, pid)
		for _, child := range childrenByParent[pid] {
			walk(child)
		}
	}
	walk(root)
	return out
}

func isWindowsCommandShim(command string) bool {
	extension := strings.ToLower(filepath.Ext(command))
	return extension == ".cmd" || extension == ".bat"
}

func writeJSONLine(w io.Writer, value any) {
	encoded, _ := json.Marshal(value)
	_, _ = w.Write(append(encoded, '\n'))
}

func parseMCPTextContent(value any) any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	for _, item := range items {
		part, ok := item.(map[string]any)
		if !ok || stringArg(part, "type", "") != "text" {
			continue
		}
		text := stringArg(part, "text", "")
		var parsed any
		if json.Unmarshal([]byte(text), &parsed) == nil {
			return parsed
		}
		return map[string]any{"content": text}
	}
	return nil
}

func defaultSearchURL(provider string) string {
	if provider == "duckduckgo" {
		return "https://html.duckduckgo.com/html/?q={query}"
	}
	return "https://www.bing.com/search?q={query}"
}

func replaceQueryPlaceholders(value string, query string) string {
	encodedQuery := strings.ReplaceAll(url.QueryEscape(query), "+", "%20")
	value = strings.ReplaceAll(value, "{query}", encodedQuery)
	return strings.ReplaceAll(value, "{queryRaw}", query)
}

func normalizeMCPSearchResults(value any) []map[string]any {
	for _, root := range mcpPayloadObjects(value) {
		sources := anySliceArg(root["sources"])
		if len(sources) == 0 {
			sources = anySliceArg(root["results"])
		}
		var results []map[string]any
		for _, source := range sources {
			item, ok := source.(map[string]any)
			if !ok {
				continue
			}
			title := firstString(item, "title", "name", "url")
			link := stringArg(item, "url", "")
			result := map[string]any{"title": title, "url": link}
			if snippet := firstString(item, "snippet", "description", "content"); snippet != "" {
				result["snippet"] = snippet
			}
			if date := firstString(item, "date", "published_date"); date != "" {
				result["date"] = date
			}
			results = append(results, result)
		}
		if len(results) > 0 {
			return results
		}
	}
	return nil
}

func mcpPayloadObjects(value any) []map[string]any {
	root, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	payloads := []map[string]any{root}
	if structured := mapArg(root, "structuredContent"); len(structured) > 0 {
		payloads = append(payloads, structured)
	}
	for _, item := range anySliceArg(root["content"]) {
		text := ""
		switch typed := item.(type) {
		case string:
			text = typed
		case map[string]any:
			text = stringArg(typed, "text", "")
		}
		if parsed := parseJSONObject(text); len(parsed) > 0 {
			payloads = append(payloads, parsed)
		}
	}
	if text, ok := root["content"].(string); ok {
		if parsed := parseJSONObject(text); len(parsed) > 0 {
			payloads = append(payloads, parsed)
		}
	}
	return payloads
}

func parseJSONObject(value string) map[string]any {
	text := strings.TrimSpace(value)
	if text == "" || !strings.HasPrefix(text, "{") {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return nil
	}
	return parsed
}

func anySliceArg(value any) []any {
	switch typed := value.(type) {
	case []any:
		return typed
	case []map[string]any:
		items := make([]any, 0, len(typed))
		for _, item := range typed {
			items = append(items, item)
		}
		return items
	default:
		return nil
	}
}

func hasMCPPayloadResults(payload map[string]any) bool {
	for _, key := range []string{"results", "sources"} {
		if len(anySliceArg(payload[key])) > 0 {
			return true
		}
	}
	return false
}

func firstMCPContentText(payload map[string]any) string {
	if text, ok := payload["content"].(string); ok {
		return text
	}
	for _, item := range anySliceArg(payload["content"]) {
		switch typed := item.(type) {
		case string:
			return typed
		case map[string]any:
			if text := stringArg(typed, "text", ""); text != "" {
				return text
			}
		}
	}
	return ""
}

func weather(args map[string]any) (any, error) {
	location, defaulted, err := resolveLocation(args, true)
	if err != nil {
		return nil, err
	}
	params := url.Values{}
	params.Set("latitude", fmt.Sprint(location.Latitude))
	params.Set("longitude", fmt.Sprint(location.Longitude))
	params.Set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m")
	params.Set("timezone", location.Timezone)
	var data map[string]any
	if err := fetchJSON("https://api.open-meteo.com/v1/forecast?"+params.Encode(), &data); err != nil {
		return nil, err
	}
	current, _ := data["current"].(map[string]any)
	code := int(floatArg(current, "weather_code", -1))
	return map[string]any{
		"defaulted": defaulted,
		"provider":  "Open-Meteo",
		"location":  publicLocation(location),
		"current": map[string]any{
			"time":                 stringArg(current, "time", ""),
			"temperatureC":         nullableNumber(current["temperature_2m"]),
			"apparentTemperatureC": nullableNumber(current["apparent_temperature"]),
			"humidityPercent":      nullableNumber(current["relative_humidity_2m"]),
			"weatherCode":          nullableNumber(current["weather_code"]),
			"weatherText":          weatherCodeText(code),
			"windSpeedKmh":         nullableNumber(current["wind_speed_10m"]),
		},
	}, nil
}

func worldTime(args map[string]any) (any, error) {
	now := time.Now()
	if strings.TrimSpace(stringArg(args, "location", "")) == "" {
		beijing := now.UTC().Add(8 * time.Hour)
		location := locationInfo{Name: "北京", Country: "中国", Latitude: 39.9042, Longitude: 116.4074, Timezone: "Asia/Shanghai"}
		return map[string]any{
			"defaulted": true,
			"provider":  "local-system-clock",
			"location":  publicLocation(location),
			"timeZone":  location.Timezone,
			"date":      beijing.Format("2006/01/02"),
			"time":      beijing.Format("15:04:05"),
			"iso":       now.UTC().Format(time.RFC3339Nano),
		}, nil
	}

	location, _, err := resolveLocation(args, false)
	if err != nil {
		return nil, err
	}
	localTime, timezone, err := openMeteoLocalTime(location)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(localTime, "T")
	dateText := strings.ReplaceAll(parts[0], "-", "/")
	timeText := ""
	if len(parts) > 1 {
		timeText = parts[1]
		if len(timeText) == 5 {
			timeText += ":00"
		}
	}
	return map[string]any{
		"defaulted": false,
		"provider":  "local-system-clock",
		"location":  publicLocation(location),
		"timeZone":  timezone,
		"date":      dateText,
		"time":      timeText,
		"iso":       now.UTC().Format(time.RFC3339Nano),
	}, nil
}

func openMeteoLocalTime(location locationInfo) (string, string, error) {
	params := url.Values{}
	params.Set("latitude", fmt.Sprint(location.Latitude))
	params.Set("longitude", fmt.Sprint(location.Longitude))
	params.Set("current", "temperature_2m")
	params.Set("timezone", "auto")
	var data map[string]any
	if err := fetchJSON("https://api.open-meteo.com/v1/forecast?"+params.Encode(), &data); err != nil {
		return "", "", err
	}
	current, _ := data["current"].(map[string]any)
	localTime := stringArg(current, "time", "")
	if localTime == "" {
		return "", "", errors.New("weather API did not return local time")
	}
	return localTime, stringArg(data, "timezone", location.Timezone), nil
}

type locationInfo struct {
	Name      string
	Country   string
	Latitude  float64
	Longitude float64
	Timezone  string
}

func resolveLocation(args map[string]any, defaultLocal bool) (locationInfo, bool, error) {
	if text := strings.TrimSpace(stringArg(args, "location", "")); text != "" {
		location, err := geocode(text)
		return location, false, err
	}
	if !defaultLocal {
		return locationInfo{Name: "北京", Country: "中国", Latitude: 39.9042, Longitude: 116.4074, Timezone: "Asia/Shanghai"}, true, nil
	}
	var data map[string]any
	if err := fetchJSON("https://ipwho.is/", &data); err != nil {
		return locationInfo{}, true, err
	}
	tz := "auto"
	if timezone, ok := data["timezone"].(map[string]any); ok {
		tz = stringArg(timezone, "id", "auto")
	}
	return locationInfo{
		Name:      stringArg(data, "city", "当地"),
		Country:   stringArg(data, "country", ""),
		Latitude:  floatArg(data, "latitude", 0),
		Longitude: floatArg(data, "longitude", 0),
		Timezone:  tz,
	}, true, nil
}

func geocode(name string) (locationInfo, error) {
	params := url.Values{}
	params.Set("name", name)
	params.Set("count", "1")
	params.Set("language", "zh")
	params.Set("format", "json")
	var data map[string]any
	if err := fetchJSON("https://geocoding-api.open-meteo.com/v1/search?"+params.Encode(), &data); err != nil {
		return locationInfo{}, err
	}
	results, _ := data["results"].([]any)
	if len(results) > 0 {
		first, _ := results[0].(map[string]any)
		return locationInfo{
			Name:      stringArg(first, "name", name),
			Country:   stringArg(first, "country", ""),
			Latitude:  floatArg(first, "latitude", 0),
			Longitude: floatArg(first, "longitude", 0),
			Timezone:  stringArg(first, "timezone", "UTC"),
		}, nil
	}
	if fallback, err := geocodeFallback(name); err == nil {
		return fallback, nil
	}
	return locationInfo{}, fmt.Errorf("location not found: %s", name)
}

func geocodeFallback(name string) (locationInfo, error) {
	params := url.Values{}
	params.Set("q", name)
	params.Set("format", "json")
	params.Set("limit", "1")
	params.Set("addressdetails", "1")
	req, err := http.NewRequest("GET", "https://nominatim.openstreetmap.org/search?"+params.Encode(), nil)
	if err != nil {
		return locationInfo{}, err
	}
	req.Header.Set("User-Agent", "DeepseekWebpp/"+appVersion)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return locationInfo{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return locationInfo{}, fmt.Errorf("fallback geocoding failed with status %d", resp.StatusCode)
	}
	var results []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&results); err != nil {
		return locationInfo{}, err
	}
	if len(results) == 0 {
		return locationInfo{}, errors.New("fallback geocoding returned no results")
	}
	first := results[0]
	latitude, _ := strconv.ParseFloat(stringArg(first, "lat", "0"), 64)
	longitude, _ := strconv.ParseFloat(stringArg(first, "lon", "0"), 64)
	if latitude == 0 && longitude == 0 {
		return locationInfo{}, errors.New("fallback geocoding returned invalid coordinates")
	}
	timezone, err := fetchTimezone(latitude, longitude)
	if err != nil {
		timezone = "UTC"
	}
	country := ""
	if address, ok := first["address"].(map[string]any); ok {
		country = stringArg(address, "country", "")
	}
	displayName := stringArg(first, "display_name", name)
	return locationInfo{
		Name:      strings.TrimSpace(strings.Split(displayName, ",")[0]),
		Country:   country,
		Latitude:  latitude,
		Longitude: longitude,
		Timezone:  timezone,
	}, nil
}

func fetchTimezone(latitude float64, longitude float64) (string, error) {
	params := url.Values{}
	params.Set("latitude", strconv.FormatFloat(latitude, 'f', -1, 64))
	params.Set("longitude", strconv.FormatFloat(longitude, 'f', -1, 64))
	params.Set("current", "temperature_2m")
	params.Set("timezone", "auto")
	var data map[string]any
	if err := fetchJSON("https://api.open-meteo.com/v1/forecast?"+params.Encode(), &data); err != nil {
		return "", err
	}
	return stringArg(data, "timezone", "UTC"), nil
}

func publicLocation(location locationInfo) map[string]any {
	return map[string]any{"name": location.Name, "country": location.Country, "latitude": location.Latitude, "longitude": location.Longitude, "timezone": location.Timezone}
}

func fetchJSON(target string, out any) error {
	resp, err := http.Get(target)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("request failed with status %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func fetchText(target string) (*http.Response, string, error) {
	req, err := newFetchRequest(target, "")
	if err != nil {
		return nil, "", err
	}
	return fetchTextWithFallback(req, textHTTPClients())
}

func fetchSearchText(target string, provider string) (*http.Response, string, error) {
	req, err := newFetchRequest(target, provider)
	if err != nil {
		return nil, "", err
	}
	return fetchTextWithFallback(req, textHTTPClients())
}

func fetchSearchTextWithRetry(target string, provider string) (*http.Response, string, error) {
	var lastErr error
	for attempt := 0; attempt < searchRequestAttempts; attempt++ {
		resp, text, err := fetchSearchTextFunc(target, provider)
		if err == nil {
			return resp, text, nil
		}
		lastErr = err
	}
	return nil, "", lastErr
}

func textHTTPClients() []httpDoer {
	return []httpDoer{
		&http.Client{Timeout: 20 * time.Second},
		&http.Client{Timeout: 20 * time.Second, Transport: http1Transport(http.ProxyFromEnvironment)},
		&http.Client{Timeout: 20 * time.Second, Transport: http1Transport(func(*http.Request) (*url.URL, error) { return nil, nil })},
	}
}

func http1Transport(proxy func(*http.Request) (*url.URL, error)) *http.Transport {
	return &http.Transport{
		Proxy:        proxy,
		TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{},
	}
}

func fetchTextWithFallback(req *http.Request, clients []httpDoer) (*http.Response, string, error) {
	var lastErr error
	for _, client := range clients {
		attempt := req.Clone(req.Context())
		resp, err := client.Do(attempt)
		if err != nil {
			if resp != nil && resp.Body != nil {
				resp.Body.Close()
			}
			lastErr = err
			continue
		}
		if resp.Request == nil {
			resp.Request = attempt
		}
		readResp, text, err := readTextResponse(resp)
		if err != nil {
			lastErr = err
			continue
		}
		return readResp, text, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no HTTP clients configured")
	}
	return nil, "", lastErr
}

func readTextResponse(resp *http.Response) (*http.Response, string, error) {
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	return resp, string(data), err
}

func newTextRequest(target string) (*http.Request, error) {
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", searchRequestUserAgent)
	req.Header.Set("Accept-Language", searchRequestAcceptLanguage)
	return req, nil
}

func newFetchRequest(target string, provider string) (*http.Request, error) {
	if provider == "duckduckgo" || isDuckDuckGoURL(target) {
		return newTextRequest(target)
	}
	return http.NewRequest(http.MethodGet, target, nil)
}

func isDuckDuckGoURL(target string) bool {
	parsed, err := url.Parse(target)
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.ToLower(parsed.Hostname()), "duckduckgo.com")
}

func extractSearchResults(html string) []map[string]any {
	results := []map[string]any{}
	bingBlock := regexp.MustCompile(`(?is)<li[^>]+class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>.*?</li>`)
	bingLink := regexp.MustCompile(`(?is)<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>\s*</h2>`)
	bingCaption := regexp.MustCompile(`(?is)<div[^>]+class=["'][^"']*\bb_caption\b[^"']*["'][^>]*>.*?<p[^>]*>(.*?)</p>`)
	anyParagraph := regexp.MustCompile(`(?is)<p[^>]*>(.*?)</p>`)
	for _, block := range bingBlock.FindAllString(html, -1) {
		link := bingLink.FindStringSubmatch(block)
		if len(link) == 0 {
			continue
		}
		snippet := ""
		if caption := bingCaption.FindStringSubmatch(block); len(caption) > 1 {
			snippet = caption[1]
		} else if paragraph := anyParagraph.FindStringSubmatch(block); len(paragraph) > 1 {
			snippet = paragraph[1]
		}
		results = append(results, searchResult(link[2], link[1], snippet))
	}
	duck := regexp.MustCompile(`(?is)<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>`)
	for _, match := range duck.FindAllStringSubmatch(html, -1) {
		results = append(results, searchResult(match[2], match[1], ""))
	}
	seen := map[string]bool{}
	var unique []map[string]any
	for _, result := range results {
		link := fmt.Sprint(result["url"])
		if link == "" || seen[link] {
			continue
		}
		seen[link] = true
		unique = append(unique, result)
	}
	return unique
}

func searchResult(title, link, snippet string) map[string]any {
	result := map[string]any{"title": compactWhitespace(decodeHTML(stripHTML(title))), "url": normalizeSearchResultURL(link)}
	clean := compactWhitespace(decodeHTML(stripHTML(snippet)))
	if clean != "" {
		result["snippet"] = clean
		if date := extractDate(clean); date != "" {
			result["date"] = date
		}
	}
	return result
}

func normalizeSearchResultURL(value string) string {
	decoded := decodeHTML(value)
	if decoded == "" {
		return ""
	}
	absoluteURL := decoded
	if strings.HasPrefix(absoluteURL, "//") {
		absoluteURL = "https:" + absoluteURL
	}
	parsed, err := url.Parse(absoluteURL)
	if err != nil || parsed.Hostname() == "" {
		return decoded
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.HasSuffix(host, "duckduckgo.com") && parsed.Path == "/l/" {
		if target := parsed.Query().Get("uddg"); target != "" {
			return target
		}
	}
	if strings.HasSuffix(host, "bing.com") && parsed.Path == "/ck/a" {
		if target := decodeBingRedirectTarget(parsed.Query().Get("u")); target != "" {
			return target
		}
	}
	return parsed.String()
}

func decodeBingRedirectTarget(value string) string {
	if value == "" {
		return ""
	}
	raw := decodeHTML(value)
	if strings.HasPrefix(strings.ToLower(raw), "http://") || strings.HasPrefix(strings.ToLower(raw), "https://") {
		return raw
	}
	candidates := []string{raw}
	if strings.HasPrefix(raw, "a1") {
		candidates = append([]string{raw[2:]}, candidates...)
	}
	for _, candidate := range candidates {
		if decoded, err := base64.RawURLEncoding.DecodeString(candidate); err == nil {
			text := string(decoded)
			if strings.HasPrefix(strings.ToLower(text), "http://") || strings.HasPrefix(strings.ToLower(text), "https://") {
				return text
			}
		}
		if decoded, err := base64.URLEncoding.DecodeString(candidate); err == nil {
			text := string(decoded)
			if strings.HasPrefix(strings.ToLower(text), "http://") || strings.HasPrefix(strings.ToLower(text), "https://") {
				return text
			}
		}
	}
	return ""
}

func addExcerpts(results []map[string]any, count int, maxChars int) {
	count = min(count, len(results))
	for i := 0; i < count; i++ {
		link := fmt.Sprint(results[i]["url"])
		if !strings.HasPrefix(strings.ToLower(link), "http") {
			continue
		}
		_, text, err := fetchText(link)
		if err == nil {
			results[i]["excerpt"] = truncate(stripHTML(text), max(200, min(maxChars, 8000)))
		}
	}
}

func walkFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && (entry.Name() == "node_modules" || entry.Name() == ".git") {
			return filepath.SkipDir
		}
		if !entry.IsDir() {
			files = append(files, current)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

func globRegexp(pattern string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		if ch == '*' && i+1 < len(pattern) && pattern[i+1] == '*' {
			b.WriteString(".*")
			i++
		} else if ch == '*' {
			b.WriteString(`[^/]*`)
		} else if ch == '?' {
			b.WriteByte('.')
		} else {
			b.WriteString(regexp.QuoteMeta(string(ch)))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

func requireString(args map[string]any, key string) (string, error) {
	value := strings.TrimSpace(stringArg(args, key, ""))
	if value == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return value, nil
}

func stringArg(args map[string]any, key string, fallback string) string {
	if value, ok := args[key]; ok && value != nil {
		return fmt.Sprint(value)
	}
	return fallback
}

func intArg(args map[string]any, key string, fallback int) int {
	if value, ok := args[key]; ok {
		switch typed := value.(type) {
		case float64:
			return int(typed)
		case int:
			return typed
		case string:
			if parsed, err := strconv.Atoi(typed); err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func boolArg(args map[string]any, key string, fallback bool) bool {
	if value, ok := args[key].(bool); ok {
		return value
	}
	return fallback
}

func mapArg(args map[string]any, key string) map[string]any {
	if args == nil {
		return map[string]any{}
	}
	value, ok := args[key].(map[string]any)
	if ok {
		return value
	}
	raw, ok := args[key].(map[string]interface{})
	if !ok {
		return map[string]any{}
	}
	out := map[string]any{}
	for k, v := range raw {
		out[k] = v
	}
	return out
}

func stringMapArg(args map[string]any, key string) map[string]string {
	raw := mapArg(args, key)
	out := map[string]string{}
	for k, v := range raw {
		if v != nil {
			out[k] = fmt.Sprint(v)
		}
	}
	return out
}

func floatArg(args map[string]any, key string, fallback float64) float64 {
	if value, ok := args[key]; ok && value != nil {
		switch typed := value.(type) {
		case float64:
			return typed
		case int:
			return float64(typed)
		case json.Number:
			parsed, _ := typed.Float64()
			return parsed
		case string:
			parsed, err := strconv.ParseFloat(typed, 64)
			if err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func stringSliceArg(args map[string]any, key string) []string {
	items, _ := args[key].([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

func firstString(args map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringArg(args, key, ""); value != "" {
			return value
		}
	}
	return ""
}

func nullableNumber(value any) any {
	if value == nil {
		return nil
	}
	return floatArg(map[string]any{"v": value}, "v", 0)
}

func bytesToGB(value float64) float64 {
	return math.Round(value/1024/1024/1024*100) / 100
}

func weatherCodeText(code int) string {
	names := map[int]string{0: "晴", 1: "大致晴朗", 2: "局部多云", 3: "阴", 45: "雾", 48: "雾凇", 51: "小毛毛雨", 53: "中等毛毛雨", 55: "大毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 71: "小雪", 73: "中雪", 75: "大雪", 80: "小阵雨", 81: "中等阵雨", 82: "强阵雨", 95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴大冰雹"}
	if text, ok := names[code]; ok {
		return text
	}
	return "未知"
}

func stripHTML(value string) string {
	patterns := []string{`(?is)<head.*?</head>`, `(?is)<title.*?</title>`, `(?is)<script.*?</script>`, `(?is)<style.*?</style>`, `(?is)<[^>]+>`}
	out := value
	for _, pattern := range patterns {
		out = regexp.MustCompile(pattern).ReplaceAllString(out, " ")
	}
	return strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(out, " "))
}

func decodeHTML(value string) string {
	replacer := strings.NewReplacer("&amp;", "&", "&nbsp;", " ", "&ensp;", " ", "&emsp;", " ", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'")
	return html.UnescapeString(replacer.Replace(value))
}

func compactWhitespace(value string) string {
	return strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(value, " "))
}

func truncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func extractDate(value string) string {
	re := regexp.MustCompile(`(?i)^((?:\d+\s*(?:分钟|小时|天|周|个月|年)之前)|(?:\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago)|(?:\d{4}年\d{1,2}月\d{1,2}日)|(?:\d{1,2}月\d{1,2}日)|(?:\d{4}-\d{1,2}-\d{1,2}))`)
	if match := re.FindStringSubmatch(value); len(match) > 1 {
		return match[1]
	}
	return ""
}

func optionalMatch(match []string, index int) string {
	if len(match) > index {
		return match[index]
	}
	return ""
}
