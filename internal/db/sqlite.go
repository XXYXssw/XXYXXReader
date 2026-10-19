package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
	"xxyxx-reader/internal/model"
)

// Store 封装单一 SQLite 数据库访问（包含分类、书籍、划线批注、全局设置与 AI 对话历史）
type Store struct {
	db *sql.DB
}

// NewID 生成带前缀的唯一短 ID
func NewID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(b))
}

// Open 打开并初始化 SQLite 数据库，配置 WAL 与外键约束
func Open(dbPath string) (*Store, error) {
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	pragmas := []string{
		"PRAGMA journal_mode = WAL;",
		"PRAGMA synchronous = NORMAL;",
		"PRAGMA foreign_keys = ON;",
		"PRAGMA busy_timeout = 5000;",
	}
	for _, p := range pragmas {
		if _, err := sqlDB.Exec(p); err != nil {
			_ = sqlDB.Close()
			return nil, fmt.Errorf("exec pragma %s: %w", p, err)
		}
	}

	s := &Store{db: sqlDB}
	if err := s.migrate(); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return s, nil
}

// Close 关闭数据库连接
func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	schema := `
CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    file_path TEXT UNIQUE NOT NULL,
    file_hash TEXT NOT NULL DEFAULT '',
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    cover_url TEXT NOT NULL DEFAULT '',
    category_id TEXT NOT NULL DEFAULT '',
    progress_percent REAL NOT NULL DEFAULT 0.0,
    progress_cfi TEXT NOT NULL DEFAULT '',
    progress_label TEXT NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    last_read_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_books_category_id ON books(category_id);
CREATE INDEX IF NOT EXISTS idx_books_file_hash ON books(file_hash);
CREATE INDEX IF NOT EXISTS idx_books_updated_at ON books(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_last_read_at ON books(last_read_at DESC);

CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    cfi TEXT NOT NULL,
    selected_text TEXT NOT NULL,
    prefix_text TEXT NOT NULL DEFAULT '',
    suffix_text TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'zhusha',
    chapter_title TEXT NOT NULL DEFAULT '',
    chapter_index INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_annotations_book_id ON annotations(book_id);

-- 全局与阅读器/AI 配置表（替代前端 localStorage，全量存储在服务端 SQLite）
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME NOT NULL
);

-- AI 伴读会话表
CREATE TABLE IF NOT EXISTS ai_sessions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '新对话',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_book_id ON ai_sessions(book_id, updated_at DESC);

-- AI 伴读消息历史表（支持特殊引用块 JSON 与 Tool Call 记录）
CREATE TABLE IF NOT EXISTS ai_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    quote_json TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL DEFAULT '',
    tool_arguments TEXT NOT NULL DEFAULT '',
    visible INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    FOREIGN KEY(session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_session_id ON ai_messages(session_id, created_at ASC);
`
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	alterStatements := []string{
		"ALTER TABLE books ADD COLUMN file_hash TEXT NOT NULL DEFAULT '';",
		"ALTER TABLE annotations ADD COLUMN prefix_text TEXT NOT NULL DEFAULT '';",
		"ALTER TABLE annotations ADD COLUMN suffix_text TEXT NOT NULL DEFAULT '';",
		"ALTER TABLE annotations ADD COLUMN chapter_title TEXT NOT NULL DEFAULT '';",
		"ALTER TABLE annotations ADD COLUMN chapter_index INTEGER NOT NULL DEFAULT 0;",
	}
	for _, stmt := range alterStatements {
		_, _ = s.db.Exec(stmt)
	}
	return nil
}

// ==================== 全局设置与 AI 配置 (app_settings) ====================

const DefaultAISystemPrompt = `你是「阅境」书斋的博学伴读先生。你拥有调用工具查阅本书元信息、完整目录、指定章节正文以及划线处前后文语境的能力。
当读者附上书中引用片段或针对书中内容提问时：
1. 若引用片段较短或需要结合上下文理解人物关系、前后伏笔，请主动调用 get_selection_context 工具获取前后文；
2. 若读者询问全书结构、某章节内容或跨章对比，请调用 get_book_toc 或 get_chapter_text 工具核实原文；
3. 请以温润雅致、条理清晰的中文作答，紧扣原书文本，切勿凭空臆造。`

