// Anthropic Messages API 兼容层（POST /v1/messages）。
//
// 为什么要有这一层：Claude Code 只讲 Anthropic Messages 协议，而本网关与上游
// WorkBuddy 都只有 /v1/chat/completions。与 responses.go（Responses -> chat）
// 完全同构：把翻译搬进网关自身，同一进程、同一套选号/粘性/降温/用量/请求日志。
//
// 实现方式刻意选「复用 chat 链路」而不是「复制一份上游调用」：
//
//	Messages 请求 --messagesRequestToChat--> chat 请求
//	             --h.chatCompletions(翻译型 ResponseWriter)--> 上游
//	上游 chat SSE --messagesStream 逐帧翻译--> Anthropic SSE 事件流
//
// 因此 chatCompletions 的轮转、粘性会话、降级提示词、冷却、错误策略、
// 用量账本、请求归档**全部自动继承**，不存在第二份调度状态需要同步。
//
// 协议口径（对照 Claude Code 2.1.289 实测抓包对齐）：
//   - system 顶层字段 -> chat 的 system 消息（与 chat 的 system 处理一致）；
//   - content part：text -> text；image(source.type=base64|url) -> image_url；
//     tool_use -> assistant.tool_calls；tool_result -> role=tool；
//     thinking / redacted_thinking -> 丢弃（上游非 Claude 模型无 thinking 语义）；
//   - tools[].input_schema -> chat function.parameters；stop_sequences 不透传
//     （上游不认）；max_tokens 必须给（Anthropic 必填）。
//   - 流式事件序：message_start -> content_block_start* -> content_block_delta*
//     -> content_block_stop* -> message_delta -> message_stop；
//   - 错误体用 Anthropic 形状 {"type":"error","error":{"type":...,"message":...}}
//     （Claude Code 按 error.type 分支提示，OpenAI 形状它不认）。
//
// 模型名映射（messagesModel）：Claude Code 的 /model 选择器与 unrecognized_model
// 校验要求形如 claude-sonnet-4-5 的 Anthropic 风格 id，且**原样**发给上游
// （实测抓包：body 里就是 "model":"claude-sonnet-4-5"，客户端不做任何改写）。
// 故本层做一次显式映射，把 claude-* 家族别名翻成网关的 cn:* 模型名。
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
/* 取值工具（与 responses.go 同名不同实现，避免跨文件耦合）             */
/* ------------------------------------------------------------------ */

func messagesMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func messagesStr(v any) string {
	s, _ := v.(string)
	return s
}

func messagesBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func messagesNum(v any) float64 {
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

// newMessagesID 生成 Anthropic 侧对象 id（msg_ / toolu_ / srv_）。形状对齐
// Anthropic：前缀 + 下划线 + 24 位十六进制。随机源失败退化为时间戳。
func newMessagesID(prefix string) string {
	var b [12]byte
	if _, err := crand.Read(b[:]); err == nil {
		return prefix + "_" + hex.EncodeToString(b[:])
	}
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}

/* ------------------------------------------------------------------ */
/* 模型名映射                                                          */
/* ------------------------------------------------------------------ */

// messagesModelFamilies：Claude Code 会请求的家族别名 -> 网关模型。
// 值里的占位符 %s 由 messagesPickDefault 之外的具体映射填充；此处只放
// 「一个家族固定对应一个网关模型」的静态映射。顺序即优先级。
var messagesModelFamilies = []struct {
	Prefix string // Anthropic 家族前缀，如 "claude-opus-"
	Model  string // 目标网关模型（带 cn: 前缀）
}{
	// 网关注册模型的一一对应别名（claude-* -> cn:*）。顺序即匹配优先级：
	// 长/具体的前缀在前，避免 "claude-sonnet-4" 抢走 "claude-sonnet-4-5"。
	//
	// 命名口径：别名沿用 Claude Code 认识的家族词（opus/sonnet/haiku/fable），
	// 使其 /model 选择器与 unrecognized_model 校验都能通过；版本段只是占位，
	// 真正决定用哪个模型的是这张表。**19 个别名对 19 个模型，一一对应，
	// 不允许两个别名指向同一模型**（否则 /model 里会出现两个同名行）。
	// claude-sonnet-4-5 故意不映射：它被 Claude Code 当作默认 sonnet 别名，
	// 已被 --model 默认值与 ANTHROPIC_DEFAULT_SONNET_MODEL 占用，模型给 sonnet-4-0。
	{"claude-opus-4-6", "cn:space-bunny"},
	{"claude-opus-4-5", "cn:deepseek-v4-pro"},
	{"claude-opus-4-1", "cn:kimi-k3-1"},
	{"claude-opus-4-0", "cn:hy4-preview"},
	{"claude-opus-3-5", "cn:glm-5.3"},
	{"claude-opus-3", "cn:glm-5.2"},
	{"claude-sonnet-4-0", "cn:glm-5.1"},
	{"claude-3-7-sonnet", "cn:kimi-k2.8-preview"},
	{"claude-3-5-sonnet", "cn:kimi-k2.7"},
	{"claude-3-sonnet", "cn:kimi-k2.6"},
	{"claude-sonnet-5-5", "cn:minimax-m3"},
	{"claude-haiku-4-5", "cn:deepseek-v4.1-flash"},
	{"claude-haiku-4-0", "cn:deepseek-v4-flash"},
	{"claude-3-5-haiku", "cn:glm-5.3-flash"},
	{"claude-3-haiku", "cn:glm-5v-turbo"},
	{"claude-fable-5", "cn:auto"},
	{"claude-fable-4-5", "cn:hy4-preview-f"},
	{"claude-fable-4-0", "cn:hy3"},
	{"claude-fable-3-5", "cn:hy3-x"},
	// Claude Code 仍会请求的原生家族别名（内部小模型、子 agent 等）。
	// 这些不占用 /model 列表，故与上面无冲突。
	{"claude-sonnet-4-5", "cn:glm-5.3"},
	{"claude-mythos-preview", "cn:auto"},
}

// messagesModel 把 Claude Code 发来的 Anthropic 模型名翻成网关模型名。
//
// 三条规则（按序）：
//  1. 原样带 cn:/global: 前缀 —— 用户在 Claude Code 里直接选了网关模型
//     （靠 CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 从 /v1/models 发现），原样透传；
//  2. 命中静态家族表 —— 转换；
//  3. 都没命中且以 claude- 开头 —— 回落到 default（cn:space-bunny）。
//
// 绝不返回空串：调用方据此报 400。
func messagesModel(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "cn:space-bunny"
	}
	if strings.HasPrefix(name, "cn:") || strings.HasPrefix(name, "global:") {
		return name
	}
	lower := strings.ToLower(name)
	for _, f := range messagesModelFamilies {
		if strings.HasPrefix(lower, f.Prefix) {
			return f.Model
		}
	}
	// 家族表按前缀长度倒序匹配会更精确，但当前表内前缀互不为前缀，顺序无关。
	return "cn:space-bunny"
}

// messagesIsAnthropicStyle 判断一个 id 是否是 Claude Code 会直接发过来的
// Anthropic 风格模型名（用于 /v1/models 的 id 合成，见 handler 侧 claudeFacingIDs）。
func messagesIsAnthropicStyle(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	if strings.HasPrefix(n, "cn:") || strings.HasPrefix(n, "global:") {
		return false
	}
	return strings.HasPrefix(n, "claude-")
}

/* ------------------------------------------------------------------ */
/* 请求翻译：Messages -> Chat Completions                               */
/* ------------------------------------------------------------------ */

// messagesPartToChat 把 Anthropic content part 翻译成 chat 的 content part。
// 返回 nil 表示该 part 无法表达（丢弃）。
func messagesPartToChat(part any) map[string]any {
	m := messagesMap(part)
	if m == nil {
		if s, ok := part.(string); ok {
			return map[string]any{"type": "text", "text": s}
		}
		return nil
	}
	switch messagesStr(m["type"]) {
	case "text":
		return map[string]any{"type": "text", "text": messagesStr(m["text"])}
	case "image":
		src := messagesMap(m["source"])
		if src == nil {
			return nil
		}
		var url string
		switch messagesStr(src["type"]) {
		case "base64":
			media := messagesStr(src["media_type"])
			data := messagesStr(src["data"])
			if data == "" {
				return nil
			}
			if media == "" {
				media = "image/png"
			}
			url = "data:" + media + ";base64," + data
		case "url":
			url = messagesStr(src["url"])
		}
		if url == "" {
			return nil
		}
		return map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}}
	case "document":
		// Anthropic 的 document（PDF/文本）转成纯文本 part：取 source.text，
		// 或 base64 原文（多数上游不认 document part，当文本更稳）。
		src := messagesMap(m["source"])
		if src == nil {
			return nil
		}
		if t := messagesStr(src["type"]); t == "text" {
			if s := messagesStr(src["data"]); s != "" {
				return map[string]any{"type": "text", "text": s}
			}
		}
		return nil
	}
	// thinking / redacted_thinking / tool_use / tool_result：不在这里处理
	// （它们是块级语义，由 messagesMessages 按位置分流）。
	return nil
}

