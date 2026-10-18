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

// capturedUpstream 记录上游真正收到的 chat 请求（用于断言「responses 请求被正确翻译」）。
type capturedUpstream struct {
	path string
	body map[string]any
}

func newCapturingUpstream(t *testing.T, sse string, cap *capturedUpstream) *upstream.Client {
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

// parseResponsesSSE 把 /v1/responses 的输出拆成事件对象列表。
func parseResponsesSSE(t *testing.T, raw string) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, block := range strings.Split(raw, "\n\n") {
		data := ""
		for _, line := range strings.Split(strings.TrimSpace(block), "\n") {
			if strings.HasPrefix(line, "data:") {
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
		out = append(out, obj)
	}
	return out
}

func responsesHandler(t *testing.T, up *upstream.Client) *Handler {
	t.Helper()
	p := testPoolWith(&auth.Auth{UID: "u1", AccessToken: "at1", ExpiresAt: 9999999999})
	return NewHandler(Config{Pool: p, Upstream: up})
}

func postResponses(t *testing.T, h *Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body)))
	return rec
}

/* ------------------------------ 请求翻译 ------------------------------ */

func TestResponsesRequestToChat(t *testing.T) {
	body := map[string]any{
		"model":             "glm-5.2",
		"instructions":      "你是助手",
		"max_output_tokens": float64(1234),
		"input": []any{
			map[string]any{"type": "message", "role": "user", "content": []any{
				map[string]any{"type": "input_text", "text": "第一段"},
			}},
			map[string]any{"type": "message", "role": "user", "content": []any{
				map[string]any{"type": "input_text", "text": "第二段"},
			}},
			map[string]any{"type": "reasoning", "id": "rs_1", "summary": []any{}},
			map[string]any{"type": "function_call", "call_id": "call_a", "name": "shell", "arguments": "{\"cmd\":\"ls\"}"},
			map[string]any{"type": "function_call", "call_id": "call_b", "name": "shell", "arguments": "{\"cmd\":\"pwd\"}"},
			map[string]any{"type": "function_call_output", "call_id": "call_a", "output": "a.txt"},
			map[string]any{"type": "function_call_output", "call_id": "call_b", "output": []any{
				map[string]any{"type": "input_text", "text": "/home"},
			}},
		},
		"tools": []any{
			map[string]any{"type": "function", "name": "shell", "description": "run", "parameters": map[string]any{"type": "object"}, "strict": true},
			map[string]any{"type": "custom", "name": "apply_patch", "description": "patch"},
			map[string]any{"type": "web_search"},
		},
		"tool_choice": map[string]any{"type": "function", "name": "shell"},
		"text": map[string]any{"format": map[string]any{
			"type": "json_schema", "name": "x", "schema": map[string]any{"type": "object"},
		}},
	}

	chat, kind := responsesRequestToChat(body)

	if chat["stream"] != true {
		t.Errorf("stream default = %v, want true", chat["stream"])
	}
	if chat["max_tokens"] != 1234 {
		t.Errorf("max_tokens = %v, want 1234 (上游只认 max_tokens)", chat["max_tokens"])
	}
	if _, has := chat["reasoning_effort"]; has {
		t.Errorf("reasoning_effort 不应出现在 chat 请求里")
	}
	if rf, _ := chat["response_format"].(map[string]any); responsesStr(rf["type"]) != "json_object" {
		t.Errorf("json_schema 应降级为 json_object，得到 %v", chat["response_format"])
	}

	msgs, _ := chat["messages"].([]any)
	wantRoles := []string{"system", "user", "assistant", "tool", "tool"}
	if len(msgs) != len(wantRoles) {
		t.Fatalf("messages len = %d want %d: %s", len(msgs), len(wantRoles), dump(chat["messages"]))
	}
	for i, want := range wantRoles {
		if got := responsesStr(msgs[i].(map[string]any)["role"]); got != want {
			t.Errorf("messages[%d].role = %q want %q", i, got, want)
		}
	}
	// 相邻同角色纯文本合并（Responses 常把一条 user 消息拆成多个 item）。
	if got := responsesStr(msgs[1].(map[string]any)["content"]); got != "第一段\n\n第二段" {
		t.Errorf("合并后的 user content = %q", got)
	}
	// 并行工具调用必须并进同一条 assistant 消息。
	calls, _ := msgs[2].(map[string]any)["tool_calls"].([]any)
	if len(calls) != 2 {
		t.Errorf("tool_calls = %d want 2 (并行调用须同一条 assistant 消息)", len(calls))
	}
	if msgs[2].(map[string]any)["content"] != nil {
		t.Errorf("assistant(tool_calls) 的 content 应为 null")
	}
	// tool 消息绝不能合并：各自绑自己的 tool_call_id。
	if got := responsesStr(msgs[3].(map[string]any)["tool_call_id"]); got != "call_a" {
		t.Errorf("messages[3].tool_call_id = %q want call_a", got)
	}
	if got := responsesStr(msgs[4].(map[string]any)["tool_call_id"]); got != "call_b" {
		t.Errorf("messages[4].tool_call_id = %q want call_b", got)
	}
	if got := responsesStr(msgs[4].(map[string]any)["content"]); got != "/home" {
		t.Errorf("tool 输出解析 = %q want /home", got)
	}

	// 工具：function 透传（strict 剥离）、custom 降级成单参数 input、web_search 丢弃。
	tools, _ := chat["tools"].([]any)
	if len(tools) != 2 {
		t.Fatalf("tools = %d want 2: %s", len(tools), dump(chat["tools"]))
	}
	fn := tools[0].(map[string]any)["function"].(map[string]any)
	if _, has := fn["strict"]; has {
		t.Errorf("strict 不应透传给上游")
	}
	if kind["shell"] != "function" || kind["apply_patch"] != "custom" {
		t.Errorf("kind = %v", kind)
	}
	patch := tools[1].(map[string]any)["function"].(map[string]any)
	props := patch["parameters"].(map[string]any)["properties"].(map[string]any)
	if _, has := props["input"]; !has {
		t.Errorf("custom 工具应降级成单参数 input: %v", patch["parameters"])
	}
	if tc, _ := chat["tool_choice"].(map[string]any); responsesStr(tc["type"]) != "function" {
		t.Errorf("tool_choice = %v", chat["tool_choice"])
	}
}

