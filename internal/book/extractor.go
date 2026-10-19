package book

import (
	"archive/zip"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"
	"unicode"

	"xxyxx-reader/internal/model"
)

// ChapterContent 表示提取出的单章结构化内容（供 AI Tool 读取目录、章节正文与划线上下文）
type ChapterContent struct {
	Index     int    `json:"chapter_index"`
	Title     string `json:"title"`
	Href      string `json:"href,omitempty"`
	Text      string `json:"text,omitempty"`
	CharCount int    `json:"char_count"`
}

// SelectionContextResult 表示划线区域的前后文提取结果
type SelectionContextResult struct {
	ChapterIndex  int    `json:"chapter_index"`
	ChapterTitle  string `json:"chapter_title"`
	BeforeContext string `json:"before_context"`
	SelectedText  string `json:"selected_text"`
	AfterContext  string `json:"after_context"`
	ContextLength int    `json:"context_length"`
}

type cachedBookContent struct {
	fileHash string
	chapters []ChapterContent
}

var (
	extractCacheMu sync.Mutex
	extractCache   = make(map[string]cachedBookContent)
)

// ExtractBookChapters 提取指定书籍的所有章节目录与纯文本内容（支持 EPUB / MD / TXT / MOBI / AZW3）
func ExtractBookChapters(b *model.Book, cacheDir string) ([]ChapterContent, error) {
	if b == nil {
		return nil, fmt.Errorf("book is nil")
	}

	extractCacheMu.Lock()
	if cached, ok := extractCache[b.ID]; ok && cached.fileHash == b.FileHash && len(cached.chapters) > 0 {
		res := cached.chapters
		extractCacheMu.Unlock()
		return res, nil
	}
	extractCacheMu.Unlock()

	var chapters []ChapterContent
	var err error

	switch b.FileType {
	case "epub":
		chapters, err = extractFromEPUBFile(b.FilePath)
	case "md", "txt":
		epubPath, vErr := EnsureVirtualEPUB(b.FilePath, b.FileType, b.ID, b.Title, b.Author, cacheDir)
		if vErr == nil {
			chapters, err = extractFromEPUBFile(epubPath)
		} else {
			err = vErr
		}
	case "mobi", "azw3":
		chapters, err = extractFromMOBIFile(b.FilePath, b.Title)
	default:
		chapters, err = extractFromEPUBFile(b.FilePath)
	}

	if err != nil {
		return nil, err
	}

	extractCacheMu.Lock()
	// 控制缓存上限，防止常驻内存膨胀
	if len(extractCache) >= 6 {
		for k := range extractCache {
			delete(extractCache, k)
			break
		}
	}
	extractCache[b.ID] = cachedBookContent{
		fileHash: b.FileHash,
		chapters: chapters,
	}
	extractCacheMu.Unlock()

	return chapters, nil
}

