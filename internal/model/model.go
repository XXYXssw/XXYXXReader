package model

import "time"

// Category 自定义分类领域模型（对应 library/ 下的一级子文件夹）
type Category struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	SortOrder int       `json:"sort_order"`
	BookCount int       `json:"book_count"`
	CreatedAt time.Time `json:"created_at"`
}

// Book 书籍领域模型
type Book struct {
	ID              string     `json:"id"`
	Title           string     `json:"title"`
	Author          string     `json:"author"`
	Description     string     `json:"description"`
	FilePath        string     `json:"file_path"`
	FileHash        string     `json:"file_hash"`
	FileType        string     `json:"file_type"` // epub, azw3, mobi, md, txt
	FileSize        int64      `json:"file_size"`
	CoverURL        string     `json:"cover_url"`
	CategoryID      string     `json:"category_id"`
	CategoryName    string     `json:"category_name"`
	ProgressPercent float64    `json:"progress_percent"`
	ProgressCFI     string     `json:"progress_cfi"`
	ProgressLabel   string     `json:"progress_label"`
	AnnotationCount int        `json:"annotation_count"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	LastReadAt      *time.Time `json:"last_read_at,omitempty"`
}

// Annotation 划线与批注领域模型
type Annotation struct {
	ID           string    `json:"id"`
	BookID       string    `json:"book_id"`
	CFI          string    `json:"cfi"`
	SelectedText string    `json:"selected_text"`
	PrefixText   string    `json:"prefix_text"`
	SuffixText   string    `json:"suffix_text"`
	Note         string    `json:"note"`
	Color        string    `json:"color"` // zhusha, zhuqing, songyan, qiukui
	ChapterTitle string    `json:"chapter_title"`
	ChapterIndex int       `json:"chapter_index"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// ProgressUpdate 阅读进度上报请求
type ProgressUpdate struct {
	Percent float64 `json:"percent"`
	CFI     string  `json:"cfi"`
	Label   string  `json:"label"`
}
