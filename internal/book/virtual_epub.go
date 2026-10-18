package book

import (
	"archive/zip"
	"bytes"
	"fmt"
	"html"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
	"golang.org/x/text/transform"
)

type virtualChapter struct {
	Title string
	Body  string // XHTML 片段
}

var txtChapterRegex = regexp.MustCompile(`^\s*(第[0-9零一二三四五六七八九十百千万〇两]+[章节回卷集部篇]|卷[0-9一二三四五六七八九十百]+|Chapter\s+\d+|CHAPTER\s+\d+|楔子|引子|序言|前言|后记|跋)(\s+.*|$)`)

// EnsureVirtualEPUB 将 Markdown 或 TXT 转换为标准虚拟 EPUB 并落盘缓存至 cacheDir/{bookID}.epub
func EnsureVirtualEPUB(srcPath, fileType, bookID, title, author, cacheDir string) (string, error) {
	if bookID == "" || cacheDir == "" {
		return "", fmt.Errorf("bookID and cacheDir required")
	}
	destPath := filepath.Join(cacheDir, bookID+".epub")

	srcInfo, err := os.Stat(srcPath)
	if err != nil {
		return "", err
	}
	if dstInfo, err := os.Stat(destPath); err == nil {
		if !dstInfo.ModTime().Before(srcInfo.ModTime()) && dstInfo.Size() > 0 {
			return destPath, nil
		}
	}

	raw, err := os.ReadFile(srcPath)
	if err != nil {
		return "", err
	}
	text := decodeToUTF8(raw)

	var chapters []virtualChapter
	if fileType == "md" {
		chapters = splitMarkdownChapters(text, title)
	} else {
		chapters = splitTxtChapters(text, title)
	}
	if len(chapters) == 0 {
		chapters = []virtualChapter{{
			Title: title,
			Body:  "<p>（全书无正文内容）</p>",
		}}
	}

	tmpPath := destPath + ".tmp"
	if err := writeEPUBArchive(tmpPath, bookID, title, author, chapters); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := os.Rename(tmpPath, destPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	return destPath, nil
}

// decodeToUTF8 自动探测 UTF-8 / GB18030 / Big5 编码并转换为 UTF-8 字符串
func decodeToUTF8(raw []byte) string {
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	if utf8.Valid(raw) {
		return string(raw)
	}
	// 优先尝试 GB18030 (兼容 GBK / GB2312)
	if decoded, err := io.ReadAll(transform.NewReader(bytes.NewReader(raw), simplifiedchinese.GB18030.NewDecoder())); err == nil && utf8.Valid(decoded) {
		return string(decoded)
	}
	// 备选 Big5
	if decoded, err := io.ReadAll(transform.NewReader(bytes.NewReader(raw), traditionalchinese.Big5.NewDecoder())); err == nil && utf8.Valid(decoded) {
		return string(decoded)
	}
	return string(bytes.ToValidUTF8(raw, []byte("")))
}

func splitMarkdownChapters(mdText, fallbackTitle string) []virtualChapter {
	lines := strings.Split(strings.ReplaceAll(mdText, "\r\n", "\n"), "\n")

	// 跳过 YAML Frontmatter
	startIdx := 0
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		for i := 1; i < len(lines); i++ {
			t := strings.TrimSpace(lines[i])
			if t == "---" || t == "..." {
				startIdx = i + 1
				break
			}
		}
	}
	lines = lines[startIdx:]

	var chapters []virtualChapter
	curTitle := ""
	var curLines []string
	inCodeBlock := false

	flush := func() {
		body := renderMarkdownToXHTML(curLines)
		if strings.TrimSpace(body) == "" && curTitle == "" {
			return
		}
		t := curTitle
		if t == "" {
			if len(chapters) == 0 {
				t = fallbackTitle
			} else {
				t = fmt.Sprintf("第 %d 节", len(chapters)+1)
			}
		}
		chapters = append(chapters, virtualChapter{
			Title: t,
			Body:  body,
		})
		curLines = nil
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inCodeBlock = !inCodeBlock
			curLines = append(curLines, line)
			continue
		}
		if !inCodeBlock && (strings.HasPrefix(trimmed, "# ") || strings.HasPrefix(trimmed, "## ")) {
			if len(curLines) > 0 || curTitle != "" {
				flush()
			}
			curTitle = strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
			continue
		}
		curLines = append(curLines, line)
	}
	if len(curLines) > 0 || curTitle != "" {
		flush()
	}
	return chapters
}