// GetAllSettings 获取服务端保存的全部前端与 AI 配置
func (s *Store) GetAllSettings() (map[string]any, error) {
	rows, err := s.db.Query(`SELECT key, value FROM app_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := map[string]any{
		"theme":      "rice-paper",
		"shelf_view": "grid",
		"reader_settings": map[string]any{
			"flipMode":   "instant_tap",
			"fontSize":   19,
			"fontFamily": "serif",
			"lineHeight": 1.8,
			"margin":     6,
			"marginUnit": "percent",
			"indent":     true,
			"justify":    true,
		},
		"custom_keys": map[string]any{
			"next": []string{},
			"prev": []string{},
		},
		"ai_config": model.AIConfig{
			APIURL:               "https://api.openai.com/v1",
			APIKey:               "",
			Model:                "gpt-4o-mini",
			SystemPrompt:         DefaultAISystemPrompt,
			DefaultContextLength: 1200,
		},
	}

	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		var parsed any
		if err := json.Unmarshal([]byte(v), &parsed); err == nil {
			result[k] = parsed
		} else {
			result[k] = v
		}
	}
	return result, rows.Err()
}

// SaveSettings 批量保存配置项至 app_settings 表
func (s *Store) SaveSettings(updates map[string]any) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now()
	for k, v := range updates {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.Exec(`
INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			k, string(b), now,
		)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetAIConfig 读取当前 AI 配置
func (s *Store) GetAIConfig() (model.AIConfig, error) {
	cfg := model.AIConfig{
		APIURL:               "https://api.openai.com/v1",
		APIKey:               "",
		Model:                "gpt-4o-mini",
		SystemPrompt:         DefaultAISystemPrompt,
		DefaultContextLength: 1200,
	}
	var raw string
	err := s.db.QueryRow(`SELECT value FROM app_settings WHERE key = 'ai_config'`).Scan(&raw)
	if err == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &cfg)
	}
	if strings.TrimSpace(cfg.APIURL) == "" {
		cfg.APIURL = "https://api.openai.com/v1"
	}
	if strings.TrimSpace(cfg.Model) == "" {
		cfg.Model = "gpt-4o-mini"
	}
	if strings.TrimSpace(cfg.SystemPrompt) == "" {
		cfg.SystemPrompt = DefaultAISystemPrompt
	}
	if cfg.DefaultContextLength <= 0 {
		cfg.DefaultContextLength = 1200
	}
	return cfg, nil
}

// ==================== AI 会话与历史消息管理 ====================

