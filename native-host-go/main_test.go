package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestExecutableNamesResolvesOfficeAliases(t *testing.T) {
	cases := map[string][]string{
		"word":  {"WINWORD.EXE"},
		"excel": {"EXCEL.EXE"},
		"ppt":   {"POWERPNT.EXE"},
		"wps":   {"wps.exe"},
	}

	for input, want := range cases {
		if got := executableNames(input); !reflect.DeepEqual(got, want) {
			t.Fatalf("executableNames(%q) = %#v, want %#v", input, got, want)
		}
	}
}

func TestExecutableNamesPrefersWindowsExecutableShims(t *testing.T) {
	got := executableNames("notepad")
	want := []string{"notepad.exe", "notepad.cmd", "notepad"}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("executableNames() = %#v, want %#v", got, want)
	}
}

func TestIsWindowsCommandShim(t *testing.T) {
	if !isWindowsCommandShim(`C:\Users\User\AppData\Roaming\npm\grok-search-rs.cmd`) {
		t.Fatal("expected .cmd npm shim to require the Windows command shell")
	}
	if isWindowsCommandShim(`C:\Tools\grok-search-rs.exe`) {
		t.Fatal("expected .exe to run directly")
	}
}

func TestDirectoryInfoReturnsAggregateOnlyOutput(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "nested"), 0755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("abc"), 0644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "b.txt"), []byte("12345"), 0644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	result, err := directoryInfo(map[string]any{"path": root})
	if err != nil {
		t.Fatalf("directoryInfo() error = %v", err)
	}
	payload := result.(map[string]any)
	if payload["path"] != root {
		t.Fatalf("path = %q, want %q", payload["path"], root)
	}
	if payload["totalBytes"] != int64(8) {
		t.Fatalf("totalBytes = %#v, want 8", payload["totalBytes"])
	}
	if payload["fileCount"] != int64(2) {
		t.Fatalf("fileCount = %#v, want 2", payload["fileCount"])
	}
	if payload["directoryCount"] != int64(1) {
		t.Fatalf("directoryCount = %#v, want 1", payload["directoryCount"])
	}
	if _, ok := payload["entries"]; ok {
		t.Fatal("directoryInfo() must not return entries")
	}
	if _, ok := payload["files"]; ok {
		t.Fatal("directoryInfo() must not return files")
	}
}

func TestStopMCPProcessAcceptsNil(t *testing.T) {
	stopMCPProcess(nil)
}

func TestReadMCPJSONLineAllowsLargeBoundedResponses(t *testing.T) {
	payload := strings.Repeat("x", 21*1024*1024)
	line, err := readMCPJSONLine(bufio.NewReader(strings.NewReader(payload+"\n")), maxMCPResponseBytes)
	if err != nil {
		t.Fatalf("readMCPJSONLine() error = %v", err)
	}
	if len(line) != len(payload) {
		t.Fatalf("readMCPJSONLine() length = %d, want %d", len(line), len(payload))
	}
}

func TestReadMCPJSONLineRejectsOversizedResponses(t *testing.T) {
	_, err := readMCPJSONLine(bufio.NewReader(bytes.NewReader(bytes.Repeat([]byte("x"), 16))), 15)
	if err == nil || !strings.Contains(err.Error(), "MCP response line exceeds") {
		t.Fatalf("readMCPJSONLine() error = %v, want size limit error", err)
	}
}

func TestWebSearchDefaultsToDuckDuckGo(t *testing.T) {
	if defaultSearchProvider != "duckduckgo" {
		t.Fatalf("defaultSearchProvider = %q, want duckduckgo", defaultSearchProvider)
	}
	if got := defaultSearchURL(defaultSearchProvider); !strings.Contains(got, "duckduckgo.com/html/") {
		t.Fatalf("defaultSearchURL() = %q, want DuckDuckGo HTML search", got)
	}
}

func TestReplaceQueryPlaceholdersUsesPercentEncodedSpaces(t *testing.T) {
	got := replaceQueryPlaceholders("https://html.duckduckgo.com/html/?q={query}", "OpenAI Codex CLI")
	want := "https://html.duckduckgo.com/html/?q=OpenAI%20Codex%20CLI"
	if got != want {
		t.Fatalf("replaceQueryPlaceholders() = %q, want %q", got, want)
	}
}

func TestNewTextRequestUsesBrowserHeaders(t *testing.T) {
	req, err := newTextRequest("https://duckduckgo.com/html/?q=test")
	if err != nil {
		t.Fatalf("newTextRequest() error = %v", err)
	}
	if got := req.Header.Get("User-Agent"); !strings.Contains(got, "Mozilla/5.0") {
		t.Fatalf("User-Agent = %q, want browser-like header", got)
	}
	if got := req.Header.Get("Accept-Language"); !strings.Contains(got, "zh-CN") {
		t.Fatalf("Accept-Language = %q, want zh-CN preference", got)
	}
}

