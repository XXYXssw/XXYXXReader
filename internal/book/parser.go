package book

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ParsedMeta 保存从电子书文件中解析出的元数据
type ParsedMeta struct {
	Title       string
	Author      string
	Description string
	FileType    string
	FileSize    int64
	FileHash    string
	HasCover    bool
}

// SupportedExtensions 支持的书籍扩展名集合
var SupportedExtensions = map[string]string{
	".epub": "epub",
	".azw3": "azw3",
	".mobi": "mobi",
	".md":   "md",
	".txt":  "txt",
}

// IsSupportedFile 判断文件是否为受支持的电子书且非隐藏文件
func IsSupportedFile(filePath string) (string, bool) {
	base := filepath.Base(filePath)
	if strings.HasPrefix(base, ".") || strings.HasPrefix(base, "._") {
		return "", false
	}
	ext := strings.ToLower(filepath.Ext(base))
	ft, ok := SupportedExtensions[ext]
	return ft, ok
}

// ComputeFastHash 计算快速文件指纹（文件大小 + 头部 64KB + 尾部 64KB 的 SHA-256）
func ComputeFastHash(filePath string) (string, int64, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	size := info.Size()

	h := sha256.New()
	var sizeBuf [8]byte
	binary.LittleEndian.PutUint64(sizeBuf[:], uint64(size))
	_, _ = h.Write(sizeBuf[:])

	const chunk = 64 * 1024
	buf := make([]byte, chunk)
	n, err := f.Read(buf)
	if err != nil && err != io.EOF {
		return "", 0, err
	}
	_, _ = h.Write(buf[:n])

	if size > chunk {
		offset := size - chunk
		if offset < int64(n) {
			offset = int64(n)
		}
		if _, err := f.Seek(offset, io.SeekStart); err == nil {
			n2, _ := f.Read(buf)
			_, _ = h.Write(buf[:n2])
		}
	}

	return hex.EncodeToString(h.Sum(nil)), size, nil
}

// ParseBook 解析电子书元数据、提取封面至 coversDir，并为 MD/TXT 预热虚拟 EPUB 缓存
func ParseBook(filePath, bookID, coversDir, cacheDir string) (*ParsedMeta, error) {
	ft, ok := IsSupportedFile(filePath)
	if !ok {
		return nil, os.ErrInvalid
	}

	hash, size, err := ComputeFastHash(filePath)
	if err != nil {
		return nil, err
	}

	baseTitle := strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
	meta := &ParsedMeta{
		Title:    baseTitle,
		Author:   "佚名",
		FileType: ft,
		FileSize: size,
		FileHash: hash,
	}

	switch ft {
	case "epub":
		parseEPUB(filePath, bookID, coversDir, meta)
	case "azw3", "mobi":
		parseMOBI(filePath, bookID, coversDir, meta)
	case "md":
		parseMarkdownMeta(filePath, meta)
		_, _ = EnsureVirtualEPUB(filePath, ft, bookID, meta.Title, meta.Author, cacheDir)
	case "txt":
		parseTxtMeta(filePath, meta)
		_, _ = EnsureVirtualEPUB(filePath, ft, bookID, meta.Title, meta.Author, cacheDir)
	}

	if strings.TrimSpace(meta.Title) == "" {
		meta.Title = baseTitle
	}
	if strings.TrimSpace(meta.Author) == "" {
		meta.Author = "佚名"
	}
	return meta, nil
}

// ==================== EPUB 解析 ====================

type epubContainer struct {
	Rootfiles []struct {
		FullPath string `xml:"full-path,attr"`
	} `xml:"rootfiles>rootfile"`
}

type epubPackage struct {
	Metadata struct {
		Title       []string `xml:"title"`
		Creator     []string `xml:"creator"`
		Description []string `xml:"description"`
		Meta        []struct {
			Name    string `xml:"name,attr"`
			Content string `xml:"content,attr"`
		} `xml:"meta"`
	} `xml:"metadata"`
	Manifest struct {
		Items []struct {
			ID         string `xml:"id,attr"`
			Href       string `xml:"href,attr"`
			MediaType  string `xml:"media-type,attr"`
			Properties string `xml:"properties,attr"`
		} `xml:"item"`
	} `xml:"manifest"`
}