func TestResponsesRequestToChatDeveloperAndCustomCall(t *testing.T) {
	chat, _ := responsesRequestToChat(map[string]any{
		"model": "glm-5.2",
		"input": []any{
			map[string]any{"type": "message", "role": "developer", "content": "规则"},
			map[string]any{"type": "custom_tool_call", "call_id": "call_c", "name": "apply_patch", "input": "*** Begin Patch"},
			map[string]any{"type": "custom_tool_call_output", "call_id": "call_c", "output": "done"},
			"裸字符串输入",
		},
	})
	msgs, _ := chat["messages"].([]any)
	if len(msgs) != 4 {
		t.Fatalf("messages = %s", dump(chat["messages"]))
	}
	// developer 降级为 system（上游不支持 developer 角色）。
	if got := responsesStr(msgs[0].(map[string]any)["role"]); got != "system" {
		t.Errorf("developer 应降级为 system，得到 %q", got)
	}
	// custom_tool_call 也进 assistant.tool_calls，custom_tool_call_output 进 tool。
	calls, _ := msgs[1].(map[string]any)["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("custom_tool_call 未翻译: %s", dump(msgs[1]))
	}
	if got := responsesStr(msgs[2].(map[string]any)["role"]); got != "tool" {
		t.Errorf("custom_tool_call_output 应转 tool，得到 %q", got)
	}
	if got := responsesStr(msgs[3].(map[string]any)["content"]); got != "裸字符串输入" {
		t.Errorf("裸字符串 input 应成为 user 文本，得到 %q", got)
	}
}

