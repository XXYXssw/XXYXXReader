package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
	"xxyxx-reader/internal/model"
)

// Store 封装 SQLite 数据库访问
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
	// 限制单连接写，配合 WAL 彻底杜绝 SQLITE_BUSY
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
`
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	// 兼容旧表结构的平滑列迁移
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

// GetBookByHash 按文件指纹获取书籍（用于移动或重命名后的身份保留）
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

// UpdateBookFileAndMeta 当文件移动、改名或内容更新时，同步更新路径、分类与基础元数据（保留进度和批注）
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

// DeleteBook 从数据库移除书籍（级联删除批注）
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

// UpsertAnnotation 新增或修改批注（若传入 ID 或同书同 CFI 已存在则更新）
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
