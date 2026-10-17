package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
	"github.com/linguo2625469/workbuddy2api-panel/internal/upstream"
)

// capturedUpstream 记录上游真正收到的 chat 请求（与 responses_test 共用类型）。
type capturedMessagesUpstream struct {
	path string
	body map[string]any
}

func newCapturingMessagesUpstream(t *testing.T, sse string, cap *capturedMessagesUpstream) *upstream.Client {
	t.Helper()
	return &upstream.Client{
		HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			cap.path = r.URL.Path
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &cap.body)
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
				Body:       io.NopCloser(strings.NewReader(sse)),
			}, nil
		})},
		ChatBaseCN:    "https://fake.example",
		BillingBaseCN: "https://fake.example",
	}
}

// parseMessagesSSE 把 /v1/messages 的输出拆成 (event, payload) 列表。
func parseMessagesSSE(t *testing.T, raw string) []struct {
	Type string
	Obj  map[string]any
} {
	t.Helper()
	type ev = struct {
		Type string
		Obj  map[string]any
	}
	out := []ev{}
	for _, block := range strings.Split(raw, "\n\n") {
		typ, data := "", ""
		for _, line := range strings.Split(strings.TrimSpace(block), "\n") {
			switch {
			case strings.HasPrefix(line, "event:"):
				typ = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			case strings.HasPrefix(line, "data:"):
				data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			}
		}
		if data == "" || data == "[DONE]" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(data), &obj); err != nil {
			t.Fatalf("bad SSE payload %q: %v", data, err)
		}
		if typ == "" {
			typ, _ = obj["type"].(string)
		}
		out = append(out, ev{Type: typ, Obj: obj})
	}
	return out
}

func messagesHandler(t *testing.T, up *upstream.Client) *Handler {
	t.Helper()
	p := testPoolWith(&auth.Auth{UID: "u1", AccessToken: "at1", ExpiresAt: 9999999999})
	return NewHandler(Config{Pool: p, Upstream: up})
}

func postMessages(t *testing.T, h *Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)))
	return rec
}

/* ------------------------------ 模型名映射 ------------------------------ */

func TestMessagesModel(t *testing.T) {
	cases := []struct{ in, want string }{
		{"claude-opus-4-6", "cn:space-bunny"},
		{"claude-opus-4-5", "cn:deepseek-v4-pro"},
		{"claude-opus-4-1", "cn:kimi-k3-1"},
		{"claude-opus-3-5", "cn:glm-5.3"},
		{"claude-sonnet-4-0", "cn:glm-5.1"},
		{"claude-sonnet-5-5", "cn:minimax-m3"},
		{"claude-3-5-haiku", "cn:glm-5.3-flash"},
		{"claude-haiku-4-5", "cn:deepseek-v4.1-flash"},
		{"claude-fable-5", "cn:auto"},
		{"claude-fable-4-5", "cn:hy4-preview-f"},
		{"claude-fable-4-0", "cn:hy3"},
		// Claude Code 默认 sonnet 别名：不在 /model 列表里，保留原生映射。
		{"claude-sonnet-4-5", "cn:glm-5.3"},
		// 用户直接选了网关模型（靠 discovery 从 /v1/models 发现）：原样透传。
		{"cn:space-bunny", "cn:space-bunny"},
		{"cn:glm-5.3", "cn:glm-5.3"},
		{"global:some-model", "global:some-model"},
		// 未收录的 claude-*：回落到默认，不报错。
		{"claude-mystery-9", "cn:space-bunny"},
		// 非 Anthropic 风格的裸名：也回落默认（客户端原样发，上游不认裸名）。
		{"gpt-4o", "cn:space-bunny"},
		// 空：给默认，不返回空串。
		{"", "cn:space-bunny"},
	}
	for _, c := range cases {
		if got := messagesModel(c.in); got != c.want {
			t.Errorf("messagesModel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMessagesIsAnthropicStyle(t *testing.T) {
	if messagesIsAnthropicStyle("cn:space-bunny") {
		t.Error("cn: 前缀不该被判为 Anthropic 风格")
	}
	if !messagesIsAnthropicStyle("claude-sonnet-4-5") {
		t.Error("claude-* 应判为 Anthropic 风格")
	}
}

/* ------------------------------ 请求翻译 ------------------------------ */

func TestMessagesRequestToChatBasics(t *testing.T) {
	body := map[string]any{
		"model":      "claude-sonnet-4-5",
		"max_tokens": 1024,
		"system":     "你是助手",
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": "你好"},
				},
			},
		},
	}
	chat, model := messagesRequestToChat(body)
	if model != "cn:glm-5.3" {
		t.Errorf("model = %q", model)
	}
	if got := chat["max_tokens"]; got != 1024 {
		t.Errorf("max_tokens = %v (%T), want 1024", got, got)
	}
	if v, _ := chat["stream"].(bool); !v {
		t.Error("缺省应为流式")
	}
	msgs, _ := chat["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages = %d, want 2 (system + user)", len(msgs))
	}
	first := messagesMap(msgs[0])
	if messagesStr(first["role"]) != "system" || first["content"] != "你是助手" {
		t.Errorf("system 消息不对: %#v", first)
	}
	second := messagesMap(msgs[1])
	if messagesStr(second["role"]) != "user" || second["content"] != "你好" {
		t.Errorf("user 消息不对: %#v", second)
	}
}