func renderMarkdownToXHTML(lines []string) string {
	var b strings.Builder
	inCode := false
	inList := false
	inQuote := false

	closeBlocks := func() {
		if inList {
			b.WriteString("</ul>\n")
			inList = false
		}
		if inQuote {
			b.WriteString("</blockquote>\n")
			inQuote = false
		}
	}

	for _, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		if strings.HasPrefix(trimmed, "```") {
			closeBlocks()
			if !inCode {
				b.WriteString("<pre><code>")
				inCode = true
			} else {
				b.WriteString("</code></pre>\n")
				inCode = false
			}
			continue
		}
		if inCode {
			b.WriteString(html.EscapeString(rawLine))
			b.WriteString("\n")
			continue
		}
		if trimmed == "" {
			closeBlocks()
			continue
		}
		if trimmed == "---" || trimmed == "***" {
			closeBlocks()
			b.WriteString("<hr/>\n")
			continue
		}
		if strings.HasPrefix(trimmed, "### ") {
			closeBlocks()
			b.WriteString("<h3>" + formatInlineMarkdown(strings.TrimPrefix(trimmed, "### ")) + "</h3>\n")
			continue
		}
		if strings.HasPrefix(trimmed, "#### ") {
			closeBlocks()
			b.WriteString("<h4>" + formatInlineMarkdown(strings.TrimPrefix(trimmed, "#### ")) + "</h4>\n")
			continue
		}
		if strings.HasPrefix(trimmed, ">") {
			if inList {
				b.WriteString("</ul>\n")
				inList = false
			}
			if !inQuote {
				b.WriteString("<blockquote>\n")
				inQuote = true
			}
			qText := strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))
			if qText != "" {
				b.WriteString("<p>" + formatInlineMarkdown(qText) + "</p>\n")
			}
			continue
		}
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
			if inQuote {
				b.WriteString("</blockquote>\n")
				inQuote = false
			}
			if !inList {
				b.WriteString("<ul>\n")
				inList = true
			}
			item := strings.TrimSpace(trimmed[2:])
			b.WriteString("<li>" + formatInlineMarkdown(item) + "</li>\n")
			continue
		}
		closeBlocks()
		b.WriteString("<p>" + formatInlineMarkdown(trimmed) + "</p>\n")
	}
	if inCode {
		b.WriteString("</code></pre>\n")
	}
	closeBlocks()
	return b.String()
}

var (
	reBold   = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reItalic = regexp.MustCompile(`\*([^*]+)\*`)
	reCode   = regexp.MustCompile("`([^`]+)`")
)

func formatInlineMarkdown(s string) string {
	escaped := html.EscapeString(s)
	escaped = reCode.ReplaceAllString(escaped, "<code>$1</code>")
	escaped = reBold.ReplaceAllString(escaped, "<strong>$1</strong>")
	escaped = reItalic.ReplaceAllString(escaped, "<em>$1</em>")
	return escaped
}

func splitTxtChapters(txt, fallbackTitle string) []virtualChapter {
	lines := strings.Split(strings.ReplaceAll(txt, "\r\n", "\n"), "\n")
	var chapters []virtualChapter
	curTitle := ""
	var curParas []string
	curRunes := 0

	flush := func() {
		if len(curParas) == 0 && curTitle == "" {
			return
		}
		t := curTitle
		if t == "" {
			if len(chapters) == 0 {
				t = fallbackTitle
			} else {
				t = fmt.Sprintf("第 %d 节", len(chapters)+1)
			}
		}
		var b strings.Builder
		for _, p := range curParas {
			b.WriteString("<p>")
			b.WriteString(html.EscapeString(p))
			b.WriteString("</p>\n")
		}
		chapters = append(chapters, virtualChapter{
			Title: t,
			Body:  b.String(),
		})
		curParas = nil
		curRunes = 0
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if len([]rune(trimmed)) <= 45 && txtChapterRegex.MatchString(trimmed) {
			flush()
			curTitle = trimmed
			continue
		}
		curParas = append(curParas, trimmed)
		curRunes += len([]rune(trimmed))
		// 若纯文本无章节标题且单章超过 8000 字，自动切分章节以保证墨水屏翻页流畅
		if curTitle == "" && curRunes >= 8000 {
			flush()
		}
	}
	flush()
	return chapters
}

