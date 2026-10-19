package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"xxyxx-reader/internal/book"
	"xxyxx-reader/internal/config"
	"xxyxx-reader/internal/db"
	"xxyxx-reader/internal/model"
)

// Service 封装 AI 伴读对话、Tool Calling 引擎与模型探测
type Service struct {
	cfg        *config.Config
	store      *db.Store
	httpClient *http.Client
}

// NewService 创建 AI 服务实例
func NewService(cfg *config.Config, store *db.Store) *Service {
	return &Service{
		cfg:   cfg,
		store: store,
		httpClient: &http.Client{
			Timeout: 90 * time.Second,
		},
	}
}

// ChatRequest 前端发起 AI 对话的请求载荷
// 划线上下文长度不再由用户配置，完全交给 AI 在工具调用时自行决定
// （get_selection_context 的 length 参数）
type ChatRequest struct {
	SessionID         string           `json:"session_id"`
	Message           string           `json:"message"`
	Quote             *model.QuoteMeta `json:"quote,omitempty"`
	CurrentChapterIdx int              `json:"current_chapter_index"`
}

// ChatResponse 返回给前端的本轮对话结果（含用户消息、工具调用记录与 AI 回复）
type ChatResponse struct {
	Session          *model.AISession  `json:"session"`
	UserMessage      *model.AIMessage  `json:"user_message"`
	ToolMessages     []model.AIMessage `json:"tool_messages"`
	AssistantMessage *model.AIMessage  `json:"assistant_message"`
}

// 本服务只对接 OpenAI 兼容协议（OpenAI / Azure OpenAI / 任何 OpenAI 兼容端点）
const defaultOpenAIBaseURL = "https://api.openai.com/v1"

// normalizeChatEndpoint 仅按 OpenAI 协议拼接 /chat/completions
func normalizeChatEndpoint(apiURL string) string {
	u := strings.TrimSpace(strings.TrimRight(apiURL, "/"))
	if u == "" {
		u = defaultOpenAIBaseURL
	}
	if strings.HasSuffix(u, "/chat/completions") {
		return u
	}
	return u + "/chat/completions"
}

// normalizeModelsEndpoint 仅按 OpenAI 协议拼接 /models
func normalizeModelsEndpoint(apiURL string) string {
	u := strings.TrimSpace(strings.TrimRight(apiURL, "/"))
	if u == "" {
		u = defaultOpenAIBaseURL
	}
	u = strings.TrimSuffix(u, "/chat/completions")
	if strings.HasSuffix(u, "/models") {
		return u
	}
	return u + "/models"
}