/* ------------------------------ 端到端：流式 ------------------------------ */

func TestResponsesStreamEndToEnd(t *testing.T) {
	cap := &capturedUpstream{}
	h := responsesHandler(t, newCapturingUpstream(t, sseOK, cap))

	rec := postResponses(t, h, `{"model":"glm-5.2","stream":true,"instructions":"sys",
		"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}],
		"max_output_tokens":64}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	events := parseResponsesSSE(t, rec.Body.String())
	types := make([]string, 0, len(events))
	for _, e := range events {
		types = append(types, responsesStr(e["type"]))
	}
	want := []string{
		"response.created",
		"response.output_item.added",
		"response.output_text.delta",
		"response.output_item.done",
		"response.completed",
	}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Fatalf("事件序 = %v want %v", types, want)
	}
	for i, e := range events {
		if got := int(responsesNum(e["sequence_number"])); got != i+1 {
			t.Errorf("events[%d].sequence_number = %d want %d", i, got, i+1)
		}
	}
	if got := responsesStr(events[2]["delta"]); got != "你好" {
		t.Errorf("delta = %q want 你好", got)
	}
	if id := responsesStr(events[0]["response"].(map[string]any)["id"]); id == "" {
		t.Errorf("response.created 缺 id")
	}
	done := events[3]["item"].(map[string]any)
	if responsesStr(done["type"]) != "message" || responsesStr(done["role"]) != "assistant" {
		t.Errorf("output_item.done = %s", dump(done))
	}
	envelope := events[4]["response"].(map[string]any)
	if responsesStr(envelope["status"]) != "completed" {
		t.Errorf("status = %v", envelope["status"])
	}
	out, _ := envelope["output"].([]any)
	if len(out) != 1 {
		t.Fatalf("output = %s", dump(envelope["output"]))
	}
	content, _ := out[0].(map[string]any)["content"].([]any)
	if got := responsesStr(responsesMap(content[0])["text"]); got != "你好" {
		t.Errorf("output text = %q want 你好", got)
	}
	usage := envelope["usage"].(map[string]any)
	if responsesNum(usage["input_tokens"]) != 1 || responsesNum(usage["output_tokens"]) != 1 || responsesNum(usage["total_tokens"]) != 2 {
		t.Errorf("usage = %s", dump(usage))
	}

	// 上游必须收到的是「翻译后的 chat 请求」。
	if !strings.HasSuffix(cap.path, "/chat/completions") {
		t.Errorf("上游 path = %q", cap.path)
	}
	if cap.body["model"] != "glm-5.2" || cap.body["stream"] != true {
		t.Errorf("上游 body = %s", dump(cap.body))
	}
	if cap.body["max_tokens"] != float64(64) {
		t.Errorf("上游 max_tokens = %v", cap.body["max_tokens"])
	}
	upMsgs, _ := cap.body["messages"].([]any)
	if len(upMsgs) != 2 || responsesStr(upMsgs[0].(map[string]any)["role"]) != "system" {
		t.Errorf("上游 messages = %s", dump(cap.body["messages"]))
	}
}

func TestResponsesStreamToolCall(t *testing.T) {
	// 上游把工具参数分两片下发（真实 WorkBuddy 上游会保留首帧的工具名、累加 arguments，
	// 所以这里只断言参数累加与 item 形状；「工具名跨帧分片」的拼接逻辑用下面
	// TestResponsesToolNameSpansFrames 直接喂 responsesStream 验证）。
	sse := "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\"\"}}]}}]}\n\n" +
		"data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"北京\\\"}\"}}]}}]}\n\n" +
		"data: {\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n" +
		"data: [DONE]\n\n"

	cap := &capturedUpstream{}
	h := responsesHandler(t, newCapturingUpstream(t, sse, cap))
	rec := postResponses(t, h, `{"model":"glm-5.2","input":"天气如何"}`)

	events := parseResponsesSSE(t, rec.Body.String())
	if len(events) != 3 {
		t.Fatalf("事件 = %s", dump(events))
	}
	if responsesStr(events[0]["type"]) != "response.created" || responsesStr(events[1]["type"]) != "response.output_item.done" {
		t.Fatalf("事件序 = %s", dump(events))
	}
	item := events[1]["item"].(map[string]any)
	if responsesStr(item["type"]) != "function_call" {
		t.Fatalf("item = %s", dump(item))
	}
	if got := responsesStr(item["name"]); got != "get_weather" {
		t.Errorf("工具名 = %q want get_weather", got)
	}
	if got := responsesStr(item["call_id"]); got != "call_1" {
		t.Errorf("call_id = %q want call_1", got)
	}
	if got := responsesStr(item["arguments"]); got != `{"city":"北京"}` {
		t.Errorf("arguments = %q（应跨帧累加）", got)
	}
	// 无文本时必须**不**发 output_item.added（codex 只对「没有 active item 的
	// text delta」报警；纯工具调用流没有文本 delta，就不该凭空开 message item）。
	for _, e := range events {
		if responsesStr(e["type"]) == "response.output_item.added" {
			t.Errorf("纯工具调用流不应出现 output_item.added: %s", dump(e))
		}
	}
	env := events[2]["response"].(map[string]any)
	out, _ := env["output"].([]any)
	if len(out) != 1 || responsesStr(out[0].(map[string]any)["type"]) != "function_call" {
		t.Errorf("output = %s", dump(env["output"]))
	}
}

// TestResponsesToolNameSpansFrames 验证工具名跨帧分片的拼接（含上游重复整名的情形）。
func TestResponsesToolNameSpansFrames(t *testing.T) {
	s := newResponsesStream(httptest.NewRecorder(), nil, "resp_1", "glm-5.2")
	s.start()
	s.feed([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get_\"}}]}}]}\n\n"))
	s.feed([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"weather\"}}]}}]}\n\n"))
	s.feed([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"get_weather\"}}]}}]}\n\n"))
	s.finalize()
	call := s.calls[0]
	if call == nil {
		t.Fatalf("未累积工具调用")
	}
	if call.Name != "get_weather" {
		t.Errorf("工具名 = %q want get_weather", call.Name)
	}
}

/* ------------------------------ 端到端：非流式 ------------------------------ */

func TestResponsesNonStreamEndToEnd(t *testing.T) {
	cap := &capturedUpstream{}
	h := responsesHandler(t, newCapturingUpstream(t, sseOK, cap))
	rec := postResponses(t, h, `{"model":"glm-5.2","stream":false,"input":"你好"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q want application/json", ct)
	}
	var env map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("响应不是 JSON: %v body=%s", err, rec.Body.String())
	}
	if responsesStr(env["object"]) != "response" || responsesStr(env["status"]) != "completed" {
		t.Errorf("envelope = %s", dump(env))
	}
	out, _ := env["output"].([]any)
	if len(out) != 1 || responsesStr(out[0].(map[string]any)["type"]) != "message" {
		t.Fatalf("output = %s", dump(env["output"]))
	}
	content, _ := out[0].(map[string]any)["content"].([]any)
	if got := responsesStr(responsesMap(content[0])["text"]); got != "你好" {
		t.Errorf("text = %q", got)
	}
	// 注意：网关对上游**总是**用流式，客户端要非流式时由 Aggregate 在网关侧聚合，
	// 所以上游收到的 stream 恒为 true；客户端形状只体现在回给它的响应体上。
	if cap.body["stream"] != true {
		t.Errorf("上游 stream = %v want true（网关总是流式拉上游）", cap.body["stream"])
	}
}