// ExtractSelectionContext 提取划线区域周围指定字符长度 (contextLength) 的上下文
func ExtractSelectionContext(b *model.Book, cacheDir string, chapterIndex int, selectedText string, contextLength int, fallbackSurround string) (*SelectionContextResult, error) {
	if contextLength <= 0 {
		contextLength = 1200
	}
	if contextLength < 100 {
		contextLength = 100
	}
	if contextLength > 8000 {
		contextLength = 8000
	}

	chapters, err := ExtractBookChapters(b, cacheDir)
	if err != nil || len(chapters) == 0 {
		return &SelectionContextResult{
			ChapterIndex:  chapterIndex,
			SelectedText:  selectedText,
			BeforeContext: fallbackSurround,
			ContextLength: len([]rune(fallbackSurround)),
		}, nil
	}

	needle := normalizeWhitespace(selectedText)
	half := contextLength / 2

	// 1. 优先在指定章节内检索划线文本
	if chapterIndex >= 0 && chapterIndex < len(chapters) && needle != "" {
		if res, ok := matchContextInChapter(chapters[chapterIndex], needle, selectedText, half); ok {
			return res, nil
		}
	}

	// 2. 若指定章节未命中，在全书各章节中自动检索定位
	if needle != "" {
		for _, ch := range chapters {
			if res, ok := matchContextInChapter(ch, needle, selectedText, half); ok {
				return res, nil
			}
		}
		// 退化匹配前 16 个字符子串
		needleRunes := []rune(needle)
		if len(needleRunes) > 16 {
			shortNeedle := string(needleRunes[:16])
			for _, ch := range chapters {
				if res, ok := matchContextInChapter(ch, shortNeedle, selectedText, half); ok {
					return res, nil
				}
			}
		}
	}

	// 3. 若未传入选中文本或未命中，返回当前章节开篇内容或前端附带的上下文快照
	idx := chapterIndex
	if idx < 0 || idx >= len(chapters) {
		idx = 0
	}
	ch := chapters[idx]
	runes := []rune(ch.Text)
	limit := contextLength
	if limit > len(runes) {
		limit = len(runes)
	}
	after := string(runes[:limit])
	if fallbackSurround != "" {
		after = fallbackSurround
	}
	return &SelectionContextResult{
		ChapterIndex:  ch.Index,
		ChapterTitle:  ch.Title,
		BeforeContext: "",
		SelectedText:  selectedText,
		AfterContext:  after,
		ContextLength: len([]rune(after)),
	}, nil
}

func matchContextInChapter(ch ChapterContent, needle, rawSelected string, halfRunes int) (*SelectionContextResult, bool) {
	normText, runeOffsets := buildNormalizedRuneIndex(ch.Text)
	byteIdx := strings.Index(normText, needle)
	if byteIdx < 0 {
		return nil, false
	}

	normPrefixRunes := len([]rune(normText[:byteIdx]))
	normNeedleRunes := len([]rune(needle))
	if normPrefixRunes >= len(runeOffsets) {
		return nil, false
	}

	origRunes := []rune(ch.Text)
	startOrig := runeOffsets[normPrefixRunes]
	endNormIdx := normPrefixRunes + normNeedleRunes - 1
	if endNormIdx >= len(runeOffsets) {
		endNormIdx = len(runeOffsets) - 1
	}
	endOrig := runeOffsets[endNormIdx] + 1
	if endOrig > len(origRunes) {
		endOrig = len(origRunes)
	}

	beforeStart := startOrig - halfRunes
	if beforeStart < 0 {
		beforeStart = 0
	}
	afterEnd := endOrig + halfRunes
	if afterEnd > len(origRunes) {
		afterEnd = len(origRunes)
	}

	beforeStr := strings.TrimSpace(string(origRunes[beforeStart:startOrig]))
	afterStr := strings.TrimSpace(string(origRunes[endOrig:afterEnd]))
	matchedStr := strings.TrimSpace(string(origRunes[startOrig:endOrig]))
	if rawSelected != "" {
		matchedStr = rawSelected
	}

	return &SelectionContextResult{
		ChapterIndex:  ch.Index,
		ChapterTitle:  ch.Title,
		BeforeContext: beforeStr,
		SelectedText:  matchedStr,
		AfterContext:  afterStr,
		ContextLength: len([]rune(beforeStr)) + len([]rune(afterStr)),
	}, true
}

func normalizeWhitespace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func buildNormalizedRuneIndex(orig string) (string, []int) {
	var b strings.Builder
	var offsets []int
	lastSpace := true
	for i, r := range []rune(orig) {
		if unicode.IsSpace(r) {
			if !lastSpace {
				b.WriteRune(' ')
				offsets = append(offsets, i)
				lastSpace = true
			}
		} else {
			b.WriteRune(r)
			offsets = append(offsets, i)
			lastSpace = false
		}
	}
	return b.String(), offsets
}

// ==================== EPUB 章节正文提取 ====================

