package db

import (
	"path/filepath"
	"testing"

	"xxyxx-reader/internal/model"
)

func TestSQLiteStoreCRUD(t *testing.T) {
	tmpDB := filepath.Join(t.TempDir(), "test_reader.db")
	store, err := Open(tmpDB)
	if err != nil {
		t.Fatalf("Open db failed: %v", err)
	}
	defer store.Close()

	cat, err := store.EnsureCategory("史部·典籍")
	if err != nil {
		t.Fatalf("EnsureCategory failed: %v", err)
	}

	b := &model.Book{
		Title:      "史记",
		Author:     "司马迁",
		FilePath:   "/tmp/library/史部·典籍/史记.epub",
		FileHash:   "hash_shiji_123",
		FileType:   "epub",
		FileSize:   102400,
		CategoryID: cat.ID,
	}
	if err := store.InsertBook(b); err != nil {
		t.Fatalf("InsertBook failed: %v", err)
	}

	foundByHash, err := store.GetBookByHash("hash_shiji_123")
	if err != nil || foundByHash == nil || foundByHash.ID != b.ID {
		t.Fatalf("GetBookByHash failed, got: %+v, err: %v", foundByHash, err)
	}

	ann := &model.Annotation{
		BookID:       b.ID,
		CFI:          "epubcfi(/6/2![/4/2:0,/4/2:10])",
		SelectedText: "究天人之际，通古今之变，成一家之言。",
		Note:         "太史公宏愿",
		Color:        "zhusha",
		ChapterTitle: "报任安书",
		ChapterIndex: 0,
	}
	if _, err := store.UpsertAnnotation(ann); err != nil {
		t.Fatalf("UpsertAnnotation failed: %v", err)
	}

	anns, err := store.ListAnnotations(b.ID)
	if err != nil || len(anns) != 1 {
		t.Fatalf("ListAnnotations expected 1, got %d (%v)", len(anns), err)
	}

	// 验证删除分类时不会删除书籍，而是归为未分类
	if err := store.DeleteCategory(cat.ID); err != nil {
		t.Fatalf("DeleteCategory failed: %v", err)
	}
	afterCatDel, _ := store.GetBook(b.ID)
	if afterCatDel == nil || afterCatDel.CategoryID != "" {
		t.Fatalf("expected book category_id to be reset to empty, got: %+v", afterCatDel)
	}

	// 验证删除书籍时外键级联删除批注
	if err := store.DeleteBook(b.ID); err != nil {
		t.Fatalf("DeleteBook failed: %v", err)
	}
	annsAfter, _ := store.ListAnnotations(b.ID)
	if len(annsAfter) != 0 {
		t.Fatalf("expected cascade delete of annotations, still have %d", len(annsAfter))
	}
}