/* ------------------------------ 错误路径 ------------------------------ */

func TestResponsesBadRequests(t *testing.T) {
	h := responsesHandler(t, newFakeUpstream(t, func(string) (int, string, bool) { return 200, sseOK, true }))
	cases := []struct{ name, body string }{
		{"非法 JSON", `{`},
		{"缺 model", `{"input":"hi"}`},
		{"缺 input", `{"model":"glm-5.2"}`},
		{"空 input 数组", `{"model":"glm-5.2","input":[]}`},
	}
	for _, c := range cases {
		rec := postResponses(t, h, c.body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: code = %d want 400 body=%s", c.name, rec.Code, rec.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("%s: 错误体不是 JSON: %s", c.name, rec.Body.String())
			continue
		}
		if _, has := body["error"]; !has {
			t.Errorf("%s: 错误体缺 error 字段: %s", c.name, rec.Body.String())
		}
	}
}

func TestResponsesUpstreamErrorPassthrough(t *testing.T) {
	// 上游整体不可用：chat 链路最终 writeOpenAIError 一个非 200，
	// shim 必须原样透出（codex 靠 error.message 展示原因），不能包成 200。
	h := responsesHandler(t, newFakeUpstream(t, func(string) (int, string, bool) {
		return 403, `{"error":{"code":"11140","message":"request illegal"}}`, false
	}))
	rec := postResponses(t, h, `{"model":"glm-5.2","input":"你好"}`)
	if rec.Code == http.StatusOK {
		t.Fatalf("上游失败却回 200: %s", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("错误体不是 JSON: %s", rec.Body.String())
	}
	if _, has := body["error"]; !has {
		t.Errorf("错误体缺 error: %s", rec.Body.String())
	}
}

func TestResponsesEmptyStreamStillCompletes(t *testing.T) {
	// 上游 200 但空流：StreamHint 会写 error 帧 + [DONE]。翻译层应透出 error 事件，
	// 并且仍然给 response.completed（否则客户端会一直等流结束而超时）。
	h := responsesHandler(t, newFakeUpstream(t, func(string) (int, string, bool) { return 200, "", true }))
	rec := postResponses(t, h, `{"model":"glm-5.2","input":"你好"}`)
	events := parseResponsesSSE(t, rec.Body.String())
	var sawError, sawCompleted bool
	for _, e := range events {
		switch responsesStr(e["type"]) {
		case "error":
			sawError = true
		case "response.completed":
			sawCompleted = true
		}
	}
	if !sawError || !sawCompleted {
		t.Errorf("空流应给出 error + response.completed，实际 %s", dump(events))
	}
}

/* ------------------------------ 纯函数 ------------------------------ */

func TestResponsesMergeableRejectsToolMessages(t *testing.T) {
	toolA := map[string]any{"role": "tool", "tool_call_id": "a", "content": "x"}
	toolB := map[string]any{"role": "tool", "tool_call_id": "b", "content": "y"}
	if responsesMergeable(toolA, toolB) {
		t.Errorf("role=tool 的消息不可合并（tool_call_id 会丢）")
	}
	u1 := map[string]any{"role": "user", "content": "a"}
	u2 := map[string]any{"role": "user", "content": "b"}
	if !responsesMergeable(u1, u2) {
		t.Errorf("相邻同角色纯文本 user 应可合并")
	}
	a1 := map[string]any{"role": "assistant", "content": "a"}
	a2 := map[string]any{"role": "assistant", "content": "b"}
	if responsesMergeable(a1, a2) {
		t.Errorf("assistant 文本不可合并（会把多轮回答压成一条）")
	}
}

func TestResponsesStreamDispatch(t *testing.T) {
	// 一帧一行地喂（含跨行残留）：验证 feed 的行切分与工具参数累积。
	s := newResponsesStream(httptest.NewRecorder(), nil, "resp_1", "glm-5.2")
	s.start()
	s.feed([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n"))
	s.feed([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\ndata: [DO"))
	s.feed([]byte("NE]\n\n"))
	s.finalize()
	if s.text.String() != "你好" {
		t.Errorf("文本累积 = %q", s.text.String())
	}
	if !s.finished {
		t.Errorf("finalize 未置 finished")
	}
	s.finalize() // 幂等：不应 panic / 重复发帧
}

func dump(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return "?"
	}
	return string(raw)
}
