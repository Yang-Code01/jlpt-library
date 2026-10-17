// Responses API 兼容层（POST /v1/responses）。
//
// 为什么要有这一层：codex >= 0.125 只讲 Responses 协议，而本网关与上游 WorkBuddy
// 都只有 /v1/chat/completions。历史方案是在网关前面串一个独立进程做协议桥
// （cn-bridge: responses <-> chat），多一个进程、多一份故障点、多一次部署。
// 这里把翻译搬进网关自身：同一进程、同一套选号/粘性/降温/用量/请求日志，
// 对外同时提供两条协议。
//
// 实现方式刻意选「复用 chat 链路」而不是「复制一份上游调用」：
//
//	Responses 请求 --responsesRequestToChat--> chat 请求
//	            --h.chatCompletions(翻译型 ResponseWriter)--> 上游
//	上游 chat SSE --responsesWriter 逐帧翻译--> Responses 事件流
//
// 因此 chatCompletions 的轮转、粘性会话、降级提示词、冷却、错误策略、
// 用量账本、请求归档**全部自动继承**，不存在第二份调度状态需要同步、
// 也不会出现「chat 路由修了、responses 路由没修」这类漂移。
//
// 协议口径（与已验证可用的 Node 桥逐条对齐）：
//   - 不发送上游不认的字段：reasoning_effort / stream_options / tools[].strict；
//   - 长度字段用 max_tokens（上游不认 max_output_tokens / max_completion_tokens）；
//   - developer 角色降级为 system（上游不支持 developer）；
//   - custom 工具（如 apply_patch）表达成「单参数 input」的 function 工具；
//   - 流式事件序：response.created → output_item.added → output_text.delta*
//     → output_item.done* → response.completed；
//   - 推理内容（reasoning_content / thinking）不上行：codex 0.160 对这种
//     「没有 reasoning item 的纯文本流」是宽容的，而乱发 reasoning 事件会
//     产生 "ReasoningSummaryDelta without active item" 噪音（Node 桥实测）。
package server

import (
	"bytes"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

/* ------------------------------------------------------------------ */
/* 取值工具                                                             */
/* ------------------------------------------------------------------ */

// Responses 请求体来自外部客户端，字段缺失/类型错位一律当「没给」，不报错——
// 与「宁可少发不可错发」的取向一致（多余字段会被上游拒绝）。
func responsesMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func responsesStr(v any) string {
	s, _ := v.(string)
	return s
}

func responsesBool(v any) bool {
	b, _ := v.(bool)
	return b
}

// responsesNum 把 JSON 数字（float64）与 Go 侧整数统一成 float64；其余为 0。
func responsesNum(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		if f, err := n.Float64(); err == nil {
			return f
		}
	}
	return 0
}

// newResponsesID 生成 Responses 侧对象 id（resp_ / msg_ / fc_ / call_）。
// 形状对齐 OpenAI：前缀 + 下划线 + 随机十六进制。随机源失败时退化为时间戳。
func newResponsesID(prefix string) string {
	var b [10]byte
	if _, err := crand.Read(b[:]); err == nil {
		return prefix + "_" + hex.EncodeToString(b[:])
	}
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}

/* ------------------------------------------------------------------ */
/* 请求翻译：Responses -> Chat Completions                              */
/* ------------------------------------------------------------------ */

// responsesPartToChat 把 Responses 的 content part 翻译成 chat 的 content part。
// 返回 nil 表示该 part 无法表达（丢弃）。
func responsesPartToChat(part any) map[string]any {
	if s, ok := part.(string); ok {
		return map[string]any{"type": "text", "text": s}
	}
	m := responsesMap(part)
	if m == nil {
		return nil
	}
	switch responsesStr(m["type"]) {
	case "input_text", "output_text", "text", "summary_text":
		return map[string]any{"type": "text", "text": responsesStr(m["text"])}
	case "refusal":
		return map[string]any{"type": "text", "text": responsesStr(m["refusal"])}
	case "input_image":
		url := responsesStr(m["image_url"])
		if url == "" {
			url = responsesStr(m["url"])
		}
		fileID := responsesStr(m["file_id"])
		if url == "" && fileID == "" {
			return nil
		}
		if url == "" {
			url = fileID
		}
		imageURL := map[string]any{"url": url}
		if d := responsesStr(m["detail"]); d != "" {
			imageURL["detail"] = d
		}
		return map[string]any{"type": "image_url", "image_url": imageURL}
	case "input_audio":
		audioURL := responsesStr(m["audio_url"])
		if audioURL == "" {
			return nil
		}
		return map[string]any{"type": "input_audio", "input_audio": map[string]any{"data": audioURL, "format": "wav"}}
	}
	return nil
}

