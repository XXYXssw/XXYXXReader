package server

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"xxyxx-reader/internal/ai"
	"xxyxx-reader/internal/book"
	"xxyxx-reader/internal/config"
	"xxyxx-reader/internal/db"
	"xxyxx-reader/internal/model"
	"xxyxx-reader/internal/opds"
	"xxyxx-reader/internal/obsidian"
	"xxyxx-reader/internal/scanner"
	"xxyxx-reader/web"
)

// Server 封装 HTTP 路由与核心业务依赖
type Server struct {
	cfg     *config.Config
	store   *db.Store
	scanner *scanner.Scanner
	aiSvc   *ai.Service
	opds    *opds.Handler
	mux     *http.ServeMux
}

// New 创建并初始化 HTTP 服务
func New(cfg *config.Config, store *db.Store, sc *scanner.Scanner) *Server {
	s := &Server{
		cfg:     cfg,
		store:   store,
		scanner: sc,
		aiSvc:   ai.NewService(cfg, store),
		opds:    opds.NewHandler(store),
		mux:     http.NewServeMux(),
	}
	s.routes()
	return s
}

// Handler 返回带基础日志与 CORS 头的 http.Handler
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) routes() {
	// 健康检查与配置查询（同时兼容 /health, /api/health 与 /api/config）
	s.mux.HandleFunc("/health", s.handleHealth)
	s.mux.HandleFunc("/api/health", s.handleHealth)
	s.mux.HandleFunc("/api/config", s.handleHealth)

	// 全局用户设置与 AI 配置端点（全量保存在 SQLite app_settings，前端零 localStorage）
	s.mux.HandleFunc("/api/settings", s.handleSettings)
	s.mux.HandleFunc("/api/ai/models", s.handleAIModels)

	// 手动触发书库扫描
	s.mux.HandleFunc("/api/library/scan", s.handleLibraryScan)
	s.mux.HandleFunc("/api/books/scan", s.handleLibraryScan)

	// 分类管理 API
	s.mux.HandleFunc("/api/categories", s.handleCategories)
	s.mux.HandleFunc("/api/categories/", s.handleCategoryByID)

	// 书籍列表、上传与单项操作 API
	s.mux.HandleFunc("/api/books", s.handleBooks)
	s.mux.HandleFunc("/api/books/upload", s.handleBookUpload)
	s.mux.HandleFunc("/api/books/", s.handleBookSubroutes)

	// 批注删除 API
	s.mux.HandleFunc("/api/annotations/", s.handleAnnotationByID)

	// AI 会话单项管理 API
	s.mux.HandleFunc("/api/ai/sessions/", s.handleAISessionByID)

	// OPDS 1.2 协议端点
	s.mux.HandleFunc("/opds", s.opds.ServeRoot)
	s.mux.HandleFunc("/opds/books", s.opds.ServeBooks)

	// 静态前端资源 (web/dist)
	distSub, err := fs.Sub(web.DistFS, "dist")
	if err != nil {
		log.Fatalf("failed to load embedded web/dist: %v", err)
	}
	fileServer := http.FileServer(http.FS(distSub))
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/reader" {
			r.URL.Path = "/reader.html"
		}
		if strings.HasSuffix(r.URL.Path, ".js") || strings.HasSuffix(r.URL.Path, ".html") || strings.HasSuffix(r.URL.Path, ".css") {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			w.Header().Set("Pragma", "no-cache")
			w.Header().Set("Expires", "0")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "ok",
		"service":     "xxyxx-reader",
		"title":       "XXYXXReader v2 · 阅境",
		"port":        s.cfg.Port,
		"library_dir": s.cfg.LibraryDir,
		"db_path":     s.cfg.DBPath,
		"timestamp":   time.Now().Format(time.RFC3339),
	})
}