// max_tokens 缺省时不能给 0（上游会拒），也不能给 nil。
func TestMessagesMaxTokensDefaulted(t *testing.T) {
	chat, _ := messagesRequestToChat(map[string]any{
		"model":    "claude-sonnet-4-5",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})
	if got, _ := chat["max_tokens"].(int); got <= 0 {
		t.Errorf("max_tokens 应为正数兜底值, got %v", chat["max_tokens"])
	}
}

func TestMessagesToolUseBecomesToolCalls(t *testing.T) {
	body := map[string]any{
		"model":      "claude-sonnet-4-5",
		"max_tokens": 512,
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": "查天气"},
				},
			},
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{
						"type":  "tool_use",
						"id":    "toolu_abc",
						"name":  "get_weather",
						"input": map[string]any{"city": "北京"},
					},
				},
			},
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{
						"type":        "tool_result",
						"tool_use_id": "toolu_abc",
						"content":     "晴 25C",
					},
				},
			},
		},
	}
	chat, _ := messagesRequestToChat(body)
	msgs, _ := chat["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("messages = %d, want 3 (user / assistant+tool_calls / tool)", len(msgs))
	}
	asst := messagesMap(msgs[1])
	if messagesStr(asst["role"]) != "assistant" {
		t.Fatalf("第 2 条应为 assistant, got %v", messagesStr(asst["role"]))
	}
	calls, ok := asst["tool_calls"].([]any)
	if !ok || len(calls) != 1 {
		t.Fatalf("tool_calls 不对: %#v", asst["tool_calls"])
	}
	fn := messagesMap(messagesMap(calls[0])["function"])
	if messagesStr(fn["name"]) != "get_weather" {
		t.Errorf("tool name = %v", messagesStr(fn["name"]))
	}
	if !strings.Contains(messagesStr(fn["arguments"]), "北京") {
		t.Errorf("tool arguments 应含 input: %v", messagesStr(fn["arguments"]))
	}
	tool := messagesMap(msgs[2])
	if messagesStr(tool["role"]) != "tool" || messagesStr(tool["tool_call_id"]) != "toolu_abc" {
		t.Errorf("tool_result 映射不对: %#v", tool)
	}
	if tool["content"] != "晴 25C" {
		t.Errorf("tool content = %v", tool["content"])
	}
}

