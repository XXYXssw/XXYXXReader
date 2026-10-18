package book

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// parseMOBI 解析 PDB / MOBI / AZW3 (KF8) 头部与 EXTH 扩展记录，提取书名、作者、简介与封面图
func parseMOBI(filePath, bookID, coversDir string, meta *ParsedMeta) {
	f, err := os.Open(filePath)
	if err != nil {
		return
	}
	defer f.Close()

	header := make([]byte, 78)
	if _, err := io.ReadFull(f, header); err != nil {
		return
	}

	magic := string(header[60:68])
	if magic != "BOOKMOBI" {
		return
	}

	numRecords := int(binary.BigEndian.Uint16(header[76:78]))
	if numRecords <= 0 || numRecords > 65535 {
		return
	}

	recTable := make([]byte, numRecords*8)
	if _, err := io.ReadFull(f, recTable); err != nil {
		return
	}

	offsets := make([]uint32, numRecords)
	for i := 0; i < numRecords; i++ {
		offsets[i] = binary.BigEndian.Uint32(recTable[i*8 : i*8+4])
	}

	rec0Len := uint32(4096)
	if numRecords > 1 && offsets[1] > offsets[0] {
		rec0Len = offsets[1] - offsets[0]
		if rec0Len > 256*1024 {
			rec0Len = 256 * 1024
		}
	}

	if _, err := f.Seek(int64(offsets[0]), io.SeekStart); err != nil {
		return
	}
	rec0 := make([]byte, rec0Len)
	n, err := io.ReadFull(f, rec0)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return
	}
	rec0 = rec0[:n]
	if len(rec0) < 132 || string(rec0[16:20]) != "MOBI" {
		return
	}

	mobiHeaderLen := binary.BigEndian.Uint32(rec0[20:24])
	fullNameOffset := binary.BigEndian.Uint32(rec0[84:88])
	fullNameLen := binary.BigEndian.Uint32(rec0[88:92])
	firstImageIdx := int(binary.BigEndian.Uint32(rec0[108:112]))
	exthFlags := binary.BigEndian.Uint32(rec0[128:132])

	if fullNameOffset > 0 && fullNameLen > 0 && int(fullNameOffset+fullNameLen) <= len(rec0) {
		title := strings.TrimSpace(string(rec0[fullNameOffset : fullNameOffset+fullNameLen]))
		if title != "" {
			meta.Title = title
		}
	}

	coverOffset := -1
	if (exthFlags & 0x40) != 0 {
		exthStart := int(16 + mobiHeaderLen)
		if exthStart+12 <= len(rec0) && string(rec0[exthStart:exthStart+4]) == "EXTH" {
			recCount := int(binary.BigEndian.Uint32(rec0[exthStart+8 : exthStart+12]))
			pos := exthStart + 12
			for i := 0; i < recCount && pos+8 <= len(rec0); i++ {
				recType := binary.BigEndian.Uint32(rec0[pos : pos+4])
				recLen := int(binary.BigEndian.Uint32(rec0[pos+4 : pos+8]))
				if recLen < 8 || pos+recLen > len(rec0) {
					break
				}
				valBytes := rec0[pos+8 : pos+recLen]
				switch recType {
				case 100: // Author
					a := strings.TrimSpace(string(valBytes))
					if a != "" {
						meta.Author = a
					}
				case 103: // Description
					d := stripHTMLTags(strings.TrimSpace(string(valBytes)))
					if d != "" {
						meta.Description = truncateRunes(d, 220)
					}
				case 503: // Updated Title
					t := strings.TrimSpace(string(valBytes))
					if t != "" {
						meta.Title = t
					}
				case 201: // CoverOffset
					if len(valBytes) == 4 {
						coverOffset = int(binary.BigEndian.Uint32(valBytes))
					}
				}
				pos += recLen
			}
		}
	}

	// 提取封面图片记录
	if coverOffset >= 0 && firstImageIdx > 0 && bookID != "" && coversDir != "" {
		imgRecIdx := firstImageIdx + coverOffset
		if imgRecIdx > 0 && imgRecIdx < numRecords {
			start := offsets[imgRecIdx]
			var end uint32
			if imgRecIdx+1 < numRecords {
				end = offsets[imgRecIdx+1]
			} else if info, err := f.Stat(); err == nil {
				end = uint32(info.Size())
			}
			if end > start && (end-start) < 10*1024*1024 {
				imgBuf := make([]byte, end-start)
				if _, err := f.Seek(int64(start), io.SeekStart); err == nil {
					if _, err := io.ReadFull(f, imgBuf); err == nil && isImageBytes(imgBuf) {
						dest := filepath.Join(coversDir, bookID+".jpg")
						if os.WriteFile(dest, imgBuf, 0644) == nil {
							meta.HasCover = true
						}
					}
				}
			}
		}
	}
}

func isImageBytes(b []byte) bool {
	if len(b) < 8 {
		return false
	}
	// JPEG, PNG, GIF, WebP
	return bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}) ||
		bytes.HasPrefix(b, []byte{0x89, 'P', 'N', 'G'}) ||
		bytes.HasPrefix(b, []byte("GIF8")) ||
		(bytes.HasPrefix(b, []byte("RIFF")) && string(b[8:12]) == "WEBP")
}