// ==================== 全局设置与 AI 模型探测 API ====================

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := s.store.GetAllSettings()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, settings)

	case http.MethodPost, http.MethodPut:
		var updates map[string]any
		if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		if err := s.store.SaveSettings(updates); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		settings, _ := s.store.GetAllSettings()
		writeJSON(w, http.StatusOK, settings)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAIModels(w http.ResponseWriter, r *http.Request) {
	apiURL := r.URL.Query().Get("api_url")
	apiKey := r.URL.Query().Get("api_key")
	if r.Method == http.MethodPost {
		var body struct {
			APIURL string `json:"api_url"`
			APIKey string `json:"api_key"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.APIURL != "" {
			apiURL = body.APIURL
		}
		if body.APIKey != "" {
			apiKey = body.APIKey
		}
	}
	models, err := s.aiSvc.ListModels(r.Context(), apiURL, apiKey)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"models": models,
	})
}

func (s *Server) handleLibraryScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	count, err := s.scanner.ScanAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"message":       "书库同步扫描完成",
		"scanned_count": count,
	})
}

// ==================== 分类路由处理 ====================

func (s *Server) handleCategories(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cats, err := s.store.ListCategories()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, cats)

	case http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		cat, err := s.scanner.CreateCategoryWithDir(body.Name)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, cat)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleCategoryByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/categories/")
	id = strings.Trim(id, "/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing category id")
		return
	}

	switch r.Method {
	case http.MethodPut:
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		if err := s.scanner.RenameCategoryWithDir(id, body.Name); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "分类已重命名并同步本地目录"})

	case http.MethodDelete:
		if err := s.scanner.DeleteCategoryWithDir(id); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "分类已删除，藏书已安全移至未分类"})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// ==================== 书籍与 AI 子路由处理 ====================

func (s *Server) handleBooks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	catID := r.URL.Query().Get("category_id")
	q := r.URL.Query().Get("q")
	sortBy := r.URL.Query().Get("sort")

	books, err := s.store.ListBooks(catID, q, sortBy)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, books)
}

func (s *Server) handleBookUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := r.ParseMultipartForm(256 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "解析上传表单失败: "+err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "未找到上传文件字段 file")
		return
	}
	defer file.Close()

	fileName := filepath.Base(header.Filename)
	if _, ok := book.IsSupportedFile(fileName); !ok {
		writeError(w, http.StatusBadRequest, "不支持的文件格式，仅支持 EPUB, AZW3, MOBI, MD, TXT")
		return
	}

	categoryID := strings.TrimSpace(r.FormValue("category_id"))
	libAbs, err := filepath.Abs(s.cfg.LibraryDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	targetDir := libAbs
	if categoryID != "" && categoryID != "all" && categoryID != "__uncategorized__" {
		if cat, err := s.store.GetCategory(categoryID); err == nil && cat != nil {
			targetDir = filepath.Join(libAbs, cat.Name)
			_ = os.MkdirAll(targetDir, 0755)
		}
	}

	destPath := filepath.Join(targetDir, fileName)
	tmpPath := destPath + ".uploading"
	out, err := os.Create(tmpPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	_, copyErr := io.Copy(out, file)
	_ = out.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		writeError(w, http.StatusInternalServerError, copyErr.Error())
		return
	}
	if err := os.Rename(tmpPath, destPath); err != nil {
		_ = os.Remove(tmpPath)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	_, _ = s.scanner.ScanAll()
	uploaded, _ := s.store.GetBookByPath(destPath)
	writeJSON(w, http.StatusCreated, map[string]any{
		"message": "书籍已入阁",
		"book":    uploaded,
	})
}

func (s *Server) handleBookSubroutes(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/api/books/")
	parts := strings.Split(strings.Trim(rel, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "missing book id")
		return
	}
	bookID := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	switch action {
	case "":
		s.handleBookItem(w, r, bookID)
	case "category":
		s.handleBookCategory(w, r, bookID)
	case "content":
		s.handleBookContent(w, r, bookID)
	case "download":
		s.handleBookDownload(w, r, bookID)
	case "cover":
		s.handleBookCover(w, r, bookID)
	case "progress":
		s.handleBookProgress(w, r, bookID)
	case "annotations":
		s.handleBookAnnotations(w, r, bookID)
	case "notes":
		s.handleBookNotesExport(w, r, bookID)
	case "ai":
		subAction := ""
		if len(parts) > 2 {
			subAction = parts[2]
		}
		s.handleBookAI(w, r, bookID, subAction)
	default:
		writeError(w, http.StatusNotFound, "unknown book endpoint")
	}
}

func (s *Server) handleBookAI(w http.ResponseWriter, r *http.Request, bookID, subAction string) {
	switch subAction {
	case "sessions":
		switch r.Method {
		case http.MethodGet:
			sessions, err := s.store.ListAISessions(bookID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, sessions)

		case http.MethodPost:
			var body struct {
				Title string `json:"title"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			sess, err := s.store.CreateAISession(bookID, body.Title)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusCreated, sess)

		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}

	case "chat":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req ai.ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		if strings.TrimSpace(req.Message) == "" && (req.Quote == nil || strings.TrimSpace(req.Quote.SelectedText) == "") {
			writeError(w, http.StatusBadRequest, "提问内容不能为空")
			return
		}
		if strings.TrimSpace(req.Message) == "" && req.Quote != nil {
			req.Message = "请结合上下文为我解读并赏析这段文字。"
		}
		resp, err := s.aiSvc.Chat(r.Context(), bookID, req)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, resp)

	default:
		writeError(w, http.StatusNotFound, "unknown book ai endpoint")
	}
}