// 并行工具调用必须落在同一条 assistant 消息里（上游按消息聚合）。
func TestMessagesParallelToolUseMerged(t *testing.T) {
	body := map[string]any{
		"model": "claude-sonnet-4-5",
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "tool_use", "id": "t1", "name": "a", "input": map[string]any{}},
					map[string]any{"type": "tool_use", "id": "t2", "name": "b", "input": map[string]any{}},
				},
			},
		},
	}
	chat, _ := messagesRequestToChat(body)
	msgs, _ := chat["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("并行 tool_use 应并成 1 条 assistant，实际 %d 条", len(msgs))
	}
	calls, _ := messagesMap(msgs[0])["tool_calls"].([]any)
	if len(calls) != 2 {
		t.Errorf("tool_calls = %d, want 2", len(calls))
	}
}

// thinking 块应被丢弃（上游非 Claude 模型无 thinking 语义），且不产生空消息。
func TestMessagesThinkingDropped(t *testing.T) {
	body := map[string]any{
		"model": "claude-sonnet-4-5",
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "thinking", "thinking": "让我想想", "signature": "sig"},
					map[string]any{"type": "text", "text": "答案"},
				},
			},
		},
	}
	chat, _ := messagesRequestToChat(body)
	msgs, _ := chat["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("thinking 应被丢弃，只剩 1 条文本消息，实际 %d", len(msgs))
	}
	if messagesMap(msgs[0])["content"] != "答案" {
		t.Errorf("content = %v", messagesMap(msgs[0])["content"])
	}
}

func TestMessagesToolsToChat(t *testing.T) {
	chat, _ := messagesRequestToChat(map[string]any{
		"model": "claude-sonnet-4-5",
		"messages": []any{map[string]any{
			"role": "user", "content": "hi",
		}},
		"tools": []any{
			map[string]any{
				"name":         "get_weather",
				"description":  "查天气",
				"input_schema": map[string]any{"type": "object", "properties": map[string]any{"city": map[string]any{"type": "string"}}},
			},
		},
		"tool_choice": map[string]any{"type": "any"},
	})
	tools, _ := chat["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %d, want 1", len(tools))
	}
	fn := messagesMap(messagesMap(tools[0])["function"])
	if messagesStr(fn["name"]) != "get_weather" {
		t.Errorf("name = %v", messagesStr(fn["name"]))
	}
	params := messagesMap(fn["parameters"])
	if messagesStr(params["type"]) != "object" {
		t.Errorf("input_schema 应映射到 parameters: %#v", fn["parameters"])
	}
	if chat["tool_choice"] != "required" {
		t.Errorf("tool_choice any -> required, got %v", chat["tool_choice"])
	}
}

func TestMessagesImageBase64(t *testing.T) {
	chat, _ := messagesRequestToChat(map[string]any{
		"model": "claude-sonnet-4-5",
		"messages": []any{map[string]any{
			"role": "user",
			"content": []any{
				map[string]any{"type": "image", "source": map[string]any{
					"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo=",
				}},
			},
		}},
	})
	msgs, _ := chat["messages"].([]any)
	parts, ok := messagesMap(msgs[0])["content"].([]any)
	if !ok || len(parts) != 1 {
		t.Fatalf("content 应为 part 数组: %#v", messagesMap(msgs[0])["content"])
	}
	img := messagesMap(parts[0])
	if messagesStr(img["type"]) != "image_url" {
		t.Fatalf("type = %v", messagesStr(img["type"]))
	}
	url := messagesStr(messagesMap(img["image_url"])["url"])
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Errorf("base64 应转成 data URL, got %q", url)
	}
}

/* ------------------------------ 端到端：流式 ------------------------------ */

