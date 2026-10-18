package opds

import (
	"encoding/xml"
	"fmt"
	"net/http"
	"time"

	"xxyxx-reader/internal/db"
	"xxyxx-reader/internal/model"
)

// Feed 定义标准 Atom / OPDS 1.2 XML 结构
type Feed struct {
	XMLName xml.Name `xml:"http://www.w3.org/2005/Atom feed"`
	DC      string   `xml:"xmlns:dc,attr,omitempty"`
	OPDS    string   `xml:"xmlns:opds,attr,omitempty"`
	ID      string   `xml:"id"`
	Title   string   `xml:"title"`
	Updated string   `xml:"updated"`
	Author  Author   `xml:"author"`
	Links   []Link   `xml:"link"`
	Entries []Entry  `xml:"entry"`
}

// Author 作者信息
type Author struct {
	Name string `xml:"name"`
}

// Link 链接节点
type Link struct {
	Rel   string `xml:"rel,attr,omitempty"`
	Href  string `xml:"href,attr"`
	Type  string `xml:"type,attr,omitempty"`
	Title string `xml:"title,attr,omitempty"`
}

// Entry OPDS 条目节点
type Entry struct {
	ID      string  `xml:"id"`
	Title   string  `xml:"title"`
	Updated string  `xml:"updated"`
	Author  *Author `xml:"author,omitempty"`
	Summary string  `xml:"summary,omitempty"`
	Links   []Link  `xml:"link"`
}

// Handler 提供 OPDS 目录与书目服务
type Handler struct {
	store *db.Store
}

// NewHandler 创建 OPDS 处理器
func NewHandler(store *db.Store) *Handler {
	return &Handler{store: store}
}

// ServeRoot 处理 GET /opds 根导航目录
func (h *Handler) ServeRoot(w http.ResponseWriter, r *http.Request) {
	cats, err := h.store.ListCategories()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	entries := []Entry{
		{
			ID:      "urn:xxyxx:opds:all",
			Title:   "全部藏书",
			Updated: now,
			Summary: "浏览书斋内所有馆藏典籍",
			Links: []Link{{
				Rel:  "subsection",
				Href: "/opds/books?category_id=all",
				Type: "application/atom+xml;profile=opds-catalog;kind=acquisition",
			}},
		},
		{
			ID:      "urn:xxyxx:opds:uncategorized",
			Title:   "未分类藏书",
			Updated: now,
			Summary: "尚未归入分卷的独立书籍",
			Links: []Link{{
				Rel:  "subsection",
				Href: "/opds/books?category_id=__uncategorized__",
				Type: "application/atom+xml;profile=opds-catalog;kind=acquisition",
			}},
		},
	}

	for _, c := range cats {
		entries = append(entries, Entry{
			ID:      "urn:xxyxx:opds:cat:" + c.ID,
			Title:   fmt.Sprintf("%s (%d)", c.Name, c.BookCount),
			Updated: c.CreatedAt.UTC().Format(time.RFC3339),
			Summary: fmt.Sprintf("【%s】分卷下共藏书 %d 册", c.Name, c.BookCount),
			Links: []Link{{
				Rel:  "subsection",
				Href: "/opds/books?category_id=" + c.ID,
				Type: "application/atom+xml;profile=opds-catalog;kind=acquisition",
			}},
		})
	}

	feed := Feed{
		DC:      "http://purl.org/dc/terms/",
		OPDS:    "http://opds-spec.org/2010/catalog",
		ID:      "urn:xxyxx:opds:root",
		Title:   "XXYXXReader · 阅境 OPDS 藏书阁",
		Updated: now,
		Author:  Author{Name: "XXYXXReader"},
		Links: []Link{
			{Rel: "self", Href: "/opds", Type: "application/atom+xml;profile=opds-catalog;kind=navigation"},
			{Rel: "start", Href: "/opds", Type: "application/atom+xml;profile=opds-catalog;kind=navigation"},
		},
		Entries: entries,
	}

	writeXML(w, feed)
}

// ServeBooks 处理 GET /opds/books 书目获取列表
func (h *Handler) ServeBooks(w http.ResponseWriter, r *http.Request) {
	catID := r.URL.Query().Get("category_id")
	q := r.URL.Query().Get("q")
	if catID == "" {
		catID = "all"
	}

	books, err := h.store.ListBooks(catID, q, "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	entries := make([]Entry, 0, len(books))
	for _, b := range books {
		entries = append(entries, bookToOPDSEntry(b))
	}

	feed := Feed{
		DC:      "http://purl.org/dc/terms/",
		OPDS:    "http://opds-spec.org/2010/catalog",
		ID:      "urn:xxyxx:opds:books:" + catID,
		Title:   "XXYXXReader · 书目列表",
		Updated: now,
		Author:  Author{Name: "XXYXXReader"},
		Links: []Link{
			{Rel: "self", Href: r.URL.RequestURI(), Type: "application/atom+xml;profile=opds-catalog;kind=acquisition"},
			{Rel: "start", Href: "/opds", Type: "application/atom+xml;profile=opds-catalog;kind=navigation"},
		},
		Entries: entries,
	}
	writeXML(w, feed)
}

func bookToOPDSEntry(b model.Book) Entry {
	mimeType := "application/epub+zip"
	switch b.FileType {
	case "mobi":
		mimeType = "application/x-mobipocket-ebook"
	case "azw3":
		mimeType = "application/vnd.amazon.ebook"
	}

	links := []Link{
		{
			Rel:   "http://opds-spec.org/acquisition",
			Href:  fmt.Sprintf("/api/books/%s/download", b.ID),
			Type:  mimeType,
			Title: "下载原书",
		},
	}
	if b.FileType == "md" || b.FileType == "txt" {
		links[0].Href = fmt.Sprintf("/api/books/%s/content", b.ID)
		links[0].Type = "application/epub+zip"
		links[0].Title = "下载 EPUB 排版包"
	}
	if b.CoverURL != "" {
		links = append(links, Link{
			Rel:  "http://opds-spec.org/image",
			Href: b.CoverURL,
			Type: "image/jpeg",
		})
	}

	summary := b.Description
	if summary == "" {
		summary = fmt.Sprintf("格式：%s · 进度：%.1f%%", b.FileType, b.ProgressPercent)
	}
	return Entry{
		ID:      "urn:xxyxx:book:" + b.ID,
		Title:   b.Title,
		Updated: b.UpdatedAt.UTC().Format(time.RFC3339),
		Author:  &Author{Name: b.Author},
		Summary: summary,
		Links:   links,
	}
}

func writeXML(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/atom+xml; charset=utf-8")
	_, _ = w.Write([]byte(xml.Header))
	enc := xml.NewEncoder(w)
	enc.Indent("", "  ")
	_ = enc.Encode(v)
}