func (s *Server) handleAISessionByID(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/api/ai/sessions/")
	parts := strings.Split(strings.Trim(rel, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "missing session id")
		return
	}
	sessionID := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}

	if sub == "messages" {
		switch r.Method {
		case http.MethodGet:
			msgs, err := s.store.ListAIMessages(sessionID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, msgs)
		case http.MethodDelete:
			if err := s.store.ClearAISessionMessages(sessionID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"message": "对话记录已清空"})
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}

	switch r.Method {
	case http.MethodDelete:
		if err := s.store.DeleteAISession(sessionID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "对话已删除"})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleBookItem(w http.ResponseWriter, r *http.Request, bookID string) {
	switch r.Method {
	case http.MethodGet:
		b, err := s.store.GetBook(bookID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if b == nil {
			writeError(w, http.StatusNotFound, "book not found")
			return
		}
		writeJSON(w, http.StatusOK, b)

	case http.MethodDelete:
		b, err := s.store.GetBook(bookID)
		if err != nil || b == nil {
			writeError(w, http.StatusNotFound, "book not found")
			return
		}
		if r.URL.Query().Get("keep_file") != "true" {
			_ = os.Remove(b.FilePath)
		}
		_ = os.Remove(filepath.Join(s.cfg.CoversDir, bookID+".jpg"))
		_ = os.Remove(filepath.Join(s.cfg.CacheDir, bookID+".epub"))
		if err := s.store.DeleteBook(bookID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "书籍已移除"})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleBookCategory(w http.ResponseWriter, r *http.Request, bookID string) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		CategoryID string `json:"category_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	updated, err := s.scanner.MoveBookToCategory(bookID, body.CategoryID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"message": "书籍分类与物理路径已同步更新",
		"book":    updated,
	})
}

func (s *Server) handleBookContent(w http.ResponseWriter, r *http.Request, bookID string) {
	b, err := s.store.GetBook(bookID)
	if err != nil || b == nil {
		writeError(w, http.StatusNotFound, "book not found")
		return
	}

	targetPath := b.FilePath
	contentType := "application/epub+zip"

	switch b.FileType {
	case "md", "txt":
		cachedEPUB, err := book.EnsureVirtualEPUB(b.FilePath, b.FileType, b.ID, b.Title, b.Author, s.cfg.CacheDir)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "build virtual epub failed: "+err.Error())
			return
		}
		targetPath = cachedEPUB
		contentType = "application/epub+zip"
	case "azw3":
		contentType = "application/vnd.amazon.ebook"
	case "mobi":
		contentType = "application/x-mobipocket-ebook"
	}

	f, err := os.Open(targetPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "book file missing on disk")
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, filepath.Base(targetPath), info.ModTime(), f)
}

func (s *Server) handleBookDownload(w http.ResponseWriter, r *http.Request, bookID string) {
	b, err := s.store.GetBook(bookID)
	if err != nil || b == nil {
		writeError(w, http.StatusNotFound, "book not found")
		return
	}
	f, err := os.Open(b.FilePath)
	if err != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	fileName := filepath.Base(b.FilePath)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename*=UTF-8''%s", url.PathEscape(fileName)))
	http.ServeContent(w, r, fileName, info.ModTime(), f)
}

func (s *Server) handleBookCover(w http.ResponseWriter, r *http.Request, bookID string) {
	coverPath := filepath.Join(s.cfg.CoversDir, bookID+".jpg")
	if info, err := os.Stat(coverPath); err == nil && info.Size() > 0 {
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.ServeFile(w, r, coverPath)
		return
	}

	b, _ := s.store.GetBook(bookID)
	title := "阅境藏书"
	author := "佚名"
	if b != nil {
		title = b.Title
		author = b.Author
	}
	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write([]byte(renderOrientalCoverSVG(title, author)))
}

func renderOrientalCoverSVG(title, author string) string {
	tRunes := []rune(title)
	if len(tRunes) > 8 {
		tRunes = tRunes[:8]
	}
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420" width="300" height="420">
  <rect width="300" height="420" fill="#dfd8cc"/>
  <rect x="12" y="12" width="276" height="396" fill="none" stroke="#9a8f82" stroke-width="1"/>
  <line x1="42" y1="0" x2="42" y2="420" stroke="#8b6f5c" stroke-width="1.5" stroke-opacity="0.6"/>
  <line x1="0" y1="75" x2="42" y2="75" stroke="#8b6f5c" stroke-width="1.2" stroke-opacity="0.6"/>
  <line x1="0" y1="180" x2="42" y2="180" stroke="#8b6f5c" stroke-width="1.2" stroke-opacity="0.6"/>
  <line x1="0" y1="240" x2="42" y2="240" stroke="#8b6f5c" stroke-width="1.2" stroke-opacity="0.6"/>
  <line x1="0" y1="345" x2="42" y2="345" stroke="#8b6f5c" stroke-width="1.2" stroke-opacity="0.6"/>
  <rect x="208" y="42" width="54" height="240" fill="#f4f0e9" stroke="#8b6f5c" stroke-width="1.5"/>
  <rect x="212" y="46" width="46" height="232" fill="none" stroke="#c4b8a8" stroke-width="0.8"/>
  <text x="235" y="72" font-family="Songti SC, STSong, SimSun, serif" font-size="20" fill="#2c2824" writing-mode="tb" glyph-orientation-vertical="0" letter-spacing="4">%s</text>
  <text x="86" y="372" font-family="Songti SC, STSong, SimSun, serif" font-size="13" fill="#6b6358">%s 著</text>
</svg>`, html.EscapeString(string(tRunes)), html.EscapeString(author))
}