// responsesContentToChat 把 Responses 的 content（裸字符串或 part 数组）转成 chat 的 content。
// 单段文本退化成裸字符串：对上游的兼容性最好。
func responsesContentToChat(content any) any {
	if content == nil {
		return ""
	}
	if s, ok := content.(string); ok {
		return s
	}
	list, ok := content.([]any)
	if !ok {
		return fmt.Sprint(content)
	}
	parts := make([]any, 0, len(list))
	for _, p := range list {
		if c := responsesPartToChat(p); c != nil {
			parts = append(parts, c)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	if len(parts) == 1 {
		if m, ok := parts[0].(map[string]any); ok && responsesStr(m["type"]) == "text" {
			return m["text"]
		}
	}
	return parts
}

// responsesOutputToText 把工具输出（function_call_output.output）压成一段文本。
func responsesOutputToText(output any) string {
	if output == nil {
		return ""
	}
	if s, ok := output.(string); ok {
		return s
	}
	if list, ok := output.([]any); ok {
		parts := make([]string, 0, len(list))
		for _, o := range list {
			switch v := o.(type) {
			case string:
				parts = append(parts, v)
			case map[string]any:
				if t := responsesStr(v["text"]); t != "" {
					parts = append(parts, t)
					continue
				}
				switch responsesStr(v["type"]) {
				case "input_image", "encrypted_content":
					parts = append(parts, "[image]")
					continue
				}
				if raw, err := json.Marshal(v); err == nil {
					parts = append(parts, string(raw))
				}
			default:
				if raw, err := json.Marshal(v); err == nil {
					parts = append(parts, string(raw))
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	raw, err := json.Marshal(output)
	if err != nil {
		return fmt.Sprint(output)
	}
	return string(raw)
}

// responsesAppendToolCall 把一条 function_call 追加到 messages：能并入上一条
// 带 tool_calls 的 assistant 消息就并入，否则新起一条 assistant 消息。
// 并行工具调用（codex 常见）必须并进同一条 assistant 消息，上游按消息聚合。
func responsesAppendToolCall(msgs []any, callID, name, args string) []any {
	entry := map[string]any{
		"id":   callID,
		"type": "function",
		"function": map[string]any{
			"name":      name,
			"arguments": args,
		},
	}
	if len(msgs) > 0 {
		if last, ok := msgs[len(msgs)-1].(map[string]any); ok && responsesStr(last["role"]) == "assistant" {
			if prev, ok := last["tool_calls"].([]any); ok {
				last["tool_calls"] = append(prev, entry)
				return msgs
			}
		}
	}
	// content: null —— 与参考实现同口径（assistant + tool_calls 不带文本时
	// 用 null 而不是空串，上游对两者的处理不一致）。
	return append(msgs, map[string]any{
		"role":       "assistant",
		"content":    nil,
		"tool_calls": []any{entry},
	})
}

// responsesMergeable 判断两条相邻消息能否合并：同角色、都是裸文本 content、都不带 tool_calls。
// Responses 的 input 常把同一条 user 消息拆成多个 message item，逐条透传会让上游
// 以为有多轮，合并后语义更接近原意。
//
// 两条**必须**排除的情形：
//   - 带 tool_calls 的 assistant 消息：并入会把并行调用与后续结果错位；
//   - role=tool 的消息：每条只对应用一个 tool_call_id，合并即丢 id
//     （codex 并行工具调用必然产生连续的多条 function_call_output）。
//   - role=assistant 的**纯文本**歷史消息：合并会让上游把多轮回答看成一条。
func responsesMergeable(a, b map[string]any) bool {
	role := responsesStr(a["role"])
	if role != responsesStr(b["role"]) {
		return false
	}
	if role == "tool" || a["tool_call_id"] != nil || b["tool_call_id"] != nil {
		return false
	}
	if role == "assistant" {
		return false
	}
	if a["tool_calls"] != nil || b["tool_calls"] != nil {
		return false
	}
	_, aText := a["content"].(string)
	_, bText := b["content"].(string)
	return aText && bText
}

// responsesMessages 把 Responses 的 instructions + input 翻译成 chat 的 messages。
func responsesMessages(body map[string]any) []any {
	msgs := []any{}
	push := func(m map[string]any) {
		if m == nil {
			return
		}
		if len(msgs) > 0 {
			if last, ok := msgs[len(msgs)-1].(map[string]any); ok && responsesMergeable(last, m) {
				l, _ := last["content"].(string)
				c, _ := m["content"].(string)
				switch {
				case l != "" && c != "":
					last["content"] = l + "\n\n" + c
				default:
					last["content"] = l + c
				}
				return
			}
		}
		msgs = append(msgs, m)
	}

	if ins := responsesStr(body["instructions"]); strings.TrimSpace(ins) != "" {
		push(map[string]any{"role": "system", "content": ins})
	}

	input := body["input"]
	items := []any{}
	switch v := input.(type) {
	case string:
		items = append(items, v)
	case []any:
		items = append(items, v...)
	case map[string]any:
		items = append(items, v)
	}

	for _, raw := range items {
		if s, ok := raw.(string); ok {
			push(map[string]any{"role": "user", "content": s})
			continue
		}
		item := responsesMap(raw)
		if item == nil {
			continue
		}
		switch responsesStr(item["type"]) {
		case "message", "agent_message":
			role := responsesStr(item["role"])
			if role == "" {
				role = "user"
			}
			if role == "developer" {
				role = "system" // 上游不支持 developer 角色
			}
			push(map[string]any{"role": role, "content": responsesContentToChat(item["content"])})
		case "function_call":
			id := responsesStr(item["call_id"])
			if id == "" {
				id = responsesStr(item["id"])
			}
			if id == "" {
				id = newResponsesID("call")
			}
			msgs = responsesAppendToolCall(msgs, id, responsesStr(item["name"]), responsesStr(item["arguments"]))
		case "custom_tool_call":
			id := responsesStr(item["call_id"])
			if id == "" {
				id = responsesStr(item["id"])
			}
			if id == "" {
				id = newResponsesID("call")
			}
			args := responsesStr(item["input"])
			if args == "" {
				if raw, err := json.Marshal(item["input"]); err == nil {
					args = string(raw)
				}
			}
			msgs = responsesAppendToolCall(msgs, id, responsesStr(item["name"]), args)
		case "function_call_output", "custom_tool_call_output":
			id := responsesStr(item["call_id"])
			if id == "" {
				id = responsesStr(item["id"])
			}
			push(map[string]any{"role": "tool", "tool_call_id": id, "content": responsesOutputToText(item["output"])})
		default:
			// reasoning / web_search_call / image_generation_call / local_shell_call 等
			// chat 协议无法表达的历史 item：安静跳过（codex 会把上一轮的这些 item 回传）。
		}
	}
	return msgs
}

// responsesToolsToChat 把 Responses 的 tools 翻译成 chat 的 tools，并回填 kind：
// 工具名 -> 原始类型（"function" / "custom"），供响应侧还原 item 形状。
func responsesToolsToChat(tools any, kind map[string]string) []any {
	list, _ := tools.([]any)
	out := make([]any, 0, len(list))
	for _, raw := range list {
		t := responsesMap(raw)
		if t == nil {
			continue
		}
		name := responsesStr(t["name"])
		typ := responsesStr(t["type"])
		if name == "" || typ == "" {
			continue
		}
		switch typ {
		case "function":
			params := t["parameters"]
			if params == nil {
				params = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			kind[name] = "function"
			out = append(out, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        name,
					"description": responsesStr(t["description"]),
					"parameters":  params,
					// strict 不透传：上游不认（参考实现同结论）。
				},
			})
		case "custom":
			// chat 协议没有 custom 工具，退化成一个「单参数 input」的 function：
			// 上游模型照样能调用，响应侧再按 kind 还原。
			desc := strings.TrimSpace(responsesStr(t["description"]) + "\n\n(该工具接收一个名为 input 的原始字符串参数。)")
			kind[name] = "custom"
			out = append(out, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        name,
					"description": desc,
					"parameters": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"input": map[string]any{"type": "string", "description": "工具原始输入内容"},
						},
						"required": []any{"input"},
					},
				},
			})
		default:
			// web_search / local_shell / mcp 等 chat 无法表达的工具类型：丢弃。
		}
	}
	return out
}

// responsesToolChoiceToChat 翻译 tool_choice；nil 表示不带该字段。
func responsesToolChoiceToChat(tc any, kind map[string]string) any {
	if tc == nil {
		return nil
	}
	if s, ok := tc.(string); ok {
		return s
	}
	m := responsesMap(tc)
	if m == nil {
		return "auto"
	}
	switch responsesStr(m["type"]) {
	case "function", "custom":
		name := responsesStr(m["name"])
		if name != "" {
			if _, ok := kind[name]; !ok {
				return nil // 指定了不存在的工具：不带，避免上游报错
			}
		}
		return map[string]any{"type": "function", "function": map[string]any{"name": name}}
	case "allowed_tools":
		return "auto"
	}
	return "auto"
}

// responsesRequestToChat 把 Responses 请求体整体翻译成 chat/completions 请求体。
func responsesRequestToChat(body map[string]any) (map[string]any, map[string]string) {
	kind := map[string]string{}
	chat := map[string]any{
		"model":    body["model"],
		"messages": responsesMessages(body),
	}
	// 默认流式：codex 一律 stream=true，缺省成流式更贴合调用方预期。
	if v, ok := body["stream"].(bool); ok {
		chat["stream"] = v
	} else {
		chat["stream"] = true
	}

	if tools := responsesToolsToChat(body["tools"], kind); len(tools) > 0 {
		chat["tools"] = tools
		if choice := responsesToolChoiceToChat(body["tool_choice"], kind); choice != nil {
			chat["tool_choice"] = choice
		}
		if v, ok := body["parallel_tool_calls"].(bool); ok {
			chat["parallel_tool_calls"] = v
		}
	}

	maxOut := responsesNum(body["max_output_tokens"])
	if maxOut == 0 {
		maxOut = responsesNum(body["max_tokens"])
	}
	if maxOut > 0 {
		chat["max_tokens"] = int(maxOut)
	}

	// json_schema 结构化输出：尽力而为地降级成 chat 的 json_object。
	if text := responsesMap(body["text"]); text != nil {
		if format := responsesMap(text["format"]); format != nil && responsesStr(format["type"]) == "json_schema" {
			chat["response_format"] = map[string]any{"type": "json_object"}
		}
	}

	return chat, kind
}

/* ------------------------------------------------------------------ */
/* 响应翻译：Chat -> Responses                                          */
/* ------------------------------------------------------------------ */

// responsesUsage 把 chat 的 usage 映射成 Responses 的 usage 形状。
func responsesUsage(u any) map[string]any {
	m := responsesMap(u)
	prompt := responsesNum(m["prompt_tokens"])
	if prompt == 0 {
		prompt = responsesNum(m["input_tokens"])
	}
	completion := responsesNum(m["completion_tokens"])
	if completion == 0 {
		completion = responsesNum(m["output_tokens"])
	}
	cached := responsesNum(responsesMap(m["prompt_tokens_details"])["cached_tokens"])
	reasoning := responsesNum(responsesMap(m["completion_tokens_details"])["reasoning_tokens"])
	total := responsesNum(m["total_tokens"])
	if total == 0 {
		total = prompt + completion
	}
	return map[string]any{
		"input_tokens":          int(prompt),
		"input_tokens_details":  map[string]any{"cached_tokens": int(cached)},
		"output_tokens":         int(completion),
		"output_tokens_details": map[string]any{"reasoning_tokens": int(reasoning)},
		"total_tokens":          int(total),
	}
}

// responsesEnvelope 组装 Response 对象（非流式响应体 与 流式 response.created /
// response.completed 的 response 字段共用同一形状）。
func responsesEnvelope(id, model string, items []any, usage any, status string) map[string]any {
	if items == nil {
		items = []any{}
	}
	return map[string]any{
		"id":                  id,
		"object":              "response",
		"created_at":          time.Now().Unix(),
		"status":              status,
		"model":               model,
		"output":              items,
		"usage":               responsesUsage(usage),
		"parallel_tool_calls": true,
		"tool_choice":         "auto",
		"tools":               []any{},
	}
}

// responsesItemsFromChatMessage 把 chat 的 message（非流式 choices[0].message）
// 转成 Responses 的 output items。
func responsesItemsFromChatMessage(msg map[string]any, kind map[string]string) []any {
	items := []any{}
	text := responsesStr(msg["content"])
	if text == "" && msg["content"] != nil {
		text = responsesOutputToText(msg["content"])
	}
	if text != "" {
		items = append(items, map[string]any{
			"type":    "message",
			"id":      newResponsesID("msg"),
			"role":    "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": text}},
		})
	}
	if calls, ok := msg["tool_calls"].([]any); ok {
		for _, raw := range calls {
			tc := responsesMap(raw)
			if tc == nil {
				continue
			}
			fn := responsesMap(tc["function"])
			name := responsesStr(fn["name"])
			if name == "" {
				name = responsesStr(tc["name"])
			}
			args := responsesStr(fn["arguments"])
			if args == "" {
				args = responsesStr(tc["arguments"])
			}
			callID := responsesStr(tc["id"])
			if callID == "" {
				callID = newResponsesID("call")
			}
			items = append(items, map[string]any{
				"type":      "function_call",
				"id":        newResponsesID("fc"),
				"name":      name,
				"call_id":   callID,
				"arguments": args,
			})
		}
	}
	return items
}

