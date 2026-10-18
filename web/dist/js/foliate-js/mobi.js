// Foliate-core PalmDOC / MOBI / AZW3 (KF8) 浏览器端流式解包器
export class MOBIBook {
  constructor(arrayBuffer) {
    this.buffer = arrayBuffer;
    this.view = new DataView(arrayBuffer);
    this.bytes = new Uint8Array(arrayBuffer);
    this.metadata = { title: '', author: '', description: '' };
    this.toc = [];
    this.sections = [];
  }

  async init() {
    const magic = new TextDecoder('ascii').decode(this.bytes.subarray(60, 68));
    if (magic !== 'BOOKMOBI') {
      throw new Error('Invalid MOBI/AZW3 file header');
    }

    const numRecords = this.view.getUint16(76, false);
    const offsets = [];
    for (let i = 0; i < numRecords; i++) {
      offsets.push(this.view.getUint32(78 + i * 8, false));
    }

    const getRecord = (idx) => {
      if (idx < 0 || idx >= numRecords) return new Uint8Array(0);
      const start = offsets[idx];
      const end = idx + 1 < numRecords ? offsets[idx + 1] : this.bytes.length;
      return this.bytes.subarray(start, end);
    };

    const rec0 = getRecord(0);
    const rec0View = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);
    const compression = rec0View.getUint16(0, false);
    const textRecordCount = rec0View.getUint16(8, false);
    const mobiHeaderLen = rec0View.getUint32(20, false);
    const textEncoding = rec0View.getUint32(28, false);
    const fullNameOffset = rec0View.getUint32(84, false);
    const fullNameLen = rec0View.getUint32(88, false);
    const extraDataFlags = mobiHeaderLen >= 0xF4 ? rec0View.getUint16(0xF2, false) : 0;

    const encodingLabel = textEncoding === 65001 ? 'utf-8' : 'gb18030';
    const decoder = new TextDecoder(encodingLabel, { fatal: false });

    if (fullNameOffset > 0 && fullNameLen > 0 && fullNameOffset + fullNameLen <= rec0.length) {
      this.metadata.title = decoder.decode(rec0.subarray(fullNameOffset, fullNameOffset + fullNameLen)).trim();
    }

    // 解压所有正文 Record 并拼接字节流
    const chunks = [];
    let totalLen = 0;
    for (let r = 1; r <= textRecordCount && r < numRecords; r++) {
      let rawRec = getRecord(r);
      rawRec = this._trimTrailingEntries(rawRec, extraDataFlags);
      const decompressed = compression === 2 ? this._decompressPalmDOC(rawRec) : rawRec;
      chunks.push(decompressed);
      totalLen += decompressed.length;
    }

    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const fullHtml = decoder.decode(merged);
    this._splitHtmlIntoSections(fullHtml);
    return this;
  }

  _trimTrailingEntries(rec, flags) {
    let end = rec.length;
    for (let bit = 15; bit >= 1; bit--) {
      if ((flags & (1 << bit)) !== 0) {
        const sz = this._readVarLenFromEnd(rec, end);
        if (sz > 0 && sz <= end) end -= sz;
      }
    }
    if ((flags & 1) !== 0 && end > 0) {
      const pad = (rec[end - 1] & 0x03) + 1;
      if (pad <= end) end -= pad;
    }
    return rec.subarray(0, end);
  }

  _readVarLenFromEnd(rec, end) {
    let val = 0;
    let shift = 0;
    for (let i = end - 1; i >= Math.max(0, end - 4); i--) {
      const b = rec[i];
      val |= (b & 0x7F) << shift;
      if ((b & 0x80) !== 0) return val;
      shift += 7;
    }
    return 0;
  }

  _decompressPalmDOC(input) {
    const out = [];
    let i = 0;
    const len = input.length;
    while (i < len) {
      const c = input[i++];
      if (c === 0x00 || (c >= 0x09 && c <= 0x7F)) {
        out.push(c);
      } else if (c >= 0x01 && c <= 0x08) {
        for (let j = 0; j < c && i < len; j++) {
          out.push(input[i++]);
        }
      } else if (c >= 0x80 && c <= 0xBF) {
        if (i >= len) break;
        const next = input[i++];
        const pair = (c << 8) | next;
        const dist = (pair >> 3) & 0x07FF;
        const copyLen = (pair & 0x07) + 3;
        const start = out.length - dist;
        for (let j = 0; j < copyLen; j++) {
          out.push(start + j >= 0 ? out[start + j] : 0x20);
        }
      } else if (c >= 0xC0) {
        out.push(0x20, c ^ 0x80);
      }
    }
    return new Uint8Array(out);
  }

  _splitHtmlIntoSections(rawHtml) {
    const parts = rawHtml.split(/<mbp:pagebreak\s*\/?>/i).filter((p) => p.trim().length > 0);
    const rawSections = parts.length > 0 ? parts : [rawHtml];

    this.sections = rawSections.map((htmlPart, index) => {
      const doc = new DOMParser().parseFromString(htmlPart, 'text/html');
      const headingEl = doc.querySelector('h1, h2, h3, title');
      const title = headingEl && headingEl.textContent.trim()
        ? headingEl.textContent.trim().slice(0, 48)
        : `第 ${index + 1} 节`;
      const bodyHTML = doc.body ? doc.body.innerHTML : htmlPart;

      return {
        id: `mobi_sec_${index}`,
        index,
        path: `section_${index}.xhtml`,
        title,
        loadHTML: async () => ({ headHTML: '', bodyHTML })
      };
    });

    this.toc = this.sections.map((s) => ({
      title: s.title,
      href: s.path,
      sectionIndex: s.index
    }));
  }

  destroy() {}
}