// ListAISessions 获取某本书的所有 AI 会话列表（若无会话则自动创建一个默认会话）
func (s *Store) ListAISessions(bookID string) ([]model.AISession, error) {
	rows, err := s.db.Query(`
SELECT id, book_id, title, created_at, updated_at
FROM ai_sessions
WHERE book_id = ?
ORDER BY updated_at DESC`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []model.AISession
	for rows.Next() {
		var sess model.AISession
		if err := rows.Scan(&sess.ID, &sess.BookID, &sess.Title, &sess.CreatedAt, &sess.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, sess)
	}
	if len(list) == 0 {
		created, err := s.CreateAISession(bookID, "伴读研习 #1")
		if err != nil {
			return []model.AISession{}, nil
		}
		return []model.AISession{*created}, nil
	}
	return list, rows.Err()
}

// CreateAISession 创建新的 AI 对话会话
func (s *Store) CreateAISession(bookID, title string) (*model.AISession, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "新伴读对话"
	}
	now := time.Now()
	sess := &model.AISession{
		ID:        NewID("sess"),
		BookID:    bookID,
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_, err := s.db.Exec(`
INSERT INTO ai_sessions (id, book_id, title, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)`,
		sess.ID, sess.BookID, sess.Title, sess.CreatedAt, sess.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return sess, nil
}

// GetAISession 获取指定会话
func (s *Store) GetAISession(sessionID string) (*model.AISession, error) {
	var sess model.AISession
	err := s.db.QueryRow(`
SELECT id, book_id, title, created_at, updated_at
FROM ai_sessions WHERE id = ?`, sessionID).
		Scan(&sess.ID, &sess.BookID, &sess.Title, &sess.CreatedAt, &sess.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

// UpdateAISessionTitle 更新会话标题与更新时间
func (s *Store) UpdateAISessionTitle(sessionID, title string) error {
	_, err := s.db.Exec(`UPDATE ai_sessions SET title = ?, updated_at = ? WHERE id = ?`,
		strings.TrimSpace(title), time.Now(), sessionID)
	return err
}

// TouchAISession 更新会话最后活跃时间
func (s *Store) TouchAISession(sessionID string) {
	_, _ = s.db.Exec(`UPDATE ai_sessions SET updated_at = ? WHERE id = ?`, time.Now(), sessionID)
}

// DeleteAISession 删除指定会话（级联删除该会话下的消息）
func (s *Store) DeleteAISession(sessionID string) error {
	_, err := s.db.Exec(`DELETE FROM ai_sessions WHERE id = ?`, sessionID)
	return err
}

// ClearAISessionMessages 清空指定会话下的所有消息记录
func (s *Store) ClearAISessionMessages(sessionID string) error {
	_, err := s.db.Exec(`DELETE FROM ai_messages WHERE session_id = ?`, sessionID)
	return err
}

// ListAIMessages 获取某个会话下的全部消息历史
func (s *Store) ListAIMessages(sessionID string) ([]model.AIMessage, error) {
	rows, err := s.db.Query(`
SELECT id, session_id, book_id, role, content, quote_json, tool_name, tool_arguments, visible, created_at
FROM ai_messages
WHERE session_id = ?
ORDER BY created_at ASC, rowid ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []model.AIMessage
	for rows.Next() {
		var m model.AIMessage
		var quoteRaw string
		var visInt int
		if err := rows.Scan(
			&m.ID, &m.SessionID, &m.BookID, &m.Role, &m.Content,
			&quoteRaw, &m.ToolName, &m.ToolArguments, &visInt, &m.CreatedAt,
		); err != nil {
			return nil, err
		}
		m.Visible = visInt != 0
		if quoteRaw != "" {
			var q model.QuoteMeta
			if err := json.Unmarshal([]byte(quoteRaw), &q); err == nil && q.SelectedText != "" {
				m.Quote = &q
			}
		}
		msgs = append(msgs, m)
	}
	if msgs == nil {
		msgs = []model.AIMessage{}
	}
	return msgs, rows.Err()
}

// InsertAIMessage 写入一条 AI 对话消息（用户消息、工具调用或 AI 回复）
func (s *Store) InsertAIMessage(m *model.AIMessage) error {
	if m.ID == "" {
		m.ID = NewID("msg")
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now()
	}
	quoteRaw := ""
	if m.Quote != nil && strings.TrimSpace(m.Quote.SelectedText) != "" {
		if b, err := json.Marshal(m.Quote); err == nil {
			quoteRaw = string(b)
		}
	}
	visInt := 0
	if m.Visible {
		visInt = 1
	}
	_, err := s.db.Exec(`
INSERT INTO ai_messages (
	id, session_id, book_id, role, content, quote_json, tool_name, tool_arguments, visible, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.SessionID, m.BookID, m.Role, m.Content, quoteRaw, m.ToolName, m.ToolArguments, visInt, m.CreatedAt,
	)
	if err == nil {
		s.TouchAISession(m.SessionID)
	}
	return err
}

// ==================== 分类管理 (Categories) ====================

// ListCategories 获取所有自定义分类及其藏书数量
func (s *Store) ListCategories() ([]model.Category, error) {
	query := `
SELECT c.id, c.name, c.sort_order, c.created_at, COUNT(b.id) AS book_count
FROM categories c
LEFT JOIN books b ON b.category_id = c.id
GROUP BY c.id
ORDER BY c.sort_order ASC, c.created_at ASC
`
	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []model.Category
	for rows.Next() {
		var c model.Category
		if err := rows.Scan(&c.ID, &c.Name, &c.SortOrder, &c.CreatedAt, &c.BookCount); err != nil {
			return nil, err
		}
		list = append(list, c)
	}
	if list == nil {
		list = []model.Category{}
	}
	return list, rows.Err()
}

// EnsureCategory 按名称获取或自动创建分类
func (s *Store) EnsureCategory(name string) (*model.Category, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("category name cannot be empty")
	}
	var c model.Category
	err := s.db.QueryRow(`SELECT id, name, sort_order, created_at FROM categories WHERE name = ?`, name).
		Scan(&c.ID, &c.Name, &c.SortOrder, &c.CreatedAt)
	if err == nil {
		return &c, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	now := time.Now()
	c = model.Category{
		ID:        NewID("cat"),
		Name:      name,
		SortOrder: 0,
		CreatedAt: now,
	}
	_, err = s.db.Exec(`INSERT INTO categories (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)`,
		c.ID, c.Name, c.SortOrder, c.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// GetCategory 按 ID 查询分类
func (s *Store) GetCategory(id string) (*model.Category, error) {
	var c model.Category
	err := s.db.QueryRow(`SELECT id, name, sort_order, created_at FROM categories WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.SortOrder, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// RenameCategory 重命名分类
func (s *Store) RenameCategory(id, newName string) error {
	newName = strings.TrimSpace(newName)
	if newName == "" {
		return errors.New("new category name cannot be empty")
	}
	_, err := s.db.Exec(`UPDATE categories SET name = ? WHERE id = ?`, newName, id)
	return err
}

// DeleteCategory 删除分类并将该分类下的书籍置为未分类
func (s *Store) DeleteCategory(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`UPDATE books SET category_id = '', updated_at = ? WHERE category_id = ?`, time.Now(), id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM categories WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// ==================== 书籍管理 (Books) ====================

const bookSelectColumns = `
SELECT
	b.id, b.title, b.author, b.description, b.file_path, b.file_hash,
	b.file_type, b.file_size, b.cover_url, b.category_id,
	COALESCE(c.name, '') AS category_name,
	b.progress_percent, b.progress_cfi, b.progress_label,
	(SELECT COUNT(1) FROM annotations a WHERE a.book_id = b.id) AS annotation_count,
	b.created_at, b.updated_at, b.last_read_at
FROM books b
LEFT JOIN categories c ON c.id = b.category_id
`

func scanBookRow(scanner interface{ Scan(dest ...any) error }) (*model.Book, error) {
	var b model.Book
	var lastRead sql.NullTime
	err := scanner.Scan(
		&b.ID, &b.Title, &b.Author, &b.Description, &b.FilePath, &b.FileHash,
		&b.FileType, &b.FileSize, &b.CoverURL, &b.CategoryID,
		&b.CategoryName,
		&b.ProgressPercent, &b.ProgressCFI, &b.ProgressLabel,
		&b.AnnotationCount,
		&b.CreatedAt, &b.UpdatedAt, &lastRead,
	)
	if err != nil {
		return nil, err
	}
	if lastRead.Valid {
		t := lastRead.Time
		b.LastReadAt = &t
	}
	return &b, nil
}

// ListBooks 查询书架列表，支持分类过滤、关键词搜索与排序
func (s *Store) ListBooks(categoryID, query, sortBy string) ([]model.Book, error) {
	var where []string
	var args []any

	if categoryID == "__uncategorized__" {
		where = append(where, "b.category_id = ''")
	} else if categoryID != "" && categoryID != "all" {
		where = append(where, "b.category_id = ?")
		args = append(args, categoryID)
	}

	if q := strings.TrimSpace(query); q != "" {
		like := "%" + q + "%"
		where = append(where, "(b.title LIKE ? OR b.author LIKE ? OR b.description LIKE ? OR COALESCE(c.name, '') LIKE ?)")
		args = append(args, like, like, like, like)
	}

	sqlStr := bookSelectColumns
	if len(where) > 0 {
		sqlStr += " WHERE " + strings.Join(where, " AND ")
	}

	switch sortBy {
	case "title":
		sqlStr += " ORDER BY b.title COLLATE NOCASE ASC"
	case "created":
		sqlStr += " ORDER BY b.created_at DESC"
	case "progress":
		sqlStr += " ORDER BY b.progress_percent DESC, b.updated_at DESC"
	default:
		sqlStr += " ORDER BY CASE WHEN b.last_read_at IS NULL THEN 1 ELSE 0 END, b.last_read_at DESC, b.updated_at DESC"
	}

	rows, err := s.db.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var books []model.Book
	for rows.Next() {
		b, err := scanBookRow(rows)
		if err != nil {
			return nil, err
		}
		books = append(books, *b)
	}
	if books == nil {
		books = []model.Book{}
	}
	return books, rows.Err()
}

// GetBook 按 ID 获取书籍详情
func (s *Store) GetBook(id string) (*model.Book, error) {
	row := s.db.QueryRow(bookSelectColumns+" WHERE b.id = ?", id)
	b, err := scanBookRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return b, err
}

// GetBookByPath 按物理路径获取书籍
func (s *Store) GetBookByPath(filePath string) (*model.Book, error) {
	row := s.db.QueryRow(bookSelectColumns+" WHERE b.file_path = ?", filePath)
	b, err := scanBookRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return b, err
}

// GetBookByHash 按文件指纹获取书籍
func (s *Store) GetBookByHash(fileHash string) (*model.Book, error) {
	if fileHash == "" {
		return nil, nil
	}
	row := s.db.QueryRow(bookSelectColumns+" WHERE b.file_hash = ? LIMIT 1", fileHash)
	b, err := scanBookRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return b, err
}

// InsertBook 新增入库一本书籍
func (s *Store) InsertBook(b *model.Book) error {
	if b.ID == "" {
		b.ID = NewID("book")
	}
	now := time.Now()
	if b.CreatedAt.IsZero() {
		b.CreatedAt = now
	}
	b.UpdatedAt = now

	_, err := s.db.Exec(`
INSERT INTO books (
	id, title, author, description, file_path, file_hash,
	file_type, file_size, cover_url, category_id,
	progress_percent, progress_cfi, progress_label,
	created_at, updated_at, last_read_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		b.ID, b.Title, b.Author, b.Description, b.FilePath, b.FileHash,
		b.FileType, b.FileSize, b.CoverURL, b.CategoryID,
		b.ProgressPercent, b.ProgressCFI, b.ProgressLabel,
		b.CreatedAt, b.UpdatedAt, b.LastReadAt,
	)
	return err
}

// UpdateBookFileAndMeta 更新书籍路径与元数据
func (s *Store) UpdateBookFileAndMeta(b *model.Book) error {
	b.UpdatedAt = time.Now()
	_, err := s.db.Exec(`
UPDATE books SET
	title = ?, author = ?, description = ?, file_path = ?, file_hash = ?,
	file_type = ?, file_size = ?, cover_url = ?, category_id = ?, updated_at = ?
WHERE id = ?`,
		b.Title, b.Author, b.Description, b.FilePath, b.FileHash,
		b.FileType, b.FileSize, b.CoverURL, b.CategoryID, b.UpdatedAt, b.ID,
	)
	return err
}

// UpdateBookCategoryAndPath 更新书籍所属分类及物理路径
func (s *Store) UpdateBookCategoryAndPath(id, categoryID, newFilePath string) error {
	_, err := s.db.Exec(`UPDATE books SET category_id = ?, file_path = ?, updated_at = ? WHERE id = ?`,
		categoryID, newFilePath, time.Now(), id)
	return err
}

// UpdateBookProgress 更新阅读进度与最后阅读时间
func (s *Store) UpdateBookProgress(id string, p model.ProgressUpdate) error {
	now := time.Now()
	if p.Percent < 0 {
		p.Percent = 0
	}
	if p.Percent > 100 {
		p.Percent = 100
	}
	_, err := s.db.Exec(`
UPDATE books SET
	progress_percent = ?,
	progress_cfi = ?,
	progress_label = ?,
	updated_at = ?,
	last_read_at = ?
WHERE id = ?`,
		p.Percent, p.CFI, p.Label, now, now, id,
	)
	return err
}

// DeleteBook 从数据库移除书籍（级联删除批注与 AI 对话历史）
func (s *Store) DeleteBook(id string) error {
	_, err := s.db.Exec(`DELETE FROM books WHERE id = ?`, id)
	return err
}

// ==================== 划线与批注 (Annotations) ====================

// ListAnnotations 按章节顺序与创建时间列出某本书的所有划线批注
func (s *Store) ListAnnotations(bookID string) ([]model.Annotation, error) {
	rows, err := s.db.Query(`
SELECT id, book_id, cfi, selected_text, prefix_text, suffix_text,
       note, color, chapter_title, chapter_index, created_at, updated_at
FROM annotations
WHERE book_id = ?
ORDER BY chapter_index ASC, created_at ASC`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []model.Annotation
	for rows.Next() {
		var a model.Annotation
		if err := rows.Scan(
			&a.ID, &a.BookID, &a.CFI, &a.SelectedText, &a.PrefixText, &a.SuffixText,
			&a.Note, &a.Color, &a.ChapterTitle, &a.ChapterIndex, &a.CreatedAt, &a.UpdatedAt,
		); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	if list == nil {
		list = []model.Annotation{}
	}
	return list, rows.Err()
}

// GetAnnotation 获取单条批注
func (s *Store) GetAnnotation(id string) (*model.Annotation, error) {
	var a model.Annotation
	err := s.db.QueryRow(`
SELECT id, book_id, cfi, selected_text, prefix_text, suffix_text,
       note, color, chapter_title, chapter_index, created_at, updated_at
FROM annotations WHERE id = ?`, id).Scan(
		&a.ID, &a.BookID, &a.CFI, &a.SelectedText, &a.PrefixText, &a.SuffixText,
		&a.Note, &a.Color, &a.ChapterTitle, &a.ChapterIndex, &a.CreatedAt, &a.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// UpsertAnnotation 新增或修改批注
func (s *Store) UpsertAnnotation(a *model.Annotation) (*model.Annotation, error) {
	now := time.Now()
	if a.Color == "" {
		a.Color = "zhusha"
	}

	var existingID string
	var createdAt time.Time
	if a.ID != "" {
		_ = s.db.QueryRow(`SELECT id, created_at FROM annotations WHERE id = ?`, a.ID).Scan(&existingID, &createdAt)
	}
	if existingID == "" && a.CFI != "" {
		_ = s.db.QueryRow(`SELECT id, created_at FROM annotations WHERE book_id = ? AND cfi = ?`, a.BookID, a.CFI).Scan(&existingID, &createdAt)
	}

	if existingID != "" {
		a.ID = existingID
		a.CreatedAt = createdAt
		a.UpdatedAt = now
		_, err := s.db.Exec(`
UPDATE annotations SET
	cfi = ?, selected_text = ?, prefix_text = ?, suffix_text = ?,
	note = ?, color = ?, chapter_title = ?, chapter_index = ?, updated_at = ?
WHERE id = ?`,
			a.CFI, a.SelectedText, a.PrefixText, a.SuffixText,
			a.Note, a.Color, a.ChapterTitle, a.ChapterIndex, a.UpdatedAt, a.ID,
		)
		return a, err
	}

	if a.ID == "" {
		a.ID = NewID("ann")
	}
	a.CreatedAt = now
	a.UpdatedAt = now
	_, err := s.db.Exec(`
INSERT INTO annotations (
	id, book_id, cfi, selected_text, prefix_text, suffix_text,
	note, color, chapter_title, chapter_index, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.BookID, a.CFI, a.SelectedText, a.PrefixText, a.SuffixText,
		a.Note, a.Color, a.ChapterTitle, a.ChapterIndex, a.CreatedAt, a.UpdatedAt,
	)
	return a, err
}

// DeleteAnnotation 删除单条批注并返回所属书籍 ID
func (s *Store) DeleteAnnotation(id string) (string, error) {
	var bookID string
	err := s.db.QueryRow(`SELECT book_id FROM annotations WHERE id = ?`, id).Scan(&bookID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if _, err := s.db.Exec(`DELETE FROM annotations WHERE id = ?`, id); err != nil {
		return "", err
	}
	return bookID, nil
}