type epubTocNCX struct {
	NavPoints []epubNavPoint `xml:"navMap>navPoint"`
}

type epubNavPoint struct {
	Label   string `xml:"navLabel>text"`
	Content struct {
		Src string `xml:"src,attr"`
	} `xml:"content"`
	Children []epubNavPoint `xml:"navPoint"`
}

type epubSpinePackage struct {
	Manifest struct {
		Items []struct {
			ID         string `xml:"id,attr"`
			Href       string `xml:"href,attr"`
			MediaType  string `xml:"media-type,attr"`
			Properties string `xml:"properties,attr"`
		} `xml:"item"`
	} `xml:"manifest"`
	Spine struct {
		Itemrefs []struct {
			IDRef string `xml:"idref,attr"`
		} `xml:"itemref"`
	} `xml:"spine"`
}

func extractFromEPUBFile(filePath string) ([]ChapterContent, error) {
	r, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, err
	}
	defer r.Close()

	fileMap := make(map[string]*zip.File, len(r.File))
	for _, f := range r.File {
		fileMap[f.Name] = f
	}

	cf, ok := fileMap["META-INF/container.xml"]
	if !ok {
		return nil, fmt.Errorf("missing META-INF/container.xml")
	}
	rc, err := cf.Open()
	if err != nil {
		return nil, err
	}
	var container epubContainer
	_ = xml.NewDecoder(rc).Decode(&container)
	_ = rc.Close()

	if len(container.Rootfiles) == 0 {
		return nil, fmt.Errorf("empty rootfiles in container.xml")
	}
	opfPath := container.Rootfiles[0].FullPath
	opfDir := path.Dir(opfPath)
	if opfDir == "." {
		opfDir = ""
	}

	opfFile, ok := fileMap[opfPath]
	if !ok {
		return nil, fmt.Errorf("missing opf file: %s", opfPath)
	}
	opfRC, err := opfFile.Open()
	if err != nil {
		return nil, err
	}
	var pkg epubSpinePackage
	_ = xml.NewDecoder(opfRC).Decode(&pkg)
	_ = opfRC.Close()

	manifestByID := make(map[string]string)
	var ncxFullPath string
	for _, it := range pkg.Manifest.Items {
		full := it.Href
		if opfDir != "" {
			full = path.Join(opfDir, it.Href)
		}
		manifestByID[it.ID] = full
		if it.MediaType == "application/x-dtbncx+xml" {
			ncxFullPath = full
		}
	}

	tocTitles := make(map[string]string)
	if ncxFullPath != "" {
		if ncxF, exists := fileMap[ncxFullPath]; exists {
			if ncxRC, err := ncxF.Open(); err == nil {
				var ncx epubTocNCX
				_ = xml.NewDecoder(ncxRC).Decode(&ncx)
				_ = ncxRC.Close()
				ncxDir := path.Dir(ncxFullPath)
				if ncxDir == "." {
					ncxDir = ""
				}
				var walkNav func(pts []epubNavPoint)
				walkNav = func(pts []epubNavPoint) {
					for _, p := range pts {
						src := strings.Split(p.Content.Src, "#")[0]
						if src != "" {
							fullSrc := src
							if ncxDir != "" {
								fullSrc = path.Join(ncxDir, src)
							}
							if _, exists := tocTitles[fullSrc]; !exists && strings.TrimSpace(p.Label) != "" {
								tocTitles[fullSrc] = strings.TrimSpace(p.Label)
							}
						}
						if len(p.Children) > 0 {
							walkNav(p.Children)
						}
					}
				}
				walkNav(ncx.NavPoints)
			}
		}
	}

	var chapters []ChapterContent
	for idx, iref := range pkg.Spine.Itemrefs {
		fullHref, ok := manifestByID[iref.IDRef]
		if !ok {
			continue
		}
		zf, ok := fileMap[fullHref]
		if !ok {
			continue
		}
		zrc, err := zf.Open()
		if err != nil {
			continue
		}
		rawBytes, _ := io.ReadAll(io.LimitReader(zrc, 4*1024*1024))
		_ = zrc.Close()

		rawHTML := string(rawBytes)
		title := tocTitles[fullHref]
		if title == "" {
			title = extractHeadingFromHTML(rawHTML)
		}
		if title == "" {
			title = fmt.Sprintf("第 %d 节", idx+1)
		}
		cleanText := extractCleanTextFromHTML(rawHTML)
		chapters = append(chapters, ChapterContent{
			Index:     idx,
			Title:     title,
			Href:      fullHref,
			Text:      cleanText,
			CharCount: len([]rune(cleanText)),
		})
	}
	return chapters, nil
}