// ListModels 从配置的 OpenAI 兼容端点拉取可用模型列表
func (s *Service) ListModels(ctx context.Context, apiURL, apiKey string) ([]string, error) {
	aiCfg, _ := s.store.GetAIConfig()
	if strings.TrimSpace(apiURL) == "" {
		apiURL = aiCfg.APIURL
	}
	if strings.TrimSpace(apiKey) == "" {
		apiKey = aiCfg.APIKey
	}

	endpoint := normalizeModelsEndpoint(apiURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	var models []string
	for _, m := range parsed.Data {
		if m.ID != "" {
			models = append(models, m.ID)
		}
	}
	return models, nil
}

// ==================== OpenAI Chat Completions 协议结构 ====================

type oaTool struct {
	Type     string         `json:"type"`
	Function oaToolFunction `json:"function"`
}

type oaToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type oaToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type oaMessage struct {
	Role       string       `json:"role"`
	Content    string       `json:"content,omitempty"`
	ToolCalls  []oaToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
	Name       string       `json:"name,omitempty"`
}

type oaChatRequest struct {
	Model      string      `json:"model"`
	Messages   []oaMessage `json:"messages"`
	Tools      []oaTool    `json:"tools,omitempty"`
	ToolChoice string      `json:"tool_choice,omitempty"`
}

type oaChatResponse struct {
	Choices []struct {
		Message      oaMessage `json:"message"`
		FinishReason string    `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// defaultSelectionContextLength 是 AI 未显式传入 length 时 get_selection_context 的兜底长度，
// 不再暴露为任何用户设置项
const defaultSelectionContextLength = 1200

func buildTools(defaultCtxLen int) []oaTool {
	return []oaTool{
		{
			Type: "function",
			Function: oaToolFunction{
				Name:        "get_selection_context",
				Description: fmt.Sprintf("获取读者当前划线或引用文本在原书章节中的前后文语境。支持通过 length 参数自由调整获取的上下文字符长度（默认 %d 字，范围 100~8000）。", defaultCtxLen),
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"length": map[string]any{
							"type":        "integer",
							"description": fmt.Sprintf("前后文总共提取的字符长度（可调，默认 %d，最小 100，最大 8000）", defaultCtxLen),
						},
						"chapter_index": map[string]any{
							"type":        "integer",
							"description": "划线所在的章节序号 (0-based)，不传则默认使用当前引用或当前阅读章节",
						},
						"selected_text": map[string]any{
							"type":        "integer_or_string",
							"description": "目标划线文本片段，不传则默认使用当前附带的引用文本",
						},
					},
				},
			},
		},
		{
			Type: "function",
			Function: oaToolFunction{
				Name:        "get_book_metadata",
				Description: "获取当前书籍的元信息（书名、作者、简介、所属分卷分类、格式、总章节数、当前阅读进度以及读者已有的划线批注概览）。",
				Parameters: map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
		},
		{
			Type: "function",
			Function: oaToolFunction{
				Name:        "get_book_toc",
				Description: "获取当前书籍的完整目录列表（包含每个章节的 chapter_index、章节标题 title 与字数统计 char_count）。",
				Parameters: map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
		},
		{
			Type: "function",
			Function: oaToolFunction{
				Name:        "get_chapter_text",
				Description: "按章节序号 chapter_index 或章节标题关键词 chapter_query 获取指定章节的正文文本内容，支持分页偏移 offset 与长度 max_length。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"chapter_index": map[string]any{
							"type":        "integer",
							"description": "章节序号 (0-based，可通过 get_book_toc 查询)",
						},
						"chapter_query": map[string]any{
							"type":        "string",
							"description": "章节标题关键词（当未知精确序号时可按标题模糊匹配）",
						},
						"offset": map[string]any{
							"type":        "integer",
							"description": "起始字符偏移量（默认 0）",
						},
						"max_length": map[string]any{
							"type":        "integer",
							"description": "本次读取的最大字符数（默认 3500，最大 10000）",
						},
					},
				},
			},
		},
	}
}

// fix schema type for selected_text in get_selection_context
func init() {}

// Chat 处理一轮完整的 AI 伴读对话（包含 SQLite 历史读取、Tool Calling 循环执行与结果持久化）
func (s *Service) Chat(ctx context.Context, bookID string, req ChatRequest) (*ChatResponse, error) {
	b, err := s.store.GetBook(bookID)
	if err != nil || b == nil {
		return nil, fmt.Errorf("未找到该藏书")
	}

	aiCfg, err := s.store.GetAIConfig()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(aiCfg.APIKey) == "" && !strings.Contains(aiCfg.APIURL, "127.0.0.1") && !strings.Contains(aiCfg.APIURL, "localhost") {
		return nil, fmt.Errorf("尚未配置 AI API Key，请点击 AI 伴读面板右上角「设置」填写 API 地址、Key 与模型")
	}

	// 划线上下文长度完全交由 AI 通过 get_selection_context 的 length 参数决定，
	// 用户侧不再提供该项设置；此处仅作为 AI 未显式传参时的兜底默认值。
	defaultCtxLen := defaultSelectionContextLength

	// 1. 获取或创建会话
	var sess *model.AISession
	if req.SessionID != "" {
		sess, _ = s.store.GetAISession(req.SessionID)
	}
	if sess == nil {
		sessions, _ := s.store.ListAISessions(bookID)
		if len(sessions) > 0 {
			sess = &sessions[0]
		} else {
			sess, err = s.store.CreateAISession(bookID, "伴读研习 #1")
			if err != nil {
				return nil, err
			}
		}
	}

	// 2. 读取已有历史消息，用于构造上下文
	historyMsgs, _ := s.store.ListAIMessages(sess.ID)

	// 3. 落库当前用户消息（带特殊引用块元数据 Quote，前端与数据库均以结构化特殊块存储，不混入大段明文）
	userMsg := &model.AIMessage{
		SessionID: sess.ID,
		BookID:    bookID,
		Role:      "user",
		Content:   strings.TrimSpace(req.Message),
		Quote:     req.Quote,
		Visible:   true,
	}
	if err := s.store.InsertAIMessage(userMsg); err != nil {
		return nil, err
	}

	// 若为会话首条用户提问，自动用问题摘要更新会话标题
	if len(historyMsgs) == 0 || strings.HasPrefix(sess.Title, "伴读研习") || sess.Title == "新伴读对话" {
		summaryTitle := summarizeSessionTitle(userMsg.Content, req.Quote)
		if summaryTitle != "" {
			_ = s.store.UpdateAISessionTitle(sess.ID, summaryTitle)
			sess.Title = summaryTitle
		}
	}

	// 4. 组装发送给大模型的消息序列
	sysContent := fmt.Sprintf(
		"%s\n\n【当前研读书籍】《%s》（作者：%s，格式：%s，当前阅读章节序号：%d，进度：%.1f%%）。\n你随时可以调用工具 get_selection_context(length)、get_book_metadata、get_book_toc、get_chapter_text 来获取原文与上下文。",
		aiCfg.SystemPrompt, b.Title, b.Author, b.FileType, req.CurrentChapterIdx, b.ProgressPercent,
	)

	oaMsgs := []oaMessage{
		{Role: "system", Content: sysContent},
	}

	// 注入最近 16 条对话历史（跳过历史中的内部 tool 消息，保证上下文精炼兼容）
	startIdx := 0
	if len(historyMsgs) > 16 {
		startIdx = len(historyMsgs) - 16
	}
	for _, hm := range historyMsgs[startIdx:] {
		if hm.Role != "user" && hm.Role != "assistant" {
			continue
		}
		oaMsgs = append(oaMsgs, oaMessage{
			Role:    hm.Role,
			Content: formatMessageForLLM(hm.Content, hm.Quote),
		})
	}
	oaMsgs = append(oaMsgs, oaMessage{
		Role:    "user",
		Content: formatMessageForLLM(userMsg.Content, userMsg.Quote),
	})

	tools := buildStandardTools(defaultCtxLen)
	var recordedToolMsgs []model.AIMessage

	// 5. 执行最多 4 轮 Tool Calling 循环
	var finalReply string
	for round := 0; round < 4; round++ {
		respMsg, err := s.callChatCompletions(ctx, aiCfg, oaMsgs, tools)
		if err != nil {
			// 若目标模型不支持 tools 参数，自动降级为无 tools 模式并将划线上下文直接注入
			if round == 0 && len(tools) > 0 && isToolUnsupportedError(err) {
				tools = nil
				if req.Quote != nil && req.Quote.SelectedText != "" {
					ctxRes, _ := book.ExtractSelectionContext(
						b, s.cfg.CacheDir, req.Quote.ChapterIndex, req.Quote.SelectedText, defaultCtxLen, req.Quote.SurroundText,
					)
					if ctxRes != nil {
						oaMsgs[len(oaMsgs)-1].Content += fmt.Sprintf(
							"\n\n[自动附加上下文 (%d字)]\n上文：%s\n选中原文：%s\n下文：%s",
							ctxRes.ContextLength, ctxRes.BeforeContext, ctxRes.SelectedText, ctxRes.AfterContext,
						)
					}
				}
				continue
			}
			return nil, err
		}

		if len(respMsg.ToolCalls) == 0 {
			finalReply = strings.TrimSpace(respMsg.Content)
			break
		}

		oaMsgs = append(oaMsgs, *respMsg)

		for _, tc := range respMsg.ToolCalls {
			toolOut := s.executeTool(b, tc.Function.Name, tc.Function.Arguments, req, defaultCtxLen)

			// 将工具调用与返回结果记录到 SQLite（默认隐藏，前端可一键切换展示）
			tm := model.AIMessage{
				SessionID:     sess.ID,
				BookID:        bookID,
				Role:          "tool",
				Content:       toolOut,
				ToolName:      tc.Function.Name,
				ToolArguments: tc.Function.Arguments,
				Visible:       false,
			}
			_ = s.store.InsertAIMessage(&tm)
			recordedToolMsgs = append(recordedToolMsgs, tm)

			oaMsgs = append(oaMsgs, oaMessage{
				Role:       "tool",
				ToolCallID: tc.ID,
				Name:       tc.Function.Name,
				Content:    toolOut,
			})
		}
	}

	if finalReply == "" {
		finalReply = "（伴读先生已完成查阅，但未返回额外文本）"
	}

	assistantMsg := &model.AIMessage{
		SessionID: sess.ID,
		BookID:    bookID,
		Role:      "assistant",
		Content:   finalReply,
		Visible:   true,
	}
	if err := s.store.InsertAIMessage(assistantMsg); err != nil {
		return nil, err
	}

	return &ChatResponse{
		Session:          sess,
		UserMessage:      userMsg,
		ToolMessages:     recordedToolMsgs,
		AssistantMessage: assistantMsg,
	}, nil
}

func buildStandardTools(defaultCtxLen int) []oaTool {
	t := buildTools(defaultCtxLen)
	props := t[0].Function.Parameters["properties"].(map[string]any)
	props["selected_text"] = map[string]any{
		"type":        "string",
		"description": "目标划线文本片段，不传则默认使用当前附带的引用文本",
	}
	return t
}

func formatMessageForLLM(content string, quote *model.QuoteMeta) string {
	if quote == nil || strings.TrimSpace(quote.SelectedText) == "" {
		return content
	}
	chap := quote.ChapterTitle
	if chap == "" {
		chap = fmt.Sprintf("第 %d 节", quote.ChapterIndex+1)
	}
	return fmt.Sprintf(
		"【读者附带的书中引用块】（章节：%s，章节序号：%d）\n「%s」\n\n【读者提问】\n%s",
		chap, quote.ChapterIndex, quote.SelectedText, content,
	)
}

func summarizeSessionTitle(msg string, quote *model.QuoteMeta) string {
	base := strings.TrimSpace(msg)
	if base == "" && quote != nil {
		base = strings.TrimSpace(quote.SelectedText)
	}
	runes := []rune(base)
	if len(runes) > 14 {
		return string(runes[:14]) + "…"
	}
	return string(runes)
}

func isToolUnsupportedError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "tool") || strings.Contains(msg, "function") || strings.Contains(msg, "not support")
}

func (s *Service) callChatCompletions(ctx context.Context, cfg model.AIConfig, messages []oaMessage, tools []oaTool) (*oaMessage, error) {
	endpoint := normalizeChatEndpoint(cfg.APIURL)
	reqPayload := oaChatRequest{
		Model:    cfg.Model,
		Messages: messages,
	}
	if len(tools) > 0 {
		reqPayload.Tools = tools
		reqPayload.ToolChoice = "auto"
	}

	bodyBytes, err := json.Marshal(reqPayload)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(cfg.APIKey) != "" {
		httpReq.Header.Set("Authorization", "Bearer "+strings.TrimSpace(cfg.APIKey))
	}

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("请求 AI 接口失败: %w", err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("AI 接口返回错误 (HTTP %d): %s", resp.StatusCode, strings.TrimSpace(string(respBytes)))
	}

	var parsed oaChatResponse
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		return nil, fmt.Errorf("解析 AI 响应失败: %w", err)
	}
	if parsed.Error != nil && parsed.Error.Message != "" {
		return nil, fmt.Errorf("AI 接口错误: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("AI 接口未返回有效 choices")
	}
	return &parsed.Choices[0].Message, nil
}

// ==================== 四大 AI 工具具体执行逻辑 ====================

func (s *Service) executeTool(b *model.Book, toolName, rawArgs string, req ChatRequest, defaultCtxLen int) string {
	var args map[string]any
	_ = json.Unmarshal([]byte(rawArgs), &args)
	if args == nil {
		args = map[string]any{}
	}

	switch toolName {
	case "get_selection_context":
		length := defaultCtxLen
		if v, ok := args["length"].(float64); ok && v > 0 {
			length = int(v)
		}
		chapIdx := req.CurrentChapterIdx
		if req.Quote != nil {
			chapIdx = req.Quote.ChapterIndex
		}
		if v, ok := args["chapter_index"].(float64); ok {
			chapIdx = int(v)
		}
		selText := ""
		if req.Quote != nil {
			selText = req.Quote.SelectedText
		}
		if v, ok := args["selected_text"].(string); ok && strings.TrimSpace(v) != "" {
			selText = v
		}
		fallbackSurround := ""
		if req.Quote != nil {
			fallbackSurround = req.Quote.SurroundText
		}
		res, err := book.ExtractSelectionContext(b, s.cfg.CacheDir, chapIdx, selText, length, fallbackSurround)
		if err != nil {
			return toJSON(map[string]any{"error": err.Error()})
		}
		return toJSON(res)

	case "get_book_metadata":
		chapters, _ := book.ExtractBookChapters(b, s.cfg.CacheDir)
		anns, _ := s.store.ListAnnotations(b.ID)
		recentAnns := anns
		if len(recentAnns) > 10 {
			recentAnns = recentAnns[len(recentAnns)-10:]
		}
		return toJSON(map[string]any{
			"book_id":           b.ID,
			"title":             b.Title,
			"author":            b.Author,
			"description":       b.Description,
			"category_name":     b.CategoryName,
			"file_type":         b.FileType,
			"total_chapters":    len(chapters),
			"progress_percent":  b.ProgressPercent,
			"progress_label":    b.ProgressLabel,
			"annotation_count":  len(anns),
			"recent_highlights": recentAnns,
		})

	case "get_book_toc":
		chapters, err := book.ExtractBookChapters(b, s.cfg.CacheDir)
		if err != nil {
			return toJSON(map[string]any{"error": err.Error()})
		}
		type tocEntry struct {
			ChapterIndex int    `json:"chapter_index"`
			Title        string `json:"title"`
			CharCount    int    `json:"char_count"`
		}
		toc := make([]tocEntry, 0, len(chapters))
		for _, ch := range chapters {
			toc = append(toc, tocEntry{
				ChapterIndex: ch.Index,
				Title:        ch.Title,
				CharCount:    ch.CharCount,
			})
		}
		return toJSON(map[string]any{
			"book_title":     b.Title,
			"total_chapters": len(toc),
			"toc":            toc,
		})

	case "get_chapter_text":
		chapters, err := book.ExtractBookChapters(b, s.cfg.CacheDir)
		if err != nil || len(chapters) == 0 {
			return toJSON(map[string]any{"error": "无法读取书籍章节内容"})
		}

		targetIdx := -1
		if v, ok := args["chapter_index"].(float64); ok {
			targetIdx = int(v)
		}
		if query, ok := args["chapter_query"].(string); ok && strings.TrimSpace(query) != "" && targetIdx < 0 {
			q := strings.ToLower(strings.TrimSpace(query))
			for _, ch := range chapters {
				if strings.Contains(strings.ToLower(ch.Title), q) {
					targetIdx = ch.Index
					break
				}
			}
		}
		if targetIdx < 0 {
			targetIdx = req.CurrentChapterIdx
		}
		if targetIdx < 0 || targetIdx >= len(chapters) {
			targetIdx = 0
		}

		ch := chapters[targetIdx]
		runes := []rune(ch.Text)
		offset := 0
		if v, ok := args["offset"].(float64); ok && v > 0 {
			offset = int(v)
		}
		if offset > len(runes) {
			offset = len(runes)
		}
		maxLen := 3500
		if v, ok := args["max_length"].(float64); ok && v > 0 {
			maxLen = int(v)
		}
		if maxLen > 10000 {
			maxLen = 10000
		}
		end := offset + maxLen
		if end > len(runes) {
			end = len(runes)
		}
		return toJSON(map[string]any{
			"chapter_index": targetIdx,
			"chapter_title": ch.Title,
			"total_chars":   len(runes),
			"offset":        offset,
			"returned_len":  end - offset,
			"has_more":      end < len(runes),
			"text":          string(runes[offset:end]),
		})

	default:
		return toJSON(map[string]any{"error": "unknown tool: " + toolName})
	}
}

func toJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}