// responsesFirstChoiceMessage 取 choices[0].message（非流式聚合响应）。
func responsesFirstChoiceMessage(resp map[string]any) map[string]any {
	choices, ok := resp["choices"].([]any)
	if !ok || len(choices) == 0 {
		return nil
	}
	return responsesMap(responsesMap(choices[0])["message"])
}

/* ------------------------------------------------------------------ */
/* 流式翻译：chat SSE -> Responses 事件流                                */
/* ------------------------------------------------------------------ */

// responsesToolCall 是流式 tool_calls 的累积状态（参数分片拼接）。
type responsesToolCall struct {
	ID   string
	Name string
	Args strings.Builder
}

// responsesStream 把上游 chat SSE 帧实时翻译成 Responses 事件。
type responsesStream struct {
	w       http.ResponseWriter
	flusher http.Flusher
	id      string
	model   string
	seq     int

	msgID       string
	textStarted bool
	text        strings.Builder
	calls       map[int]*responsesToolCall
	callOrder   []int
	usage       any
	finish      string
	finished    bool
	buf         []byte
}

func newResponsesStream(w http.ResponseWriter, fl http.Flusher, id, model string) *responsesStream {
	return &responsesStream{
		w:       w,
		flusher: fl,
		id:      id,
		model:   model,
		msgID:   newResponsesID("msg"),
		calls:   map[int]*responsesToolCall{},
	}
}

