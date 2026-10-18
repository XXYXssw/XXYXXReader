package scanner

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"xxyxx-reader/internal/book"
	"xxyxx-reader/internal/config"
	"xxyxx-reader/internal/db"
	"xxyxx-reader/internal/model"
)

// Scanner 负责本地书库扫描、物理目录与分类双向同步及 fsnotify 防抖监听
type Scanner struct {
	cfg     *config.Config
	store   *db.Store
	mu      sync.Mutex
	watcher *fsnotify.Watcher
	stopCh  chan struct{}
}

// New 创建扫描器实例
func New(cfg *config.Config, store *db.Store) *Scanner {
	return &Scanner{
		cfg:    cfg,
		store:  store,
		stopCh: make(chan struct{}),
	}
}

func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".") || strings.HasPrefix(name, "._")
}

// ScanAll 执行一次全量增量扫描，确保本地物理文件夹与 SQLite 完全一致
func (s *Scanner) ScanAll() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	libAbs, err := filepath.Abs(s.cfg.LibraryDir)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(libAbs, 0755); err != nil {
		return 0, err
	}

	entries, err := os.ReadDir(libAbs)
	if err != nil {
		return 0, err
	}

	seenPaths := make(map[string]bool)
	count := 0

	// 1. 扫描一级子文件夹（映射为分类）与根目录下的书籍
	for _, entry := range entries {
		name := entry.Name()
		if isHiddenName(name) {
			continue
		}
		fullPath := filepath.Join(libAbs, name)

		if entry.IsDir() {
			cat, err := s.store.EnsureCategory(name)
			if err != nil {
				log.Printf("[scanner] ensure category %s err: %v", name, err)
				continue
			}
			// 递归扫描该分类子文件夹下的所有电子书
			_ = filepath.WalkDir(fullPath, func(p string, d os.DirEntry, walkErr error) error {
				if walkErr != nil {
					return nil
				}
				if isHiddenName(d.Name()) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if d.IsDir() {
					return nil
				}
				if _, ok := book.IsSupportedFile(p); ok {
					seenPaths[p] = true
					if err := s.ingestFile(p, cat.ID); err == nil {
						count++
					} else {
						log.Printf("[scanner] ingest %s err: %v", p, err)
					}
				}
				return nil
			})
		} else {
			if _, ok := book.IsSupportedFile(fullPath); ok {
				seenPaths[fullPath] = true
				if err := s.ingestFile(fullPath, ""); err == nil {
					count++
				} else {
					log.Printf("[scanner] ingest root book %s err: %v", fullPath, err)
				}
			}
		}
	}

	// 2. 清理磁盘上已真正移除（且未被移动到新路径）的孤儿书籍记录
	allBooks, err := s.store.ListBooks("all", "", "")
	if err == nil {
		for _, b := range allBooks {
			if !seenPaths[b.FilePath] {
				if _, statErr := os.Stat(b.FilePath); os.IsNotExist(statErr) {
					log.Printf("[scanner] removing missing book from db: %s (%s)", b.Title, b.FilePath)
					_ = s.store.DeleteBook(b.ID)
				}
			}
		}
	}

	return count, nil
}