// ==================== MOBI / AZW3 正文提取 ====================

func extractFromMOBIFile(filePath, fallbackTitle string) ([]ChapterContent, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	header := make([]byte, 78)
	if _, err := io.ReadFull(f, header); err != nil {
		return nil, err
	}
	if string(header[60:68]) != "BOOKMOBI" {
		return nil, fmt.Errorf("not a valid BOOKMOBI file")
	}
	numRecords := int(binary.BigEndian.Uint16(header[76:78]))
	if numRecords <= 1 {
		return nil, fmt.Errorf("empty mobi records")
	}
	recTable := make([]byte, numRecords*8)
	if _, err := io.ReadFull(f, recTable); err != nil {
		return nil, err
	}
	offsets := make([]uint32, numRecords)
	for i := 0; i < numRecords; i++ {
		offsets[i] = binary.BigEndian.Uint32(recTable[i*8 : i*8+4])
	}
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	fileSize := uint32(info.Size())

	readRec := func(idx int) ([]byte, error) {
		if idx < 0 || idx >= numRecords {
			return nil, io.EOF
		}
		start := offsets[idx]
		end := fileSize
		if idx+1 < numRecords {
			end = offsets[idx+1]
		}
		if end <= start || end-start > 16*1024*1024 {
			return nil, fmt.Errorf("invalid record bounds")
		}
		buf := make([]byte, end-start)
		if _, err := f.Seek(int64(start), io.SeekStart); err != nil {
			return nil, err
		}
		_, err := io.ReadFull(f, buf)
		return buf, err
	}

	rec0, err := readRec(0)
	if err != nil || len(rec0) < 32 {
		return nil, fmt.Errorf("invalid mobi rec0")
	}
	compression := binary.BigEndian.Uint16(rec0[0:2])
	textRecCount := int(binary.BigEndian.Uint16(rec0[8:10]))
	mobiHeaderLen := binary.BigEndian.Uint32(rec0[20:24])
	var extraFlags uint16
	if mobiHeaderLen >= 0xF4 && len(rec0) >= 0xF4 {
		extraFlags = binary.BigEndian.Uint16(rec0[0xF2:0xF4])
	}

	var allBytes []byte
	for rIdx := 1; rIdx <= textRecCount && rIdx < numRecords; rIdx++ {
		rawRec, err := readRec(rIdx)
		if err != nil {
			continue
		}
		rawRec = trimMobiTrailingData(rawRec, extraFlags)
		if compression == 2 {
			allBytes = append(allBytes, decompressPalmDOCBytes(rawRec)...)
		} else if compression == 1 {
			allBytes = append(allBytes, rawRec...)
		}
	}

	fullHTML := decodeToUTF8(allBytes)
	pagebreakRe := regexp.MustCompile(`(?i)<mbp:pagebreak\s*/?>`)
	rawParts := pagebreakRe.Split(fullHTML, -1)
	if len(rawParts) == 0 {
		rawParts = []string{fullHTML}
	}

	var chapters []ChapterContent
	for _, part := range rawParts {
		clean := extractCleanTextFromHTML(part)
		if strings.TrimSpace(clean) == "" {
			continue
		}
		idx := len(chapters)
		t := extractHeadingFromHTML(part)
		if t == "" {
			if idx == 0 && fallbackTitle != "" {
				t = fallbackTitle
			} else {
				t = fmt.Sprintf("第 %d 节", idx+1)
			}
		}
		chapters = append(chapters, ChapterContent{
			Index:     idx,
			Title:     t,
			Text:      clean,
			CharCount: len([]rune(clean)),
		})
	}
	return chapters, nil
}