// messagesContentToChat 把 Anthropic 的 content（裸字符串或 part 数组）转成
// chat 的 content。单段文本退化成裸字符串（对上游兼容性最好）。
//
// tool_result 块需要特殊处理：它表达的是「工具返回结果」，必须变成
// role=tool 消息而不是文本 part。故本函数返回 (content, toolResults)：
// 调用方把 toolResults 单独追加成 role=tool 消息。
func messagesContentToChat(content any) (any, []map[string]any) {
	if content == nil {
		return "", nil
	}
	if s, ok := content.(string); ok {
		return s, nil
	}
	list, ok := content.([]any)
	if !ok {
		return fmt.Sprint(content), nil
	}
	parts := make([]any, 0, len(list))
	toolResults := make([]map[string]any, 0)
	for _, raw := range list {
		p := messagesMap(raw)
		if p == nil {
			if s, ok := raw.(string); ok {
				parts = append(parts, map[string]any{"type": "text", "text": s})
			}
			continue
		}
		switch messagesStr(p["type"]) {
		case "tool_use":
			// assistant 侧的调用，由 messagesMessages 统一并入 tool_calls。
		case "tool_result":
			id := messagesStr(p["tool_use_id"])
			if id == "" {
				continue
			}
			body, _ := messagesContentToChat(p["content"])
			text := messagesTextOf(body)
			toolResults = append(toolResults, map[string]any{
				"role":         "tool",
				"tool_call_id": id,
				"content":      text,
			})
		default:
			if c := messagesPartToChat(p); c != nil {
				parts = append(parts, c)
			}
		}
	}
	if len(parts) == 0 {
		return "", toolResults
	}
	if len(parts) == 1 {
		if m, ok := parts[0].(map[string]any); ok && messagesStr(m["type"]) == "text" {
			return m["text"], toolResults
		}
	}
	return parts, toolResults
}

// messagesTextOf 把任意 content 形状压成一段纯文本（给 role=tool 用）。
func messagesTextOf(content any) string {
	switch v := content.(type) {
	case nil:
		return ""
	case string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, raw := range v {
			m := messagesMap(raw)
			if m == nil {
				if s, ok := raw.(string); ok {
					out = append(out, s)
				}
				continue
			}
			if t := messagesStr(m["text"]); t != "" {
				out = append(out, t)
			}
		}
		return strings.Join(out, "\n")
	}
	if raw, err := json.Marshal(content); err == nil {
		return string(raw)
	}
	return fmt.Sprint(content)
}

// messagesAppendToolCall 把一条 tool_use 并入 messages：能并入上一条带
// tool_calls 的 assistant 消息就并入（并行调用必须同条），否则新起一条。
func messagesAppendToolCall(msgs []any, id, name, args string) []any {
	entry := map[string]any{
		"id":   id,
		"type": "function",
		"function": map[string]any{
			"name":      name,
			"arguments": args,
		},
	}
	if len(msgs) > 0 {
		if last, ok := msgs[len(msgs)-1].(map[string]any); ok && messagesStr(last["role"]) == "assistant" {
			if prev, ok := last["tool_calls"].([]any); ok {
				last["tool_calls"] = append(prev, entry)
				return msgs
			}
			// 上一条 assistant 是纯文本 + 本条是工具调用：仍并入同一条，
			// 否则上游会看到「assistant 文本」后紧跟「assistant 工具调用」两条
			// 连续 assistant，某些上游会拒。
			if last["tool_calls"] == nil && last["content"] != nil {
				last["tool_calls"] = []any{entry}
				return msgs
			}
		}
	}
	return append(msgs, map[string]any{
		"role":       "assistant",
		"content":    nil,
		"tool_calls": []any{entry},
	})
}