// ingestFile 处理单个书籍文件入库或移动/更新识别
func (s *Scanner) ingestFile(absPath, categoryID string) error {
	info, err := os.Stat(absPath)
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return nil
	}

	// 1. 先按物理路径精确查找
	existingByPath, err := s.store.GetBookByPath(absPath)
	if err != nil {
		return err
	}
	if existingByPath != nil {
		// 文件大小未变且 Hash 存在，仅在分类目录变动时同步 category_id
		if existingByPath.FileSize == info.Size() && existingByPath.FileHash != "" {
			if existingByPath.CategoryID != categoryID {
				return s.store.UpdateBookCategoryAndPath(existingByPath.ID, categoryID, absPath)
			}
			// 若为 MD/TXT，确保虚拟 EPUB 缓存最新
			if existingByPath.FileType == "md" || existingByPath.FileType == "txt" {
				_, _ = book.EnsureVirtualEPUB(absPath, existingByPath.FileType, existingByPath.ID, existingByPath.Title, existingByPath.Author, s.cfg.CacheDir)
			}
			return nil
		}
		// 文件内容发生了修改，重新解析并更新
		meta, err := book.ParseBook(absPath, existingByPath.ID, s.cfg.CoversDir, s.cfg.CacheDir)
		if err != nil {
			return err
		}
		existingByPath.Title = meta.Title
		existingByPath.Author = meta.Author
		if meta.Description != "" {
			existingByPath.Description = meta.Description
		}
		existingByPath.FileHash = meta.FileHash
		existingByPath.FileSize = meta.FileSize
		existingByPath.CategoryID = categoryID
		if meta.HasCover {
			existingByPath.CoverURL = fmt.Sprintf("/api/books/%s/cover", existingByPath.ID)
		}
		return s.store.UpdateBookFileAndMeta(existingByPath)
	}

	// 2. 路径未命中，计算快速指纹 file_hash 检查是否为本地移动或重命名的书籍
	fastHash, _, err := book.ComputeFastHash(absPath)
	if err != nil {
		return err
	}
	existingByHash, err := s.store.GetBookByHash(fastHash)
	if err != nil {
		return err
	}
	if existingByHash != nil {
		// 若旧路径文件已不存在，说明是移动或改名操作 —— 原地迁移路径与分类，完整保留阅读进度与划线批注
		if _, statErr := os.Stat(existingByHash.FilePath); os.IsNotExist(statErr) {
			log.Printf("[scanner] detected moved/renamed book %s: %s -> %s", existingByHash.ID, existingByHash.FilePath, absPath)
			return s.store.UpdateBookCategoryAndPath(existingByHash.ID, categoryID, absPath)
		}
	}

	// 3. 全新书籍入库
	newBookID := db.NewID("book")
	meta, err := book.ParseBook(absPath, newBookID, s.cfg.CoversDir, s.cfg.CacheDir)
	if err != nil {
		return err
	}
	coverURL := ""
	if meta.HasCover {
		coverURL = fmt.Sprintf("/api/books/%s/cover", newBookID)
	}
	newBook := &model.Book{
		ID:          newBookID,
		Title:       meta.Title,
		Author:      meta.Author,
		Description: meta.Description,
		FilePath:    absPath,
		FileHash:    meta.FileHash,
		FileType:    meta.FileType,
		FileSize:    meta.FileSize,
		CoverURL:    coverURL,
		CategoryID:  categoryID,
	}
	return s.store.InsertBook(newBook)
}

// ==================== 物理文件夹与 Web 分类双向同步操作 ====================

func sanitizeFolderName(name string) string {
	name = strings.TrimSpace(name)
	replacer := strings.NewReplacer("/", "·", "\\", "·", ":", "：", "*", "", "?", "", "\"", "", "<", "", ">", "", "|", "")
	return replacer.Replace(name)
}

// CreateCategoryWithDir 在数据库创建分类并同步在 library/ 下创建同名文件夹
func (s *Scanner) CreateCategoryWithDir(name string) (*model.Category, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cleanName := sanitizeFolderName(name)
	if cleanName == "" || isHiddenName(cleanName) {
		return nil, fmt.Errorf("invalid category name")
	}
	libAbs, err := filepath.Abs(s.cfg.LibraryDir)
	if err != nil {
		return nil, err
	}
	dirPath := filepath.Join(libAbs, cleanName)
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return nil, err
	}
	if s.watcher != nil {
		_ = s.watcher.Add(dirPath)
	}
	return s.store.EnsureCategory(cleanName)
}

// RenameCategoryWithDir 重命名分类并同步重命名物理子文件夹及内部书籍路径
func (s *Scanner) RenameCategoryWithDir(catID, newName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cleanName := sanitizeFolderName(newName)
	if cleanName == "" || isHiddenName(cleanName) {
		return fmt.Errorf("invalid category name")
	}
	cat, err := s.store.GetCategory(catID)
	if err != nil || cat == nil {
		return fmt.Errorf("category not found")
	}
	if cat.Name == cleanName {
		return nil
	}

	libAbs, err := filepath.Abs(s.cfg.LibraryDir)
	if err != nil {
		return err
	}
	oldDir := filepath.Join(libAbs, cat.Name)
	newDir := filepath.Join(libAbs, cleanName)

	if _, err := os.Stat(oldDir); err == nil {
		if err := os.Rename(oldDir, newDir); err != nil {
			return err
		}
		if s.watcher != nil {
			_ = s.watcher.Remove(oldDir)
			_ = s.watcher.Add(newDir)
		}
	} else {
		_ = os.MkdirAll(newDir, 0755)
		if s.watcher != nil {
			_ = s.watcher.Add(newDir)
		}
	}

	if err := s.store.RenameCategory(catID, cleanName); err != nil {
		return err
	}

	// 更新该分类下所有书籍的物理路径前缀
	books, err := s.store.ListBooks(catID, "", "")
	if err == nil {
		oldPrefix := oldDir + string(filepath.Separator)
		for _, b := range books {
			if strings.HasPrefix(b.FilePath, oldPrefix) {
				rel := strings.TrimPrefix(b.FilePath, oldPrefix)
				newBookPath := filepath.Join(newDir, rel)
				_ = s.store.UpdateBookCategoryAndPath(b.ID, catID, newBookPath)
			}
		}
	}
	return nil
}