func TestNewFetchRequestUsesDuckDuckGoHeadersOnly(t *testing.T) {
	duckReq, err := newFetchRequest("https://html.duckduckgo.com/html/?q=test", "")
	if err != nil {
		t.Fatalf("newFetchRequest() DuckDuckGo error = %v", err)
	}
	if got := duckReq.Header.Get("User-Agent"); !strings.Contains(got, "Mozilla/5.0") {
		t.Fatalf("DuckDuckGo User-Agent = %q, want browser-like header", got)
	}

	bingReq, err := newFetchRequest("https://www.bing.com/search?q=test", "bing")
	if err != nil {
		t.Fatalf("newFetchRequest() Bing error = %v", err)
	}
	if got := bingReq.Header.Get("User-Agent"); got != "" {
		t.Fatalf("Bing User-Agent = %q, want empty header to avoid challenge page", got)
	}
}

type stubHTTPDoer func(*http.Request) (*http.Response, error)

func (fn stubHTTPDoer) Do(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestFetchTextWithFallbackTriesNextClientAfterEOF(t *testing.T) {
	attempts := 0
	req, err := newTextRequest("https://www.bing.com/search?q=test")
	if err != nil {
		t.Fatalf("newTextRequest() error = %v", err)
	}

	resp, text, err := fetchTextWithFallback(req, []httpDoer{
		stubHTTPDoer(func(req *http.Request) (*http.Response, error) {
			attempts++
			return nil, io.ErrUnexpectedEOF
		}),
		stubHTTPDoer(func(req *http.Request) (*http.Response, error) {
			attempts++
			if got := req.Header.Get("User-Agent"); !strings.Contains(got, "Mozilla/5.0") {
				t.Fatalf("fallback request User-Agent = %q, want browser-like header", got)
			}
			return &http.Response{
				StatusCode: 200,
				Request:    req,
				Body:       io.NopCloser(strings.NewReader("ok")),
			}, nil
		}),
	})

	if err != nil {
		t.Fatalf("fetchTextWithFallback() error = %v", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	if resp.StatusCode != 200 || text != "ok" {
		t.Fatalf("response = (%d, %q), want (200, ok)", resp.StatusCode, text)
	}
}

func TestFetchTextWithFallbackReturnsLastError(t *testing.T) {
	firstErr := io.ErrUnexpectedEOF
	lastErr := errors.New("direct fallback failed")
	req, err := newTextRequest("https://www.bing.com/search?q=test")
	if err != nil {
		t.Fatalf("newTextRequest() error = %v", err)
	}

	_, _, err = fetchTextWithFallback(req, []httpDoer{
		stubHTTPDoer(func(req *http.Request) (*http.Response, error) {
			return nil, firstErr
		}),
		stubHTTPDoer(func(req *http.Request) (*http.Response, error) {
			return nil, lastErr
		}),
	})

	if !errors.Is(err, lastErr) {
		t.Fatalf("fetchTextWithFallback() error = %v, want last error %v", err, lastErr)
	}
}

func TestWebSearchMCPFallsBackToBingOnError(t *testing.T) {
	originalFetch := fetchSearchTextFunc
	originalMCP := callMCPToolFunc
	defer func() {
		fetchSearchTextFunc = originalFetch
		callMCPToolFunc = originalMCP
	}()
	callMCPToolFunc = func(mcp map[string]any, tool string, toolArgs map[string]any) (any, error) {
		return nil, errors.New("mcp missing")
	}
	fetchSearchTextFunc = func(target string, provider string) (*http.Response, string, error) {
		if provider != "bing" {
			t.Fatalf("fallback provider = %q, want bing", provider)
		}
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("NewRequest() error = %v", err)
		}
		return &http.Response{StatusCode: 200, Request: req}, `
			<li class="b_algo">
				<h2><a href="https://example.com/bing-fallback">Bing Fallback Result</a></h2>
			</li>
		`, nil
	}

	result, err := webSearch(map[string]any{
		"query":          "missing mcp",
		"provider":       "mcp",
		"includeContent": false,
		"mcp": map[string]any{
			"command": "missing-grok-search-rs",
		},
	})
	if err != nil {
		t.Fatalf("webSearch() error = %v", err)
	}
	payload := result.(map[string]any)
	if payload["provider"] != "bing" {
		t.Fatalf("provider = %q, want bing", payload["provider"])
	}
	if payload["fallbackFrom"] != "mcp" {
		t.Fatalf("fallbackFrom = %q, want mcp", payload["fallbackFrom"])
	}
	fallbackError, _ := payload["fallbackError"].(string)
	if !strings.Contains(fallbackError, "mcp missing") {
		t.Fatalf("fallbackError = %q, want MCP error", payload["fallbackError"])
	}
	providers := payload["fallbackProviders"].([]string)
	if len(providers) != 2 || providers[0] != "bing" || providers[1] != "duckduckgo" {
		t.Fatalf("fallbackProviders = %#v, want bing then duckduckgo", providers)
	}
	results := payload["results"].([]map[string]any)
	if len(results) != 1 || results[0]["title"] != "Bing Fallback Result" {
		t.Fatalf("results = %#v, want Bing fallback result", results)
	}
}

func TestWebSearchMCPFallsBackThroughBingToDuckDuckGoOnProviderError(t *testing.T) {
	originalFetch := fetchSearchTextFunc
	originalMCP := callMCPToolFunc
	defer func() {
		fetchSearchTextFunc = originalFetch
		callMCPToolFunc = originalMCP
	}()
	callMCPToolFunc = func(mcp map[string]any, tool string, toolArgs map[string]any) (any, error) {
		return map[string]any{
			"ok":      false,
			"error":   "grok_provider_error",
			"message": "Grok provider failed",
			"results": []map[string]any{},
		}, nil
	}
	providers := []string{}
	fetchSearchTextFunc = func(target string, provider string) (*http.Response, string, error) {
		providers = append(providers, provider)
		if provider == "bing" {
			return nil, "", errors.New("Bing network error")
		}
		if provider != "duckduckgo" {
			t.Fatalf("provider = %q, want duckduckgo after Bing fails", provider)
		}
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("NewRequest() error = %v", err)
		}
		return &http.Response{StatusCode: 200, Request: req}, `<a class="result__a" href="https://example.com/duck-fallback">DuckDuckGo Fallback Result</a>`, nil
	}

	result, err := webSearch(map[string]any{
		"query":          "latest news",
		"provider":       "mcp",
		"includeContent": false,
		"mcp": map[string]any{
			"command": "grok-search-rs",
		},
	})
	if err != nil {
		t.Fatalf("webSearch() error = %v", err)
	}
	payload := result.(map[string]any)
	if payload["provider"] != "duckduckgo" {
		t.Fatalf("provider = %q, want duckduckgo", payload["provider"])
	}
	if payload["fallbackFrom"] != "mcp" {
		t.Fatalf("fallbackFrom = %q, want mcp", payload["fallbackFrom"])
	}
	fallbackError, _ := payload["fallbackError"].(string)
	if !strings.Contains(fallbackError, "grok_provider_error") {
		t.Fatalf("fallbackError = %q, want grok_provider_error", payload["fallbackError"])
	}
	if len(providers) < 2 || providers[0] != "bing" || providers[len(providers)-1] != "duckduckgo" {
		t.Fatalf("providers = %#v, want bing attempts then duckduckgo", providers)
	}
	results := payload["results"].([]map[string]any)
	if len(results) != 1 || results[0]["title"] != "DuckDuckGo Fallback Result" {
		t.Fatalf("results = %#v, want DuckDuckGo fallback result", results)
	}
}

func TestWebSearchMCPFallsBackWhenContentTextContainsProviderErrorJSON(t *testing.T) {
	originalFetch := fetchSearchTextFunc
	originalMCP := callMCPToolFunc
	defer func() {
		fetchSearchTextFunc = originalFetch
		callMCPToolFunc = originalMCP
	}()
	callMCPToolFunc = func(mcp map[string]any, tool string, toolArgs map[string]any) (any, error) {
		return map[string]any{
			"content": []any{
				map[string]any{
					"type": "text",
					"text": `{"ok":false,"error":"grok_provider_error","message":"Grok provider failed","sources_count":0,"results":[]}`,
				},
			},
		}, nil
	}
	fetchSearchTextFunc = func(target string, provider string) (*http.Response, string, error) {
		if provider != "bing" {
			t.Fatalf("provider = %q, want bing", provider)
		}
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("NewRequest() error = %v", err)
		}
		return &http.Response{StatusCode: 200, Request: req}, `
			<li class="b_algo">
				<h2><a href="https://example.com/bing-content-error-fallback">Bing Content Error Fallback</a></h2>
			</li>
		`, nil
	}

	result, err := webSearch(map[string]any{
		"query":          "latest news",
		"provider":       "mcp",
		"includeContent": false,
		"mcp": map[string]any{
			"command": "grok-search-rs",
		},
	})
	if err != nil {
		t.Fatalf("webSearch() error = %v", err)
	}
	payload := result.(map[string]any)
	if payload["provider"] != "bing" {
		t.Fatalf("provider = %q, want bing", payload["provider"])
	}
	fallbackError, _ := payload["fallbackError"].(string)
	if !strings.Contains(fallbackError, "grok_provider_error") {
		t.Fatalf("fallbackError = %q, want grok_provider_error", payload["fallbackError"])
	}
	results := payload["results"].([]map[string]any)
	if len(results) != 1 || results[0]["title"] != "Bing Content Error Fallback" {
		t.Fatalf("results = %#v, want Bing fallback result", results)
	}
}