// messagesMessages 把 Anthropic 的 system + messages 翻译成 chat 的 messages。
func messagesMessages(body map[string]any) []any {
	msgs := []any{}

	// 顶层 system：Anthropic 允许 content 是字符串或 block 数组。
	if sys := body["system"]; sys != nil {
		content, _ := messagesContentToChat(sys)
		if text := messagesTextOf(content); text != "" {
			msgs = append(msgs, map[string]any{"role": "system", "content": text})
		}
	}

	list, _ := body["messages"].([]any)
	for _, raw := range list {
		m := messagesMap(raw)
		if m == nil {
			continue
		}
		role := messagesStr(m["role"])
		content, toolResults := messagesContentToChat(m["content"])

		// 工具结果先落（它们在 messages 里排在 user 侧，chat 也是 role=tool）。
		for _, tr := range toolResults {
			msgs = append(msgs, tr)
		}

		// assistant 侧可能带 tool_use 块：并入 tool_calls。
		if calls := messagesToolUses(m["content"]); len(calls) > 0 {
			for _, c := range calls {
				msgs = messagesAppendToolCall(msgs, c.id, c.name, c.args)
			}
			// 若同时有文本（text + tool_use 混合），把文本补进刚并入的那条。
			if text := messagesTextOf(content); text != "" {
				if last, ok := msgs[len(msgs)-1].(map[string]any); ok && messagesStr(last["role"]) == "assistant" {
					if s, _ := last["content"].(string); s == "" {
						last["content"] = text
					}
				}
			}
			continue
		}

		// 注意：图片/文档 part 压不成纯文本（messagesTextOf 会返回空串），
		// 但 content 数组本身非空 —— 此时必须透传 part 数组，
		// 否则纯图片消息会被整条丢掉。
		if text := messagesTextOf(content); text != "" {
			msgs = append(msgs, map[string]any{"role": role, "content": text})
		} else if parts, ok := content.([]any); ok && len(parts) > 0 {
			msgs = append(msgs, map[string]any{"role": role, "content": parts})
		}
	}
	return msgs
}

type messagesToolUse struct {
	id   string
	name string
	args string
}

// messagesToolUses 从一个 message 的 content 里抽出所有 tool_use 块。
func messagesToolUses(content any) []messagesToolUse {
	list, ok := content.([]any)
	if !ok {
		return nil
	}
	out := make([]messagesToolUse, 0)
	for _, raw := range list {
		p := messagesMap(raw)
		if p == nil || messagesStr(p["type"]) != "tool_use" {
			continue
		}
		id := messagesStr(p["id"])
		if id == "" {
			id = newMessagesID("toolu")
		}
		name := messagesStr(p["name"])
		if name == "" {
			continue
		}
		var args string
		switch v := p["input"].(type) {
		case string:
			args = v
		case nil:
			args = "{}"
		default:
			if raw, err := json.Marshal(v); err == nil {
				args = string(raw)
			} else {
				args = "{}"
			}
		}
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		out = append(out, messagesToolUse{id: id, name: name, args: args})
	}
	return out
}

// messagesToolsToChat 把 Anthropic tools 翻译成 chat tools。
// Anthropic tool: {"name":...,"description":...,"input_schema":{...}}
// chat function:  {"type":"function","function":{name,description,parameters}}
func messagesToolsToChat(tools any) []any {
	list, _ := tools.([]any)
	out := make([]any, 0, len(list))
	for _, raw := range list {
		t := messagesMap(raw)
		if t == nil {
			continue
		}
		name := messagesStr(t["name"])
		if name == "" {
			continue
		}
		params := t["input_schema"]
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        name,
				"description": messagesStr(t["description"]),
				"parameters":  params,
			},
		})
	}
	return out
}

// messagesToolChoiceToChat 翻译 tool_choice。
// Anthropic: {"type":"auto"|"any"|"tool","name":...}  或缺省
// chat:       "auto"|"required" 或 {"type":"function","function":{"name":...}}
func messagesToolChoiceToChat(tc any, toolNames map[string]bool) any {
	m := messagesMap(tc)
	if m == nil {
		return nil
	}
	switch messagesStr(m["type"]) {
	case "auto":
		return "auto"
	case "any":
		return "required"
	case "none":
		return "none"
	case "tool":
		name := messagesStr(m["name"])
		if name == "" {
			return "auto"
		}
		if !toolNames[name] {
			return "auto" // 指定了不存在的工具：退让为 auto，避免上游报错
		}
		return map[string]any{"type": "function", "function": map[string]any{"name": name}}
	}
	return "auto"
}

// messagesRequestToChat 把 Anthropic 请求体整体翻译成 chat/completions 请求体。
func messagesRequestToChat(body map[string]any) (map[string]any, string) {
	chat := map[string]any{
		"model":    messagesModel(messagesStr(body["model"])),
		"messages": messagesMessages(body),
	}
	if v, ok := body["stream"].(bool); ok {
		chat["stream"] = v
	} else {
		chat["stream"] = true
	}

	if tools := messagesToolsToChat(body["tools"]); len(tools) > 0 {
		names := make(map[string]bool, len(tools))
		for _, raw := range tools {
			if fn := messagesMap(messagesMap(raw)["function"]); fn != nil {
				names[messagesStr(fn["name"])] = true
			}
		}
		chat["tools"] = tools
		if choice := messagesToolChoiceToChat(body["tool_choice"], names); choice != nil {
			chat["tool_choice"] = choice
		}
	}

	// max_tokens：Anthropic 必填。缺省给一个足够大的值，别让 0 传给上游。
	maxOut := messagesNum(body["max_tokens"])
	if maxOut <= 0 {
		maxOut = 32000
	}
	chat["max_tokens"] = int(maxOut)

	return chat, messagesStr(chat["model"])
}

