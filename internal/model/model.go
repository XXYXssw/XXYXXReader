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

// AIConfig 用户可配置的 AI 伴读参数（全量持久化在 SQLite）
type AIConfig struct {
	APIURL               string `json:"api_url"`
	APIKey               string `json:"api_key"`
	Model                string `json:"model"`
	SystemPrompt         string `json:"system_prompt"`
	DefaultContextLength int    `json:"default_context_length"`
}

// QuoteMeta 特殊引用块元数据（避免大段明文复制到输入框）
type QuoteMeta struct {
	SelectedText string `json:"selected_text"`
	ChapterTitle string `json:"chapter_title"`
	ChapterIndex int    `json:"chapter_index"`
	CFI          string `json:"cfi"`
	SurroundText string `json:"surround_text,omitempty"`
}

// AISession 单本书的 AI 对话会话记录
type AISession struct {
	ID        string    `json:"id"`
	BookID    string    `json:"book_id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AIMessage 对话消息记录（保存在 SQLite，支持特殊引用块与工具调用过程记录）
type AIMessage struct {
	ID            string     `json:"id"`
	SessionID     string     `json:"session_id"`
	BookID        string     `json:"book_id"`
	Role          string     `json:"role"` // user, assistant, tool, system
	Content       string     `json:"content"`
	Quote         *QuoteMeta `json:"quote,omitempty"`
	ToolName      string     `json:"tool_name,omitempty"`
	ToolArguments string     `json:"tool_arguments,omitempty"`
	Visible       bool       `json:"visible"`
	CreatedAt     time.Time  `json:"created_at"`
}