func TestMessagesStreamingText(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"你"}}]}`,
		`data: {"choices":[{"delta":{"content":"好"}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`,
		`data: [DONE]`,
	}, "\n\n")
	cap := &capturedMessagesUpstream{}
	h := messagesHandler(t, newCapturingMessagesUpstream(t, sse, cap))
	rec := postMessages(t, h, `{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"stream":true}`)

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Errorf("Content-Type = %q", ct)
	}
	if !strings.HasSuffix(cap.path, "/chat/completions") {
		t.Errorf("上游路径 = %q（应复用 chat 链路）", cap.path)
	}

	events := parseMessagesSSE(t, rec.Body.String())
	types := make([]string, 0, len(events))
	for _, e := range events {
		types = append(types, e.Type)
	}
	want := []string{
		"message_start",
		"content_block_start", "content_block_delta", "content_block_delta",
		"content_block_stop", "message_delta", "message_stop",
	}
	if len(types) != len(want) {
		t.Fatalf("事件序 = %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("事件序 = %v, want %v", types, want)
		}
	}

	// 文本内容拼接正确
	var text strings.Builder
	for _, e := range events {
		if e.Type == "content_block_delta" {
			if d := messagesMap(e.Obj["delta"]); messagesStr(d["type"]) == "text_delta" {
				text.WriteString(messagesStr(d["text"]))
			}
		}
	}
	if text.String() != "你好" {
		t.Errorf("文本 = %q, want 你好", text.String())
	}

	// message_delta 带上正确的 stop_reason 与 usage
	last := events[len(events)-2].Obj
	if d := messagesMap(last["delta"]); messagesStr(d["stop_reason"]) != "end_turn" {
		t.Errorf("stop_reason = %v", messagesStr(d["stop_reason"]))
	}
	u := messagesMap(last["usage"])
	if v, _ := u["input_tokens"].(float64); v != 10 {
		t.Errorf("input_tokens = %v, want 10", u["input_tokens"])
	}
	if v, _ := u["output_tokens"].(float64); v != 2 {
		t.Errorf("output_tokens = %v, want 2", u["output_tokens"])
	}

	// message_start 的 model 应回显客户端发来的 Anthropic 风格名
	start := messagesMap(events[0].Obj["message"])
	if messagesStr(start["model"]) != "claude-sonnet-4-5" {
		t.Errorf("message_start.model = %q, want claude-sonnet-4-5（回显客户端原名）", messagesStr(start["model"]))
	}
	if messagesStr(start["id"]) == "" {
		t.Error("message_start 缺 id")
	}
}

func TestMessagesStreamingToolUse(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"北京\"}"}}]}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
	}, "\n\n")
	cap := &capturedMessagesUpstream{}
	h := messagesHandler(t, newCapturingMessagesUpstream(t, sse, cap))
	rec := postMessages(t, h, `{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"stream":true}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	events := parseMessagesSSE(t, rec.Body.String())

	var partial strings.Builder
	sawToolStart := false
	stopReason := ""
	for _, e := range events {
		switch e.Type {
		case "content_block_start":
			if messagesStr(messagesMap(e.Obj["content_block"])["type"]) == "tool_use" {
				sawToolStart = true
			}
		case "content_block_delta":
			if d := messagesMap(e.Obj["delta"]); messagesStr(d["type"]) == "input_json_delta" {
				partial.WriteString(messagesStr(d["partial_json"]))
			}
		case "message_delta":
			stopReason = messagesStr(messagesMap(e.Obj["delta"])["stop_reason"])
		}
	}
	if !sawToolStart {
		t.Error("缺 content_block_start(tool_use)")
	}
	if got := partial.String(); got != `{"city":"北京"}` {
		t.Errorf("参数分片拼接 = %q", got)
	}
	if stopReason != "tool_use" {
		t.Errorf("stop_reason = %q, want tool_use", stopReason)
	}
}

// 上游一个数据帧都不给时，也必须补齐 message_start/message_stop，
// 否则客户端挂在「流没结束」上。
func TestMessagesStreamingEmptyUpstreamStillCloses(t *testing.T) {
	cap := &capturedMessagesUpstream{}
	h := messagesHandler(t, newCapturingMessagesUpstream(t, "data: [DONE]\n\n", cap))
	rec := postMessages(t, h, `{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"stream":true}`)
	events := parseMessagesSSE(t, rec.Body.String())
	if len(events) < 2 {
		t.Fatalf("事件数 = %d, want >=2", len(events))
	}
	if events[0].Type != "message_start" {
		t.Errorf("首事件 = %q, want message_start", events[0].Type)
	}
	if events[len(events)-1].Type != "message_stop" {
		t.Errorf("末事件 = %q, want message_stop", events[len(events)-1].Type)
	}
}


/* ------------------------------ 端到端：非流式 ------------------------------ */

// 非流式客户端：网关内部走 upstream.Aggregate 聚合上游 SSE，所以 fake 上游
// 仍要返回 SSE 帧，聚合后 chatCompletions 才写出 application/json。
func TestMessagesNonStreaming(t *testing.T) {
	sse := "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"PONG\"}}]}\n\n" +
		"data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]," +
		"\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n" +
		"data: [DONE]\n\n"
	up := newFakeUpstream(t, func(string) (int, string, bool) { return 200, sse, true })
	h := messagesHandler(t, up)
	rec := postMessages(t, h, `{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"stream":false}`)

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, rec.Body.String())
	}
	if messagesStr(got["type"]) != "message" {
		t.Errorf("type = %v, want message", got["type"])
	}
	if messagesStr(got["role"]) != "assistant" {
		t.Errorf("role = %v", got["role"])
	}
	// 回显客户端发来的 Anthropic 风格名，而非网关名。
	if messagesStr(got["model"]) != "claude-sonnet-4-5" {
		t.Errorf("model = %v（应回显 Anthropic 风格名）", got["model"])
	}
	if messagesStr(got["stop_reason"]) != "end_turn" {
		t.Errorf("stop_reason = %v", got["stop_reason"])
	}
	blocks, _ := got["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("content blocks = %d, want 1", len(blocks))
	}
	if messagesStr(messagesMap(blocks[0])["text"]) != "PONG" {
		t.Errorf("text = %v", messagesMap(blocks[0])["text"])
	}
	u := messagesMap(got["usage"])
	if v, _ := u["input_tokens"].(float64); v != 7 {
		t.Errorf("input_tokens = %v, want 7", u["input_tokens"])
	}
	if v, _ := u["output_tokens"].(float64); v != 3 {
		t.Errorf("output_tokens = %v, want 3", u["output_tokens"])
	}
}