func parseEPUB(filePath, bookID, coversDir string, meta *ParsedMeta) {
	r, err := zip.OpenReader(filePath)
	if err != nil {
		return
	}
	defer r.Close()

	fileMap := make(map[string]*zip.File, len(r.File))
	for _, f := range r.File {
		fileMap[f.Name] = f
	}

	containerFile, ok := fileMap["META-INF/container.xml"]
	if !ok {
		return
	}
	rc, err := containerFile.Open()
	if err != nil {
		return
	}
	var c epubContainer
	_ = xml.NewDecoder(rc).Decode(&c)
	_ = rc.Close()

	if len(c.Rootfiles) == 0 || c.Rootfiles[0].FullPath == "" {
		return
	}
	opfPath := c.Rootfiles[0].FullPath
	opfFile, ok := fileMap[opfPath]
	if !ok {
		return
	}

	opfRC, err := opfFile.Open()
	if err != nil {
		return
	}
	var pkg epubPackage
	_ = xml.NewDecoder(opfRC).Decode(&pkg)
	_ = opfRC.Close()

	if len(pkg.Metadata.Title) > 0 && strings.TrimSpace(pkg.Metadata.Title[0]) != "" {
		meta.Title = strings.TrimSpace(pkg.Metadata.Title[0])
	}
	if len(pkg.Metadata.Creator) > 0 && strings.TrimSpace(pkg.Metadata.Creator[0]) != "" {
		meta.Author = strings.TrimSpace(pkg.Metadata.Creator[0])
	}
	if len(pkg.Metadata.Description) > 0 {
		meta.Description = stripHTMLTags(strings.TrimSpace(pkg.Metadata.Description[0]))
	}

	// 查找封面图片
	var coverID string
	for _, m := range pkg.Metadata.Meta {
		if strings.EqualFold(m.Name, "cover") && m.Content != "" {
			coverID = m.Content
			break
		}
	}

	var coverHref string
	for _, item := range pkg.Manifest.Items {
		if !strings.HasPrefix(item.MediaType, "image/") {
			continue
		}
		if strings.Contains(item.Properties, "cover-image") || (coverID != "" && item.ID == coverID) {
			coverHref = item.Href
			break
		}
	}
	if coverHref == "" {
		for _, item := range pkg.Manifest.Items {
			if strings.HasPrefix(item.MediaType, "image/") &&
				(strings.Contains(strings.ToLower(item.ID), "cover") || strings.Contains(strings.ToLower(item.Href), "cover")) {
				coverHref = item.Href
				break
			}
		}
	}

	if coverHref != "" && bookID != "" && coversDir != "" {
		opfDir := path.Dir(opfPath)
		fullCoverPath := coverHref
		if opfDir != "." && opfDir != "" {
			fullCoverPath = path.Join(opfDir, coverHref)
		}
		if cf, exists := fileMap[fullCoverPath]; exists {
			if saveZipEntryToFile(cf, filepath.Join(coversDir, bookID+".jpg")) == nil {
				meta.HasCover = true
			}
		}
	}
}

func saveZipEntryToFile(zf *zip.File, destPath string) error {
	rc, err := zf.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	tmp := destPath + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, io.LimitReader(rc, 15*1024*1024))
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tmp)
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
	return os.Rename(tmp, destPath)
}

// ==================== Markdown / TXT 元数据解析 ====================

func parseMarkdownMeta(filePath string, meta *ParsedMeta) {
	f, err := os.Open(filePath)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	inFrontmatter := false
	lineCount := 0
	var descLines []string

	for scanner.Scan() {
		lineCount++
		if lineCount > 120 {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if lineCount == 1 && line == "---" {
			inFrontmatter = true
			continue
		}
		if inFrontmatter {
			if line == "---" || line == "..." {
				inFrontmatter = false
				continue
			}
			if k, v, ok := strings.Cut(line, ":"); ok {
				k = strings.ToLower(strings.TrimSpace(k))
				v = strings.Trim(strings.TrimSpace(v), `"'`)
				switch k {
				case "title":
					if v != "" {
						meta.Title = v
					}
				case "author", "creator":
					if v != "" {
						meta.Author = v
					}
				case "description", "summary", "excerpt":
					if v != "" {
						meta.Description = v
					}
				}
			}
			continue
		}

		if strings.HasPrefix(line, "# ") && meta.Title == strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath)) {
			h := strings.TrimSpace(strings.TrimPrefix(line, "# "))
			if h != "" {
				meta.Title = h
			}
			continue
		}
		if strings.HasPrefix(line, "> 作者：") || strings.HasPrefix(line, "作者：") {
			a := strings.TrimPrefix(strings.TrimPrefix(line, "> "), "作者：")
			if strings.TrimSpace(a) != "" {
				meta.Author = strings.TrimSpace(a)
			}
			continue
		}
		if line != "" && !strings.HasPrefix(line, "#") && len(descLines) < 3 {
			descLines = append(descLines, strings.TrimPrefix(line, "> "))
		}
	}
	if meta.Description == "" && len(descLines) > 0 {
		meta.Description = truncateRunes(strings.Join(descLines, " "), 180)
	}
}

func parseTxtMeta(filePath string, meta *ParsedMeta) {
	raw, err := readFileHeadBytes(filePath, 16*1024)
	if err != nil {
		return
	}
	text := decodeToUTF8(raw)
	lines := strings.Split(text, "\n")
	var descLines []string
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		if strings.HasPrefix(l, "作者：") || strings.HasPrefix(l, "作者:") {
			a := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(l, "作者："), "作者:"))
			if a != "" {
				meta.Author = a
			}
			continue
		}
		if len(descLines) < 3 {
			descLines = append(descLines, l)
		}
	}
	if len(descLines) > 0 {
		meta.Description = truncateRunes(strings.Join(descLines, " "), 180)
	}
}

func readFileHeadBytes(filePath string, maxBytes int) ([]byte, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, maxBytes)
	n, err := f.Read(buf)
	if err != nil && err != io.EOF {
		return nil, err
	}
	return buf[:n], nil
}

func stripHTMLTags(s string) string {
	var b strings.Builder
	inTag := false
	for _, r := range s {
		switch r {
		case '<':
			inTag = true
		case '>':
			inTag = false
		default:
			if !inTag {
				b.WriteRune(r)
			}
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "…"
}
