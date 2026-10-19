package obsidian

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"xxyxx-reader/internal/model"
)

const (
	managedBlockStart = "<!-- XXYXX_ANNOTATIONS_START -->"
	managedBlockEnd   = "<!-- XXYXX_ANNOTATIONS_END -->"
)

var colorDisplayMap = map[string]string{
	"zhusha":  "朱砂印",
	"zhuqing": "竹青印",
	"songyan": "松烟印",
	"qiukui":  "秋葵印",
}

// RenderMarkdown 生成指定书籍的 Obsidian 笔记 Markdown 内容，若已有用户手写区域则予以保留
func RenderMarkdown(book *model.Book, annotations []model.Annotation, existingContent string) string {
	userNotesSection := extractUserOutsideNotes(existingContent)

	catName := book.CategoryName
	if strings.TrimSpace(catName) == "" {
		catName = "未分类"
	}
	lastReadStr := time.Now().Format(time.RFC3339)
	if book.LastReadAt != nil {
		lastReadStr = book.LastReadAt.Format(time.RFC3339)
	}

	var b strings.Builder
	// 1. YAML Frontmatter
	b.WriteString("---\n")
	b.WriteString(fmt.Sprintf("title: %q\n", book.Title))
	b.WriteString(fmt.Sprintf("author: %q\n", book.Author))
	b.WriteString(fmt.Sprintf("category: %q\n", catName))
	b.WriteString(fmt.Sprintf("total_annotations: %d\n", len(annotations)))
	b.WriteString(fmt.Sprintf("progress: \"%.1f%%\"\n", book.ProgressPercent))
	b.WriteString(fmt.Sprintf("last_read: %s\n", lastReadStr))
	b.WriteString("tags:\n  - 阅境藏书\n  - 读书笔记\n")
	b.WriteString("---\n\n")

	// 2. 书籍头部元信息
	b.WriteString(fmt.Sprintf("# 《%s》· 研读笔记\n\n", book.Title))
	b.WriteString(fmt.Sprintf("> 藏书作者：%s  \n", book.Author))
	b.WriteString(fmt.Sprintf("> 分类归卷：%s  \n", catName))
	b.WriteString(fmt.Sprintf("> 最近阅读进度：%.1f%%\n\n", book.ProgressPercent))

	// 3. 受管批注区块（支持幂等重生成，按章节有序组织）
	b.WriteString(managedBlockStart + "\n")
	if len(annotations) == 0 {
		b.WriteString("\n*（尚无划线摘录，在阅读器中选词即可直写此处）*\n\n")
	} else {
		currentChapter := ""
		for _, ann := range annotations {
			chap := strings.TrimSpace(ann.ChapterTitle)
			if chap == "" {
				chap = "正文摘录"
			}
			if chap != currentChapter {
				b.WriteString("\n---\n\n")
				b.WriteString(fmt.Sprintf("### %s\n\n", chap))
				currentChapter = chap
			}

			sealLabel, ok := colorDisplayMap[ann.Color]
			if !ok {
				sealLabel = "朱砂印"
			}
			timeStr := ann.CreatedAt.Format("2006-01-02 15:04")
			b.WriteString(fmt.Sprintf("> [!quote]+ %s · 摘录于 %s\n", sealLabel, timeStr))

			lines := strings.Split(strings.TrimSpace(ann.SelectedText), "\n")
			for _, l := range lines {
				b.WriteString("> " + strings.TrimSpace(l) + "\n")
			}

			if note := strings.TrimSpace(ann.Note); note != "" {
				b.WriteString("> \n")
				b.WriteString(fmt.Sprintf("> **批注心得**：%s\n", note))
			}
			b.WriteString("\n")
		}
	}
	b.WriteString(managedBlockEnd + "\n")

	// 4. 保留用户在 Obsidian 中位于受管区块之外的手写长评与随笔
	if strings.TrimSpace(userNotesSection) != "" {
		b.WriteString("\n" + strings.TrimSpace(userNotesSection) + "\n")
	}
	return b.String()
}

func extractUserOutsideNotes(existing string) string {
	if existing == "" {
		return ""
	}
	idx := strings.Index(existing, managedBlockEnd)
	if idx >= 0 {
		after := existing[idx+len(managedBlockEnd):]
		return strings.TrimSpace(after)
	}
	return ""
}

// SyncBookNotes 将书籍的所有划线批注以受管区块幂等更新并原子写入 notes/《书名》.md
func SyncBookNotes(notesDir string, book *model.Book, annotations []model.Annotation) (string, string, error) {
	if err := os.MkdirAll(notesDir, 0755); err != nil {
		return "", "", err
	}
	safeTitle := sanitizeNoteFileName(book.Title)
	noteFilePath := filepath.Join(notesDir, fmt.Sprintf("《%s》.md", safeTitle))

	existingBytes, _ := os.ReadFile(noteFilePath)
	mdContent := RenderMarkdown(book, annotations, string(existingBytes))

	tmpPath := noteFilePath + ".tmp"
	if err := os.WriteFile(tmpPath, []byte(mdContent), 0644); err != nil {
		_ = os.Remove(tmpPath)
		return "", "", err
	}
	if err := os.Rename(tmpPath, noteFilePath); err != nil {
		_ = os.Remove(tmpPath)
		return "", "", err
	}
	return noteFilePath, mdContent, nil
}

// SanitizeNoteFileName 导出文件名安全化：移除路径分隔符与 Obsidian/文件系统非法字符
func SanitizeNoteFileName(title string) string {
	return sanitizeNoteFileName(title)
}

func sanitizeNoteFileName(title string) string {
	title = strings.TrimSpace(title)
	title = strings.TrimPrefix(title, "《")
	title = strings.TrimSuffix(title, "》")
	replacer := strings.NewReplacer("/", "·", "\\", "·", ":", "：", "*", "", "?", "", "\"", "", "<", "", ">", "", "|", "")
	clean := replacer.Replace(title)
	if clean == "" {
		return "未命名藏书"
	}
	return clean
}