/* ------------------------------------------------------------------ */
/* 响应翻译：Chat -> Anthropic Messages                                */
/* ------------------------------------------------------------------ */

// messagesUsage 把 chat usage 映射成 Anthropic 形状。
// Anthropic: {"input_tokens":N,"output_tokens":M}（可带 cache_* 字段）
func messagesUsage(u any) map[string]any {
	m := messagesMap(u)
	in := messagesNum(m["prompt_tokens"])
	if in == 0 {
		in = messagesNum(m["input_tokens"])
	}
	outTok := messagesNum(m["completion_tokens"])
	if outTok == 0 {
		outTok = messagesNum(m["output_tokens"])
	}
	res := map[string]any{
		"input_tokens":  int(in),
		"output_tokens": int(outTok),
	}
	if cached := messagesNum(messagesMap(m["prompt_tokens_details"])["cached_tokens"]); cached > 0 {
		res["cache_read_input_tokens"] = int(cached)
	}
	return res
}

// messagesStopReason 把 chat finish_reason 映射成 Anthropic stop_reason。
// Anthropic 取值：end_turn / max_tokens / stop_sequence / tool_use
func messagesStopReason(fr string) string {
	switch fr {
	case "length", "max_tokens":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	case "stop", "end_turn", "eos":
		return "end_turn"
	}
	return "end_turn"
}

// messagesBlocksFromChatMessage 把 chat 的 message（非流式 choices[0].message）
// 转成 Anthropic content blocks。
func messagesBlocksFromChatMessage(msg map[string]any) []any {
	blocks := make([]any, 0, 2)
	text := messagesStr(msg["content"])
	if text == "" && msg["content"] != nil {
		text = messagesTextOf(msg["content"])
	}
	if text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": text})
	}
	calls, _ := msg["tool_calls"].([]any)
	for _, raw := range calls {
		tc := messagesMap(raw)
		if tc == nil {
			continue
		}
		fn := messagesMap(tc["function"])
		name := messagesStr(fn["name"])
		if name == "" {
			name = messagesStr(tc["name"])
		}
		if name == "" {
			continue
		}
		args := messagesStr(fn["arguments"])
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		var input any
		if err := json.Unmarshal([]byte(args), &input); err != nil {
			// 上游偶尔返回非法 JSON：包一层 string，别让整个响应失败。
			input = map[string]any{"_raw": args}
		}
		blocks = append(blocks, map[string]any{
			"type":  "tool_use",
			"id":    messagesStr(tc["id"]),
			"name":  name,
			"input": input,
		})
	}
	if len(blocks) == 0 {
		// Anthropic 允许空 content，但客户端可能显示空白：给一个空 text 更安全。
		blocks = append(blocks, map[string]any{"type": "text", "text": ""})
	}
	return blocks
}

// messagesFirstChoiceMessage 取 choices[0].message（非流式聚合响应）。
func messagesFirstChoiceMessage(resp map[string]any) map[string]any {
	choices, ok := resp["choices"].([]any)
	if !ok || len(choices) == 0 {
		return nil
	}
	return messagesMap(messagesMap(choices[0])["message"])
}

// messagesFirstChoiceFinish 取 choices[0].finish_reason（非流式）。
func messagesFirstChoiceFinish(resp map[string]any) string {
	choices, ok := resp["choices"].([]any)
	if !ok || len(choices) == 0 {
		return ""
	}
	return messagesStr(messagesMap(choices[0])["finish_reason"])
}

/* ------------------------------------------------------------------ */
/* 流式翻译：chat SSE -> Anthropic 事件流                              */
/* ------------------------------------------------------------------ */

// messagesToolCall 是流式 tool_calls 的累积状态（参数分片拼接）。
type messagesToolCall struct {
	ID   string
	Name string
	Args strings.Builder
}

// Anthropic 流式事件序号：从 0 开始，逐事件 +1。
type messagesStream struct {
	w       http.ResponseWriter
	flusher http.Flusher
	id      string
	model   string // 发给客户端的模型名（Anthropic 风格，不是网关名）
	seq     int

	textOpen bool
	text     strings.Builder

	callsOpen  bool
	calls      map[int]*messagesToolCall
	callOrder  []int
	callBlocks map[int]int // tool index -> Anthropic content block index

	usage   any
	finish  string
	stopRsn string
	started bool
	done    bool
	buf     []byte
}