func TestWebSearchMCPFallsBackWhenMCPReturnsEmptySourcesWithoutErrorField(t *testing.T) {
	originalFetch := fetchSearchTextFunc
	originalMCP := callMCPToolFunc
	defer func() {
		fetchSearchTextFunc = originalFetch
		callMCPToolFunc = originalMCP
	}()
	callMCPToolFunc = func(mcp map[string]any, tool string, toolArgs map[string]any) (any, error) {
		return map[string]any{
			"content": []any{
				map[string]any{
					"type": "text",
					"text": "Grok Responses search did not return a verifiable answer. Source fallback returned 0 source(s).",
				},
			},
			"sources": []any{},
		}, nil
	}
	fetchSearchTextFunc = func(target string, provider string) (*http.Response, string, error) {
		if provider != "bing" {
			t.Fatalf("provider = %q, want bing", provider)
		}
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("NewRequest() error = %v", err)
		}
		return &http.Response{StatusCode: 200, Request: req}, `
			<li class="b_algo">
				<h2><a href="https://example.com/bing-empty-mcp-fallback">Bing Empty MCP Fallback</a></h2>
			</li>
		`, nil
	}

	result, err := webSearch(map[string]any{
		"query":          "latest news",
		"provider":       "mcp",
		"includeContent": false,
		"mcp": map[string]any{
			"command": "grok-search-rs",
		},
	})
	if err != nil {
		t.Fatalf("webSearch() error = %v", err)
	}
	payload := result.(map[string]any)
	if payload["provider"] != "bing" {
		t.Fatalf("provider = %q, want bing", payload["provider"])
	}
	fallbackError, _ := payload["fallbackError"].(string)
	if !strings.Contains(fallbackError, "empty results") && !strings.Contains(fallbackError, "0 source") {
		t.Fatalf("fallbackError = %q, want empty results or 0 source", payload["fallbackError"])
	}
	results := payload["results"].([]map[string]any)
	if len(results) != 1 || results[0]["title"] != "Bing Empty MCP Fallback" {
		t.Fatalf("results = %#v, want Bing fallback result", results)
	}
}