// DeleteCategoryWithDir 删除分类：将物理文件夹内的书籍安全移回 library/ 根目录，绝不删除书籍文件
func (s *Scanner) DeleteCategoryWithDir(catID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cat, err := s.store.GetCategory(catID)
	if err != nil || cat == nil {
		return fmt.Errorf("category not found")
	}
	libAbs, err := filepath.Abs(s.cfg.LibraryDir)
	if err != nil {
		return err
	}
	catDir := filepath.Join(libAbs, cat.Name)

	books, _ := s.store.ListBooks(catID, "", "")
	for _, b := range books {
		destPath := uniqueDestPath(libAbs, filepath.Base(b.FilePath), b.FilePath)
		if b.FilePath != destPath {
			if err := os.Rename(b.FilePath, destPath); err == nil {
				_ = s.store.UpdateBookCategoryAndPath(b.ID, "", destPath)
			}
		} else {
			_ = s.store.UpdateBookCategoryAndPath(b.ID, "", b.FilePath)
		}
	}

	// 若分类目录已空，移除空目录
	if s.watcher != nil {
		_ = s.watcher.Remove(catDir)
	}
	_ = os.Remove(filepath.Join(catDir, ".DS_Store"))
	_ = os.Remove(catDir)

	return s.store.DeleteCategory(catID)
}

// MoveBookToCategory 调整单本书籍分类并同步移动物理文件到对应分类文件夹
func (s *Scanner) MoveBookToCategory(bookID, targetCategoryID string) (*model.Book, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	b, err := s.store.GetBook(bookID)
	if err != nil || b == nil {
		return nil, fmt.Errorf("book not found")
	}

	libAbs, err := filepath.Abs(s.cfg.LibraryDir)
	if err != nil {
		return nil, err
	}

	targetDir := libAbs
	if targetCategoryID != "" {
		cat, err := s.store.GetCategory(targetCategoryID)
		if err != nil || cat == nil {
			return nil, fmt.Errorf("target category not found")
		}
		targetDir = filepath.Join(libAbs, cat.Name)
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			return nil, err
		}
	}

	destPath := uniqueDestPath(targetDir, filepath.Base(b.FilePath), b.FilePath)
	if destPath != b.FilePath {
		if err := os.Rename(b.FilePath, destPath); err != nil {
			return nil, err
		}
	}

	if err := s.store.UpdateBookCategoryAndPath(b.ID, targetCategoryID, destPath); err != nil {
		return nil, err
	}
	return s.store.GetBook(bookID)
}

func uniqueDestPath(destDir, fileName, currentPath string) string {
	candidate := filepath.Join(destDir, fileName)
	if candidate == currentPath {
		return candidate
	}
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		return candidate
	}
	ext := filepath.Ext(fileName)
	base := strings.TrimSuffix(fileName, ext)
	for i := 1; i < 1000; i++ {
		alt := filepath.Join(destDir, fmt.Sprintf("%s_%d%s", base, i, ext))
		if _, err := os.Stat(alt); os.IsNotExist(err) {
			return alt
		}
	}
	return candidate
}

// ==================== fsnotify 防抖文件监听器 ====================

// StartWatcher 启动本地文件夹实时监听（带 500ms 防抖与子目录动态注册）
func (s *Scanner) StartWatcher() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.watcher = w

	libAbs, err := filepath.Abs(s.cfg.LibraryDir)
	if err != nil {
		return err
	}
	_ = filepath.WalkDir(libAbs, func(p string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			if p != libAbs && isHiddenName(d.Name()) {
				return filepath.SkipDir
			}
			_ = w.Add(p)
		}
		return nil
	})

	go s.watchLoop()
	return nil
}

func (s *Scanner) watchLoop() {
	const debounceDuration = 500 * time.Millisecond
	var timer *time.Timer
	var timerC <-chan time.Time

	triggerDebounce := func() {
		if timer == nil {
			timer = time.NewTimer(debounceDuration)
			timerC = timer.C
		} else {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(debounceDuration)
		}
	}

	for {
		select {
		case <-s.stopCh:
			if timer != nil {
				timer.Stop()
			}
			return
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			base := filepath.Base(event.Name)
			if isHiddenName(base) {
				continue
			}
			// 若新建了子文件夹，动态注册到 watcher
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					_ = s.watcher.Add(event.Name)
				}
			}
			triggerDebounce()
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("[scanner] watcher error: %v", err)
		case <-timerC:
			timerC = nil
			if _, err := s.ScanAll(); err != nil {
				log.Printf("[scanner] debounced scan error: %v", err)
			}
		}
	}
}

// Stop 停止文件夹监听
func (s *Scanner) Stop() {
	close(s.stopCh)
	if s.watcher != nil {
		_ = s.watcher.Close()
	}
}