// event 写一帧 Responses SSE（event: <type> + data: <payload>），并立即 flush。
func (s *responsesStream) event(typ string, fields map[string]any) {
	s.seq++
	payload := make(map[string]any, len(fields)+2)
	payload["type"] = typ
	payload["sequence_number"] = s.seq
	for k, v := range fields {
		payload[k] = v
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", typ, raw); err != nil {
		return
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

// start 发出流的首帧 response.created（此时 output 为空、状态 in_progress）。
func (s *responsesStream) start() {
	s.event("response.created", map[string]any{
		"response": map[string]any{
			"id":         s.id,
			"object":     "response",
			"created_at": time.Now().Unix(),
			"status":     "in_progress",
			"model":      s.model,
			"output":     []any{},
		},
	})
}

// feed 累积字节流并按行切分（SSE 以 \n 分行，帧内不含裸换行）。
func (s *responsesStream) feed(p []byte) {
	s.buf = append(s.buf, p...)
	for {
		i := bytes.IndexByte(s.buf, '\n')
		if i < 0 {
			return
		}
		line := strings.TrimRight(string(s.buf[:i]), "\r")
		// 显式 copy（而不是 append(s.buf[:0], rest...)）：源与目标重叠时语义最清楚。
		n := copy(s.buf, s.buf[i+1:])
		s.buf = s.buf[:n]
		s.line(line)
	}
}

// line 处理一行 SSE：只认 data: 帧，注释/其它行忽略。
func (s *responsesStream) line(line string) {
	if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
		return
	}
	data := strings.TrimSpace(line[len("data:"):])
	if data == "" || data == "[DONE]" {
		return
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(data), &obj); err != nil {
		return // 非 JSON 帧（如上游心跳/纯文本）：忽略，不影响已翻译内容
	}
	if e, ok := obj["error"].(map[string]any); ok {
		// 上游中途错误帧（限流/审核/型号不可用）：按 Responses 规约发 error 事件。
		// 不在此终止：内容可能已部分下发，末尾仍发 response.completed，让客户端
		// 无论如何都能正常收尾（不会卡在"流没结束"的超时上）。
		s.event("error", map[string]any{
			"code":    responsesStr(e["code"]),
			"message": responsesStr(e["message"]),
			"param":   nil,
		})
		return
	}
	s.chunk(obj)
}

// chunk 处理一个 chat completion chunk。
func (s *responsesStream) chunk(obj map[string]any) {
	if u, ok := obj["usage"]; ok && u != nil {
		s.usage = u
	}
	choices, ok := obj["choices"].([]any)
	if !ok || len(choices) == 0 {
		return
	}
	choice := responsesMap(choices[0])
	if choice == nil {
		return
	}
	if d := responsesMap(choice["delta"]); d != nil {
		s.delta(d)
	}
	if m := responsesMap(choice["message"]); m != nil {
		s.delta(m)
	}
	if fr := responsesStr(choice["finish_reason"]); fr != "" {
		s.finish = fr
	}
}

// delta 处理增量：文本 / 工具调用分片。
func (s *responsesStream) delta(d map[string]any) {
	if text := responsesStr(d["content"]); text != "" {
		if !s.textStarted {
			// codex 要求 delta 之前先有 active item，否则每帧都往 stderr 刷
			// "OutputTextDelta without active item"（噪音，不影响结果）。
			s.event("response.output_item.added", map[string]any{
				"output_index": 0,
				"item": map[string]any{
					"type":    "message",
					"id":      s.msgID,
					"role":    "assistant",
					"content": []any{},
				},
			})
		}
		s.textStarted = true
		s.text.WriteString(text)
		s.event("response.output_text.delta", map[string]any{
			"item_id":       s.msgID,
			"output_index":  0,
			"content_index": 0,
			"delta":         text,
		})
	}
	calls, ok := d["tool_calls"].([]any)
	if !ok {
		return
	}
	for _, raw := range calls {
		tc := responsesMap(raw)
		if tc == nil {
			continue
		}
		idx := len(s.calls)
		if v, ok := tc["index"]; ok {
			idx = int(responsesNum(v))
		}
		entry := s.calls[idx]
		if entry == nil {
			entry = &responsesToolCall{}
			s.calls[idx] = entry
			s.callOrder = append(s.callOrder, idx)
		}
		if id := responsesStr(tc["id"]); id != "" {
			entry.ID = id
		}
		fn := responsesMap(tc["function"])
		if name := responsesStr(fn["name"]); name != "" {
			// 工具名可能被上游切成多片，且中间片可能与已累积内容重叠（"get_weather"
			// 分片成 "get_" + "weather"），只在后缀不匹配时拼接。
			switch {
			case entry.Name == "":
				entry.Name = name
			case name != entry.Name && !strings.HasSuffix(entry.Name, name):
				entry.Name += name
			}
		}
		if args := responsesStr(fn["arguments"]); args != "" {
			entry.Args.WriteString(args)
		}
	}
}

// finalize 收尾：output_item.done* + response.completed。幂等。
func (s *responsesStream) finalize() {
	if s.finished {
		return
	}
	s.finished = true

	items := []any{}
	out := 0
	if s.textStarted {
		item := map[string]any{
			"type":    "message",
			"id":      s.msgID,
			"role":    "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": s.text.String()}},
		}
		items = append(items, item)
		s.event("response.output_item.done", map[string]any{"output_index": out, "item": item})
		out++
	}

	sort.Ints(s.callOrder)
	for _, idx := range s.callOrder {
		call := s.calls[idx]
		if call == nil || call.Name == "" {
			continue
		}
		callID := call.ID
		if callID == "" {
			callID = newResponsesID("call")
		}
		args := call.Args.String()
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		item := map[string]any{
			"type":      "function_call",
			"id":        newResponsesID("fc"),
			"name":      call.Name,
			"call_id":   callID,
			"arguments": args,
		}
		items = append(items, item)
		s.event("response.output_item.done", map[string]any{"output_index": out, "item": item})
		out++
	}

	s.event("response.completed", map[string]any{
		"response": responsesEnvelope(s.id, s.model, items, s.usage, "completed"),
	})
}