// 非流式响应里的 tool_calls 要还原成 Anthropic 的 tool_use block，input 必须是对象。
func TestMessagesNonStreamingToolUse(t *testing.T) {
	sse := "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"," +
		"\"tool_calls\":[{\"index\":0,\"id\":\"call_9\",\"type\":\"function\"," +
		"\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"北京\\\"}\"}}]}}]}\n\n" +
		"data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]," +
		"\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":4}}\n\n" +
		"data: [DONE]\n\n"
	up := newFakeUpstream(t, func(string) (int, string, bool) { return 200, sse, true })
	h := messagesHandler(t, up)
	rec := postMessages(t, h, `{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"stream":false}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, rec.Body.String())
	}
	blocks, _ := got["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("blocks = %d, want 1（%s）", len(blocks), rec.Body.String())
	}
	b := messagesMap(blocks[0])
	if messagesStr(b["type"]) != "tool_use" {
		t.Fatalf("type = %v, want tool_use", messagesStr(b["type"]))
	}
	if messagesStr(b["id"]) != "call_9" {
		t.Errorf("id = %v", messagesStr(b["id"]))
	}
	if messagesStr(b["name"]) != "get_weather" {
		t.Errorf("name = %v", messagesStr(b["name"]))
	}
	input := messagesMap(b["input"])
	if messagesStr(input["city"]) != "北京" {
		t.Errorf("input 应是解析后的对象: %#v", b["input"])
	}
	if messagesStr(got["stop_reason"]) != "tool_use" {
		t.Errorf("stop_reason = %v, want tool_use", got["stop_reason"])
	}
}
/* ------------------------------ 错误与边界 ------------------------------ */

func TestMessagesInvalidJSON(t *testing.T) {
	cap := &capturedMessagesUpstream{}
	h := messagesHandler(t, newCapturingMessagesUpstream(t, "", cap))
	rec := postMessages(t, h, `{not json`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if messagesStr(got["type"]) != "error" {
		t.Errorf("应返回 Anthropic 错误形状, got %#v", got)
	}
	if messagesStr(messagesMap(got["error"])["type"]) != "invalid_request_error" {
		t.Errorf("error.type = %v", messagesMap(got["error"])["type"])
	}
}

// 鉴权失败：Claude Code 认 Anthropic 的 authentication_error。
func TestMessagesUnauthenticated(t *testing.T) {
	cap := &capturedMessagesUpstream{}
	up := newCapturingMessagesUpstream(t, "", cap)
	p := testPoolWith(&auth.Auth{UID: "u1", AccessToken: "at1", ExpiresAt: 9999999999})
	h := NewHandler(Config{Pool: p, Upstream: up, APIKey: "secret"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if messagesStr(got["type"]) != "error" {
		t.Errorf("应返回 Anthropic 错误形状, got %#v", got)
	}
	if messagesStr(messagesMap(got["error"])["type"]) != "authentication_error" {
		t.Errorf("error.type = %v, want authentication_error", messagesMap(got["error"])["type"])
	}
}

// messages 路由必须与 chat/responses 同待遇：进请求日志归档。
func TestMessagesRouteRegistered(t *testing.T) {
	cap := &capturedMessagesUpstream{}
	h := messagesHandler(t, newCapturingMessagesUpstream(t, "data: [DONE]\n\n", cap))
	rec := postMessages(t, h, `{"model":"claude-sonnet-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`)
	// 路由不存在时 ServeMux 返回 404；注册后应走到 chat 链路。
	if rec.Code == http.StatusNotFound {
		t.Fatal("/v1/messages 路由未注册")
	}
}








// /model 列表里的别名必须与网关模型一一对应：两个别名指向同一模型，
// 会在选择器里显示成两行同名条目（用户可见的 bug）。这张表同时锁住
// 「不重复」和「覆盖全部已注册模型」两个不变量。
func TestMessagesModelMappingIsOneToOne(t *testing.T) {
	// 客户端 settings.json 里 modelPicker.options 用的别名（即会出现在
	// /model 列表里的那批）。claude-sonnet-4-5 / claude-mythos-preview 不在其中：
	// 前者是 Claude Code 内建默认 sonnet，后者是它自己会请求的预览名。
	pickerAliases := []string{
		"claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4-0",
		"claude-opus-3-5", "claude-opus-3",
		"claude-sonnet-4-0", "claude-sonnet-5-5",
		"claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-sonnet",
		"claude-haiku-4-5", "claude-haiku-4-0", "claude-3-5-haiku", "claude-3-haiku",
		"claude-fable-5", "claude-fable-4-5", "claude-fable-4-0", "claude-fable-3-5",
	}
	seenModel := map[string]string{}
	for _, alias := range pickerAliases {
		model := messagesModel(alias)
		if prev, dup := seenModel[model]; dup {
			t.Errorf("别名 %q 与 %q 都映射到 %s —— /model 里会出现两行同名", prev, alias, model)
			continue
		}
		seenModel[model] = alias
	}
	// 网关注册模型数应与别名数一致（多一个少一个都说明有模型没接到 /model）。
	if len(seenModel) != len(pickerAliases) {
		t.Errorf("映射到 %d 个不同模型，别名有 %d 个", len(seenModel), len(pickerAliases))
	}
}