func writeEPUBArchive(destPath, bookID, title, author string, chapters []virtualChapter) error {
	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer f.Close()

	zw := zip.NewWriter(f)
	defer zw.Close()

	// 1. mimetype (必须为首个文件且不压缩)
	mimeHeader := &zip.FileHeader{
		Name:   "mimetype",
		Method: zip.Store,
	}
	mw, err := zw.CreateHeader(mimeHeader)
	if err != nil {
		return err
	}
	if _, err := mw.Write([]byte("application/epub+zip")); err != nil {
		return err
	}

	// 2. META-INF/container.xml
	cw, err := zw.Create("META-INF/container.xml")
	if err != nil {
		return err
	}
	_, _ = cw.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`))

	// 3. OEBPS/style.css
	sw, err := zw.Create("OEBPS/style.css")
	if err != nil {
		return err
	}
	_, _ = sw.Write([]byte(`body { line-height: 1.8; margin: 0; padding: 0; }
h1, h2, h3 { font-weight: 600; margin: 1.2em 0 0.6em; }
p { margin: 0.6em 0; text-align: justify; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #8b6f5c; color: #6b6358; }
pre { padding: 0.8em; background: rgba(0,0,0,0.05); overflow-x: auto; font-family: monospace; }`))

	// 4. 写入各章节 XHTML
	var manifestItems strings.Builder
	var spineItems strings.Builder
	var navPoints strings.Builder

	for i, ch := range chapters {
		idx := i + 1
		id := fmt.Sprintf("chap_%03d", idx)
		href := fmt.Sprintf("chapter_%03d.xhtml", idx)

		manifestItems.WriteString(fmt.Sprintf(`    <item id="%s" href="%s" media-type="application/xhtml+xml"/>`+"\n", id, href))
		spineItems.WriteString(fmt.Sprintf(`    <itemref idref="%s"/>`+"\n", id))
		navPoints.WriteString(fmt.Sprintf(`    <navPoint id="nav_%d" playOrder="%d">
      <navLabel><text>%s</text></navLabel>
      <content src="%s"/>
    </navPoint>`+"\n", idx, idx, html.EscapeString(ch.Title), href))

		chw, err := zw.Create("OEBPS/" + href)
		if err != nil {
			return err
		}
		xhtml := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <title>%s</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <section class="chapter" data-chapter-index="%d">
    <h2>%s</h2>
    %s
  </section>
</body>
</html>`, html.EscapeString(ch.Title), i, html.EscapeString(ch.Title), ch.Body)
		if _, err := chw.Write([]byte(xhtml)); err != nil {
			return err
		}
	}

	// 5. OEBPS/toc.ncx
	tw, err := zw.Create("OEBPS/toc.ncx")
	if err != nil {
		return err
	}
	ncx := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="%s"/>
  </head>
  <docTitle><text>%s</text></docTitle>
  <navMap>
%s  </navMap>
</ncx>`, html.EscapeString(bookID), html.EscapeString(title), navPoints.String())
	_, _ = tw.Write([]byte(ncx))

	// 6. OEBPS/content.opf
	ow, err := zw.Create("OEBPS/content.opf")
	if err != nil {
		return err
	}
	opf := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">%s</dc:identifier>
    <dc:title>%s</dc:title>
    <dc:creator>%s</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
%s  </manifest>
  <spine toc="ncx">
%s  </spine>
</package>`, html.EscapeString(bookID), html.EscapeString(title), html.EscapeString(author), manifestItems.String(), spineItems.String())
	_, err = ow.Write([]byte(opf))
	return err
}