/* ------------------------------------------------------------------ */
/* HTTP 层                                                              */
/* ------------------------------------------------------------------ */

// responsesWriter 是交给内部 chatCompletions 的「翻译型 ResponseWriter」：
// chat 侧以为自己在对客户端写 chat 协议，实际每一帧都被翻译成 Responses 协议。
//
// 三条路径：
//   - chat 写 text/event-stream（流式）→ 起 responsesStream，逐帧翻译 + flush；
//   - chat 写 application/json（非流式成功）→ 缓冲，结束后整体转成 Response 对象；
//   - chat 写非 200（调度/上游错误）→ 原样透出状态与错误体（已是 OpenAI 形状，
//     codex 能直接展示 message，不必再包一层）。
type responsesWriter struct {
	real    http.ResponseWriter
	flusher http.Flusher
	kind    map[string]string
	model   string
	id      string

	hdr         http.Header
	status      int
	wroteHeader bool

	stream      *responsesStream
	started     bool
	jsonBuf     bytes.Buffer
	passthrough bool
	done        bool
}

func newResponsesWriter(w http.ResponseWriter, kind map[string]string, model string) *responsesWriter {
	fl, _ := w.(http.Flusher)
	return &responsesWriter{
		real:    w,
		flusher: fl,
		kind:    kind,
		model:   model,
		id:      newResponsesID("resp"),
		hdr:     http.Header{},
	}
}

