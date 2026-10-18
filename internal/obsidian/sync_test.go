package obsidian

import (
	"strings"
	"testing"
	"time"

	"xxyxx-reader/internal/model"
)

func TestRenderMarkdownPreservesUserNotes(t *testing.T) {
	now := time.Date(2026, 10, 18, 21, 40, 0, 0, time.Local)
	book := &model.Book{
		ID:              "book_1",
		Title:           "陶庵梦忆",
		Author:          "张岱",
		CategoryName:    "文苑·随笔",
		ProgressPercent: 42.5,
		LastReadAt:      &now,
	}
	anns := []model.Annotation{
		{
			ID:           "ann_1",
			BookID:       "book_1",
			SelectedText: "西湖七月半，一无可看，止可看看七月半之人。",
			Note:         "写尽世态百相。",
			Color:        "zhuqing",
			ChapterTitle: "卷二 · 西湖七月半",
			ChapterIndex: 1,
			CreatedAt:    now,
		},
	}

	existing := `---
title: "陶庵梦忆"
---
<!-- XXYXX_ANNOTATIONS_START -->
旧批注
<!-- XXYXX_ANNOTATIONS_END -->

## 我的个人长评
这是我在 Obsidian 手写的长文感悟，同步时绝不能丢失。`

	out := RenderMarkdown(book, anns, existing)
	if !strings.Contains(out, "写尽世态百相。") {
		t.Fatalf("expected annotation note in output, got:\n%s", out)
	}
	if !strings.Contains(out, "这是我在 Obsidian 手写的长文感悟，同步时绝不能丢失。") {
		t.Fatalf("expected user manual notes to be preserved, got:\n%s", out)
	}
}