func newMessagesStream(w http.ResponseWriter, fl http.Flusher, id, model string) *messagesStream {
	return &messagesStream{
		w:          w,
		flusher:    fl,
		id:         id,
		model:      model,
		calls:      map[int]*messagesToolCall{},
		callBlocks: map[int]int{},
	}
}

// event 写一帧 Anthropic SSE（event: <type> + data: <payload>），并立即 flush。
func (s *messagesStream) event(typ string, fields map[string]any) {
	payload := make(map[string]any, len(fields)+1)
	payload["type"] = typ
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

// start 发出 message_start（此时 content 为空、usage.input_tokens 先占位）。
func (s *messagesStream) start() {
	s.started = true
	s.event("message_start", map[string]any{
		"message": map[string]any{
			"id":            s.id,
			"type":          "message",
			"role":          "assistant",
			"model":         s.model,
			"content":       []any{},
			"stop_reason":   nil,
			"stop_sequence": nil,
			"usage":         messagesUsage(nil),
		},
	})
}

// feed 累积字节流并按行切分。
func (s *messagesStream) feed(p []byte) {
	s.buf = append(s.buf, p...)
	for {
		i := bytes.IndexByte(s.buf, '\n')
		if i < 0 {
			return
		}
		line := strings.TrimRight(string(s.buf[:i]), "\r")
		n := copy(s.buf, s.buf[i+1:])
		s.buf = s.buf[:n]
		s.line(line)
	}
}

// line 处理一行 SSE：只认 data: 帧。
func (s *messagesStream) line(line string) {
	if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
		return
	}
	data := strings.TrimSpace(line[len("data:"):])
	if data == "" || data == "[DONE]" {
		return
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(data), &obj); err != nil {
		return
	}
	if e, ok := obj["error"].(map[string]any); ok {
		s.event("error", map[string]any{
			"error": map[string]any{
				"type":    messagesStr(e["type"]),
				"message": messagesStr(e["message"]),
			},
		})
		return
	}
	s.chunk(obj)
}

// chunk 处理一个 chat completion chunk。
func (s *messagesStream) chunk(obj map[string]any) {
	if u, ok := obj["usage"]; ok && u != nil {
		s.usage = u
	}
	choices, ok := obj["choices"].([]any)
	if !ok || len(choices) == 0 {
		return
	}
	choice := messagesMap(choices[0])
	if choice == nil {
		return
	}
	if d := messagesMap(choice["delta"]); d != nil {
		s.delta(d)
	}
	if m := messagesMap(choice["message"]); m != nil {
		s.delta(m)
	}
	if fr := messagesStr(choice["finish_reason"]); fr != "" {
		s.finish = fr
		s.stopRsn = messagesStopReason(fr)
	}
}

// openTextBlock 在首个文本 delta 之前开一个 text content block。
func (s *messagesStream) openTextBlock() int {
	if s.textOpen {
		return 0
	}
	s.textOpen = true
	s.event("content_block_start", map[string]any{
		"index":          0,
		"content_block":  map[string]any{"type": "text", "text": ""},
	})
	return 0
}

// openToolBlock 为一个流式 tool_call 开一个 tool_use content block。
// Anthropic 要求 tool_use block 以 input:{} 开始，再用 input_json_delta 累积。
func (s *messagesStream) openToolBlock(toolIdx int) int {
	blk, ok := s.callBlocks[toolIdx]
	if ok {
		return blk
	}
	// text block 在 0；工具块依次排在后面。
	next := 0
	if s.textOpen {
		next = 1
	}
	for _, existing := range s.callBlocks {
		if existing+1 > next {
			next = existing + 1
		}
	}
	s.callBlocks[toolIdx] = next
	call := s.calls[toolIdx]
	if call == nil {
		call = &messagesToolCall{}
		s.calls[toolIdx] = call
	}
	if call.ID == "" {
		call.ID = newMessagesID("toolu")
	}
	s.event("content_block_start", map[string]any{
		"index": next,
		"content_block": map[string]any{
			"type":  "tool_use",
			"id":    call.ID,
			"name":  call.Name,
			"input": map[string]any{},
		},
	})
	return next
}