func (s *responsesWriter) Header() http.Header { return s.hdr }

func (s *responsesWriter) WriteHeader(code int) {
	if s.wroteHeader {
		return
	}
	s.wroteHeader = true
	s.status = code
	if code == http.StatusOK {
		return // 200 的具体形态（SSE / JSON）在首次 Write 时按 Content-Type 判定
	}
	s.passthrough = true
	dst := s.real.Header()
	for k, vv := range s.hdr {
		dst[k] = vv
	}
	s.real.WriteHeader(code)
}

func (s *responsesWriter) Write(p []byte) (int, error) {
	if s.passthrough {
		return s.real.Write(p)
	}
	if s.started {
		s.stream.feed(p)
		return len(p), nil
	}
	if strings.Contains(s.hdr.Get("Content-Type"), "text/event-stream") {
		s.startStream()
		s.stream.feed(p)
		return len(p), nil
	}
	s.jsonBuf.Write(p)
	return len(p), nil
}

func (s *responsesWriter) Flush() {
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

// startStream 切换到 Responses 事件流：设定客户端可见的头，再发 response.created。
func (s *responsesWriter) startStream() {
	s.started = true
	dst := s.real.Header()
	// 不照抄 chat 侧的 Content-Type（text/event-stream 不带 charset），
	// 也没有必要把 X-Accel-Buffering 之类逐条复制：这是网关对外的协议。
	dst.Set("Content-Type", "text/event-stream; charset=utf-8")
	dst.Set("Cache-Control", "no-cache, no-transform")
	dst.Set("Connection", "keep-alive")
	dst.Set("X-Accel-Buffering", "no")
	s.real.WriteHeader(http.StatusOK)
	s.stream = newResponsesStream(s.real, s.flusher, s.id, s.model)
	s.stream.start()
}

// finish 在内部 chat 调用返回后调用：补齐非流式转换或流式收尾。
func (s *responsesWriter) finish() {
	if s.done || s.passthrough {
		return
	}
	s.done = true

	if s.started {
		s.stream.finalize()
		return
	}

	if s.jsonBuf.Len() > 0 {
		var chatResp map[string]any
		if err := json.Unmarshal(s.jsonBuf.Bytes(), &chatResp); err != nil {
			s.writeError(http.StatusBadGateway, "upstream_parse", "upstream returned invalid JSON: "+err.Error())
			return
		}
		items := responsesItemsFromChatMessage(responsesFirstChoiceMessage(chatResp), s.kind)
		env := responsesEnvelope(s.id, s.model, items, chatResp["usage"], "completed")
		raw, err := json.Marshal(env)
		if err != nil {
			s.writeError(http.StatusBadGateway, "upstream_parse", err.Error())
			return
		}
		s.real.Header().Set("Content-Type", "application/json")
		s.real.WriteHeader(http.StatusOK)
		_, _ = s.real.Write(raw)
		return
	}

	// chat 链路既没给状态也没给内容（理论上不会发生）：按不可用收尾。
	s.writeError(http.StatusServiceUnavailable, "no_healthy_account",
		"all accounts are temporarily unavailable, please retry later")
}

func (s *responsesWriter) writeError(status int, code, msg string) {
	raw, _ := json.Marshal(map[string]any{
		"error": map[string]any{"message": msg, "type": "api_error", "code": code},
	})
	s.real.Header().Set("Content-Type", "application/json")
	s.real.WriteHeader(status)
	_, _ = s.real.Write(raw)
}

// responses 是 POST /v1/responses 的入口：翻译请求 → 复用 chat 链路 → 翻译响应。
func (h *Handler) responses(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "read body: "+err.Error())
		return
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body: "+err.Error())
		return
	}
	chat, kind := responsesRequestToChat(body)
	if msgs, _ := chat["messages"].([]any); len(msgs) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "no messages after conversion")
		return
	}
	model := responsesStr(chat["model"])
	if model == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "missing model")
		return
	}
	chatRaw, err := json.Marshal(chat)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", "encode chat request: "+err.Error())
		return
	}

	// 复用 chat 链路：只换 body 与 URL（URL 仅为语义标识，此处直调 handler 不重路由），
	// 其余（鉴权已完成、requestTrace 挂在 context 上）原样带着走，
	// 于是选号轮转 / 粘性 / 冷却 / 降级 / 用量 / 请求归档全部照旧生效。
	sub := r.Clone(r.Context())
	sub.Body = io.NopCloser(bytes.NewReader(chatRaw))
	sub.ContentLength = int64(len(chatRaw))
	sub.URL.Path = "/v1/chat/completions"

	shim := newResponsesWriter(w, kind, model)
	defer shim.finish()
	h.chatCompletions(shim, sub)
}