func TestWebSearchMCPSkipsEmptyBingFallbackResults(t *testing.T) {
	originalFetch := fetchSearchTextFunc
	originalMCP := callMCPToolFunc
	defer func() {
		fetchSearchTextFunc = originalFetch
		callMCPToolFunc = originalMCP
	}()
	callMCPToolFunc = func(mcp map[string]any, tool string, toolArgs map[string]any) (any, error) {
		return map[string]any{
			"ok":      false,
			"error":   "grok_provider_error",
			"results": []map[string]any{},
		}, nil
	}
	providers := []string{}
	fetchSearchTextFunc = func(target string, provider string) (*http.Response, string, error) {
		providers = append(providers, provider)
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("NewRequest() error = %v", err)
		}
		if provider == "bing" {
			return &http.Response{StatusCode: 200, Request: req}, `<html><body>No results</body></html>`, nil
		}
		if provider != "duckduckgo" {
			t.Fatalf("provider = %q, want duckduckgo after empty Bing", provider)
		}
		return &http.Response{StatusCode: 200, Request: req}, `<a class="result__a" href="https://example.com/duck-after-empty">DuckDuckGo After Empty</a>`, nil
	}

	result, err := webSearch(map[string]any{
		"query":          "latest news",
		"provider":       "mcp",
		"includeContent": false,
		"mcp": map[string]any{
			"command": "grok-search-rs",
		},
	})
	if err != nil {
		t.Fatalf("webSearch() error = %v", err)
	}
	payload := result.(map[string]any)
	if payload["provider"] != "duckduckgo" {
		t.Fatalf("provider = %q, want duckduckgo", payload["provider"])
	}
	if payload["fallbackFrom"] != "mcp" {
		t.Fatalf("fallbackFrom = %q, want mcp", payload["fallbackFrom"])
	}
	if len(providers) < 2 || providers[0] != "bing" || providers[len(providers)-1] != "duckduckgo" {
		t.Fatalf("providers = %#v, want bing then duckduckgo", providers)
	}
	results := payload["results"].([]map[string]any)
	if len(results) != 1 || results[0]["title"] != "DuckDuckGo After Empty" {
		t.Fatalf("results = %#v, want DuckDuckGo fallback result", results)
	}
}