// delta 处理增量：文本 / 工具调用分片。
func (s *messagesStream) delta(d map[string]any) {
	if text := messagesStr(d["content"]); text != "" {
		idx := s.openTextBlock()
		s.text.WriteString(text)
		s.event("content_block_delta", map[string]any{
			"index": idx,
			"delta": map[string]any{"type": "text_delta", "text": text},
		})
	}
	calls, ok := d["tool_calls"].([]any)
	if !ok {
		return
	}
	for _, raw := range calls {
		tc := messagesMap(raw)
		if tc == nil {
			continue
		}
		idx := len(s.calls)
		if v, ok := tc["index"]; ok {
			idx = int(messagesNum(v))
		}
		entry := s.calls[idx]
		if entry == nil {
			entry = &messagesToolCall{}
			s.calls[idx] = entry
			s.callOrder = append(s.callOrder, idx)
		}
		if id := messagesStr(tc["id"]); id != "" {
			entry.ID = id
		}
		fn := messagesMap(tc["function"])
		if name := messagesStr(fn["name"]); name != "" {
			switch {
			case entry.Name == "":
				entry.Name = name
			case name != entry.Name && !strings.HasSuffix(entry.Name, name):
				entry.Name += name
			}
		}
		if args := messagesStr(fn["arguments"]); args != "" {
			blk := s.openToolBlock(idx)
			entry.Args.WriteString(args)
			s.event("content_block_delta", map[string]any{
				"index": blk,
				"delta": map[string]any{"type": "input_json_delta", "partial_json": args},
			})
		}
	}
}