func trimMobiTrailingData(rec []byte, flags uint16) []byte {
	end := len(rec)
	for bit := 15; bit >= 1; bit-- {
		if (flags & (1 << bit)) != 0 {
			sz := readMobiVarLen(rec, end)
			if sz > 0 && sz <= end {
				end -= sz
			}
		}
	}
	if (flags&1) != 0 && end > 0 {
		pad := int(rec[end-1]&0x03) + 1
		if pad <= end {
			end -= pad
		}
	}
	return rec[:end]
}

func readMobiVarLen(rec []byte, end int) int {
	val := 0
	shift := 0
	minIdx := end - 4
	if minIdx < 0 {
		minIdx = 0
	}
	for i := end - 1; i >= minIdx; i-- {
		b := int(rec[i])
		val |= (b & 0x7F) << shift
		if (b & 0x80) != 0 {
			return val
		}
		shift += 7
	}
	return 0
}

func decompressPalmDOCBytes(in []byte) []byte {
	out := make([]byte, 0, len(in)*2)
	i := 0
	n := len(in)
	for i < n {
		c := in[i]
		i++
		if c == 0x00 || (c >= 0x09 && c <= 0x7F) {
			out = append(out, c)
		} else if c >= 0x01 && c <= 0x08 {
			cnt := int(c)
			for j := 0; j < cnt && i < n; j++ {
				out = append(out, in[i])
				i++
			}
		} else if c >= 0x80 && c <= 0xBF {
			if i >= n {
				break
			}
			next := in[i]
			i++
			pair := (int(c) << 8) | int(next)
			dist := (pair >> 3) & 0x07FF
			copyLen := (pair & 0x07) + 3
			start := len(out) - dist
			for j := 0; j < copyLen; j++ {
				if start+j >= 0 && start+j < len(out) {
					out = append(out, out[start+j])
				} else {
					out = append(out, ' ')
				}
			}
		} else if c >= 0xC0 {
			out = append(out, ' ', c^0x80)
		}
	}
	return out
}

var (
	reScriptStyle = regexp.MustCompile(`(?is)<(script|style|head)[^>]*>.*?</(script|style|head)>`)
	reHeadingTag  = regexp.MustCompile(`(?is)<h[1-3][^>]*>(.*?)</h[1-3]>`)
	reBlockEndTag = regexp.MustCompile(`(?i)</(p|div|h[1-6]|li|blockquote|tr|section|article)>|<br\s*/?>`)
)

func extractHeadingFromHTML(rawHTML string) string {
	m := reHeadingTag.FindStringSubmatch(rawHTML)
	if len(m) > 1 {
		t := strings.TrimSpace(html.UnescapeString(stripHTMLTags(m[1])))
		if len([]rune(t)) > 60 {
			t = string([]rune(t)[:60])
		}
		return t
	}
	return ""
}

func extractCleanTextFromHTML(rawHTML string) string {
	cleaned := reScriptStyle.ReplaceAllString(rawHTML, "")
	cleaned = reBlockEndTag.ReplaceAllString(cleaned, "\n")
	var b strings.Builder
	inTag := false
	for _, r := range cleaned {
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
	unescaped := html.UnescapeString(b.String())
	lines := strings.Split(unescaped, "\n")
	var paras []string
	for _, l := range lines {
		trimmed := strings.Join(strings.Fields(l), " ")
		if trimmed != "" {
			paras = append(paras, trimmed)
		}
	}
	return strings.Join(paras, "\n\n")
}