func (s *Server) handleBookProgress(w http.ResponseWriter, r *http.Request, bookID string) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var payload model.ProgressUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := s.store.UpdateBookProgress(bookID, payload); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "进度已更新"})
}

// handleBookNotesExport 导出指定书籍的全部划线批注为 Obsidian 兼容的 Markdown 文件
// GET /api/books/{id}/notes            -> 以附件形式下载 .md
// GET /api/books/{id}/notes?format=md  -> 同上
// GET /api/books/{id}/notes?inline=1   -> 直接返回 text/markdown 文本（供预览或前端处理）
func (s *Server) handleBookNotesExport(w http.ResponseWriter, r *http.Request, bookID string) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	b, err := s.store.GetBook(bookID)
	if err != nil || b == nil {
		writeError(w, http.StatusNotFound, "未找到该藏书")
		return
	}
	anns, err := s.store.ListAnnotations(bookID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	md := obsidian.RenderMarkdown(b, anns, "")

	if r.URL.Query().Get("inline") == "1" {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write([]byte(md))
		return
	}

	fileName := fmt.Sprintf("《%s》.md", obsidian.SanitizeNoteFileName(b.Title))
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", contentDispositionAttachment(fileName))
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(md))
}

// contentDispositionAttachment 构造兼容非 ASCII 文件名的下载头（RFC 5987）
func contentDispositionAttachment(fileName string) string {
	escaped := url.PathEscape(fileName)
	return fmt.Sprintf("attachment; filename=\"notes.md\"; filename*=UTF-8''%s", escaped)
}

func (s *Server) handleBookAnnotations(w http.ResponseWriter, r *http.Request, bookID string) {
	switch r.Method {
	case http.MethodGet:
		anns, err := s.store.ListAnnotations(bookID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, anns)

	case http.MethodPost:
		var ann model.Annotation
		if err := json.NewDecoder(r.Body).Decode(&ann); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		ann.BookID = bookID
		if strings.TrimSpace(ann.SelectedText) == "" {
			writeError(w, http.StatusBadRequest, "selected_text cannot be empty")
			return
		}
		saved, err := s.store.UpsertAnnotation(&ann)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, saved)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAnnotationByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	annID := strings.TrimPrefix(r.URL.Path, "/api/annotations/")
	annID = strings.Trim(annID, "/")
	if annID == "" {
		writeError(w, http.StatusBadRequest, "missing annotation id")
		return
	}
	if _, err := s.store.DeleteAnnotation(annID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "批注已删除"})
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