// finalize 收尾：关掉所有开着的 block，再发 message_delta + message_stop。
// 幂等。
func (s *messagesStream) finalize() {
	if s.done {
		return
	}
	s.done = true
	if !s.started {
		// 上游一个数据帧都没给：至少把 message_start/message_stop 补齐，
		// 否则客户端挂在"流没结束"上。
		s.start()
	}

	if s.textOpen {
		s.event("content_block_stop", map[string]any{"index": 0})
	}
	keys := make([]int, 0, len(s.callBlocks))
	for k := range s.callBlocks {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	for _, toolIdx := range keys {
		s.event("content_block_stop", map[string]any{"index": s.callBlocks[toolIdx]})
	}

	stop := s.stopRsn
	if stop == "" {
		// 没收到 finish_reason：若开了工具块就是 tool_use，否则 end_turn。
		if len(s.callBlocks) > 0 {
			stop = "tool_use"
		} else {
			stop = "end_turn"
		}
	}
	s.event("message_delta", map[string]any{
		"delta": map[string]any{
			"stop_reason":   stop,
			"stop_sequence": nil,
		},
		"usage": messagesUsage(s.usage),
	})
	s.event("message_stop", map[string]any{})
}

/* ------------------------------------------------------------------ */
/* HTTP 层                                                             */
/* ------------------------------------------------------------------ */

// messagesWriter 是交给内部 chatCompletions 的「翻译型 ResponseWriter」。
//
// 三条路径（与 responsesWriter 同构）：
//   - chat 写 text/event-stream（流式）→ 起 messagesStream，逐帧翻译 + flush；
//   - chat 写 application/json（非流式成功）→ 缓冲，结束后整体转成 Message；
//   - chat 写非 200（调度/上游错误）→ 翻译成 Anthropic 错误形状后透出。
type messagesWriter struct {
	real    http.ResponseWriter
	flusher http.Flusher
	model   string // 发给客户端的模型名（Anthropic 风格）
	id      string

	hdr         http.Header
	status      int
	wroteHeader bool

	stream      *messagesStream
	started     bool
	jsonBuf     bytes.Buffer
	passthrough bool
	done        bool
}

func newMessagesWriter(w http.ResponseWriter, model string) *messagesWriter {
	fl, _ := w.(http.Flusher)
	return &messagesWriter{
		real: w,
		// 客户端听的是 Anthropic 事件流，但真实发出去的模型名是网关模型；
		// 这里用 Anthropic 风格名（modelEcho）回显，避免客户端做目录校验。
		flusher: fl,
		model:   model,
		id:      newMessagesID("msg"),
		hdr:     http.Header{},
	}
}

func (s *messagesWriter) Header() http.Header { return s.hdr }

func (s *messagesWriter) WriteHeader(code int) {
	if s.wroteHeader {
		return
	}
	s.wroteHeader = true
	s.status = code
	if code == http.StatusOK {
		return
	}
	// 非 200：把 chat 的 OpenAI 形状错误翻成 Anthropic 形状后再透出。
	s.passthrough = true
	dst := s.real.Header()
	for k, vv := range s.hdr {
		dst[k] = vv
	}
	s.real.WriteHeader(code)
}

func (s *messagesWriter) Write(p []byte) (int, error) {
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

func (s *messagesWriter) Flush() {
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

// startStream 切换到 Anthropic 事件流：设定客户端可见的头，再发 message_start。
func (s *messagesWriter) startStream() {
	s.started = true
	dst := s.real.Header()
	dst.Set("Content-Type", "text/event-stream; charset=utf-8")
	dst.Set("Cache-Control", "no-cache, no-transform")
	dst.Set("Connection", "keep-alive")
	dst.Set("X-Accel-Buffering", "no")
	// Anthropic SDK 会读这两个头做请求识别；缺了不影响，但给了更规范。
	dst.Set("anthropic-version", "2023-06-01")
	s.real.WriteHeader(http.StatusOK)
	s.stream = newMessagesStream(s.real, s.flusher, s.id, s.model)
	s.stream.start()
}

// writeAnthropicError 按 Anthropic 错误形状输出。
func writeAnthropicError(w http.ResponseWriter, status int, errType, msg string) {
	writeJSON(w, status, map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    errType,
			"message": msg,
		},
	})
}

// messagesErrorType 把 OpenAI 风格 error.type 映射到 Anthropic 的 error.type。
// Anthropic 认识的取值：invalid_request_error / authentication_error /
// permission_error / not_found_error / rate_limit_error / api_error /
// overloaded_error。
func messagesErrorType(openAIType string, status int) string {
	switch openAIType {
	case "invalid_request_error", "invalid_request":
		return "invalid_request_error"
	case "authentication_error":
		return "authentication_error"
	case "permission_error":
		return "permission_error"
	case "not_found_error":
		return "not_found_error"
	case "rate_limit_error", "rate_limit_exceeded":
		return "rate_limit_error"
	case "overloaded_error":
		return "overloaded_error"
	}
	switch {
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status == http.StatusUnauthorized:
		return "authentication_error"
	case status == http.StatusNotFound:
		return "not_found_error"
	case status == http.StatusBadRequest:
		return "invalid_request_error"
	}
	return "api_error"
}

// finish 在内部 chat 调用返回后调用。
func (s *messagesWriter) finish() {
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
			writeAnthropicError(s.real, http.StatusBadGateway, "api_error",
				"upstream returned invalid JSON: "+err.Error())
			return
		}
		blocks := messagesBlocksFromChatMessage(messagesFirstChoiceMessage(chatResp))
		stop := messagesStopReason(messagesFirstChoiceFinish(chatResp))
		body := map[string]any{
			"id":            s.id,
			"type":          "message",
			"role":          "assistant",
			"model":         s.model,
			"content":       blocks,
			"stop_reason":   stop,
			"stop_sequence": nil,
			"usage":         messagesUsage(chatResp["usage"]),
		}
		raw, err := json.Marshal(body)
		if err != nil {
			writeAnthropicError(s.real, http.StatusBadGateway, "api_error", err.Error())
			return
		}
		s.real.Header().Set("Content-Type", "application/json")
		s.real.WriteHeader(http.StatusOK)
		_, _ = s.real.Write(raw)
		return
	}

	writeAnthropicError(s.real, http.StatusServiceUnavailable, "overloaded_error",
		"all accounts are temporarily unavailable, please retry later")
}

// messages 是 POST /v1/messages 的入口：翻译请求 -> 复用 chat 链路 -> 翻译响应。
func (h *Handler) messages(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "read body: "+err.Error())
		return
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON body: "+err.Error())
		return
	}
	chat, model := messagesRequestToChat(body)
	if msgs, _ := chat["messages"].([]any); len(msgs) == 0 {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "no messages after conversion")
		return
	}
	chatRaw, err := json.Marshal(chat)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "encode chat request: "+err.Error())
		return
	}

	// 回显给客户端的模型名：用客户端发来的原名（Anthropic 风格），
	// 而非网关名 —— Claude Code 会拿它跟自己的目录比对。
	echoModel := messagesStr(body["model"])
	if echoModel == "" {
		echoModel = model
	}

	// 复用 chat 链路：只换 body 与 URL（URL 仅为语义标识，此处直调 handler 不重路由），
	// 其余（鉴权已完成、requestTrace 挂在 context 上）原样带着走。
	sub := r.Clone(r.Context())
	sub.Body = io.NopCloser(bytes.NewReader(chatRaw))
	sub.ContentLength = int64(len(chatRaw))
	sub.URL.Path = "/v1/chat/completions"

	shim := newMessagesWriter(w, echoModel)
	defer shim.finish()
	h.chatCompletions(shim, sub)
}