func TestWebSearchRetriesTransientBingRequestErrors(t *testing.T) {
	originalFetch := fetchSearchTextFunc
	defer func() { fetchSearchTextFunc = originalFetch }()
	calls := []string{}
	fetchSearchTextFunc = func(target string, provider string) (*http.Response, string, error) {
		calls = append(calls, provider+":"+target)
		if len(calls) == 1 {
			return nil, "", io.ErrUnexpectedEOF
		}
		if provider != "bing" {
			t.Fatalf("provider = %q, want bing", provider)
		}
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("NewRequest() error = %v", err)
		}
		return &http.Response{StatusCode: 200, Request: req}, `
			<li class="b_algo">
				<h2><a href="https://example.com/news">Latest News</a></h2>
			</li>
		`, nil
	}

	result, err := webSearch(map[string]any{
		"query":          "latest news",
		"provider":       "bing",
		"includeContent": false,
	})
	if err != nil {
		t.Fatalf("webSearch() error = %v", err)
	}
	payload := result.(map[string]any)
	if payload["provider"] != "bing" {
		t.Fatalf("provider = %q, want bing", payload["provider"])
	}
	if _, ok := payload["fallbackFrom"]; ok {
		t.Fatalf("fallbackFrom = %q, want no fallback for Bing", payload["fallbackFrom"])
	}
	results := payload["results"].([]map[string]any)
	if len(results) != 1 || results[0]["title"] != "Latest News" {
		t.Fatalf("results = %#v, want Bing retry result", results)
	}
	if len(calls) != 2 || !strings.HasPrefix(calls[0], "bing:") || !strings.HasPrefix(calls[1], "bing:") {
		t.Fatalf("fetch calls = %#v, want two Bing attempts", calls)
	}
}

func TestExtractSearchResultsNormalizesRedirectURLs(t *testing.T) {
	bingTarget := "https://example.com/bing-source"
	bingEncodedTarget := base64.RawURLEncoding.EncodeToString([]byte(bingTarget))
	html := `
		<li class="b_algo">
			<h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1` + bingEncodedTarget + `&ntb=1">Bing Source</a></h2>
			<div class="b_caption"><p>Useful source snippet.</p></div>
		</li>
		<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fduck-source&rut=abc">Duck Source</a>
	`
	results := extractSearchResults(html)
	if len(results) != 2 {
		t.Fatalf("extractSearchResults() returned %d results, want 2", len(results))
	}
	if results[0]["url"] != bingTarget {
		t.Fatalf("Bing URL = %q, want %q", results[0]["url"], bingTarget)
	}
	if results[1]["url"] != "https://example.com/duck-source" {
		t.Fatalf("DuckDuckGo URL = %q, want final source URL", results[1]["url"])
	}
}

func TestExtractSearchResultsParsesBingCaptionSnippet(t *testing.T) {
	html := `
		<li class="b_algo">
			<h2><a href="https://example.com/news">2026&#24180;6月新闻</a></h2>
			<div class="b_caption"><p>1 day ago &ensp;&#0183;&ensp; 国内和国际新闻摘要。</p></div>
		</li>
	`
	results := extractSearchResults(html)
	if len(results) != 1 {
		t.Fatalf("extractSearchResults() returned %d results, want 1", len(results))
	}
	if results[0]["title"] != "2026年6月新闻" {
		t.Fatalf("title = %q, want decoded title", results[0]["title"])
	}
	if results[0]["snippet"] != "1 day ago · 国内和国际新闻摘要。" {
		t.Fatalf("snippet = %q, want decoded Bing caption", results[0]["snippet"])
	}
	if results[0]["date"] != "1 day ago" {
		t.Fatalf("date = %q, want 1 day ago", results[0]["date"])
	}
}

func TestCollectProcessTreePIDsIncludesDescendants(t *testing.T) {
	parentByPID := map[int]int{
		10: 0,
		11: 10,
		12: 11,
		13: 10,
		14: 99,
	}
	got := collectProcessTreePIDs(10, parentByPID)
	want := []int{10, 11, 12, 13}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("collectProcessTreePIDs() = %#v, want %#v", got, want)
	}
}
