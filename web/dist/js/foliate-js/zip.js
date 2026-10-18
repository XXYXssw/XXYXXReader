// 零依赖纯浏览器端 ZIP 解包器 (利用原生 DecompressionStream('deflate-raw'))
export class ZipArchive {
  constructor(arrayBuffer) {
    this.buffer = arrayBuffer;
    this.view = new DataView(arrayBuffer);
    this.bytes = new Uint8Array(arrayBuffer);
    this.entries = new Map();
    this._parseCentralDirectory();
  }

  _parseCentralDirectory() {
    const len = this.bytes.length;
    let eocdOffset = -1;
    const minOffset = Math.max(0, len - 65557);
    for (let i = len - 22; i >= minOffset; i--) {
      if (this.view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) {
      throw new Error('Invalid ZIP archive: EOCD not found');
    }

    const totalEntries = this.view.getUint16(eocdOffset + 10, true);
    const cdOffset = this.view.getUint32(eocdOffset + 16, true);
    const decoder = new TextDecoder('utf-8');

    let ptr = cdOffset;
    for (let i = 0; i < totalEntries && ptr + 46 <= len; i++) {
      const sig = this.view.getUint32(ptr, true);
      if (sig !== 0x02014b50) break;

      const compressionMethod = this.view.getUint16(ptr + 10, true);
      const compressedSize = this.view.getUint32(ptr + 20, true);
      const uncompressedSize = this.view.getUint32(ptr + 24, true);
      const nameLen = this.view.getUint16(ptr + 28, true);
      const extraLen = this.view.getUint16(ptr + 30, true);
      const commentLen = this.view.getUint16(ptr + 32, true);
      const localHeaderOffset = this.view.getUint32(ptr + 42, true);

      const nameBytes = this.bytes.subarray(ptr + 46, ptr + 46 + nameLen);
      const fileName = decoder.decode(nameBytes);

      this.entries.set(fileName, {
        fileName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      });

      ptr += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(path) {
    return this.entries.has(this._normalizePath(path));
  }

  _normalizePath(p) {
    return decodeURIComponent(p).replace(/^\/+/, '');
  }

  async extractBytes(path) {
    const norm = this._normalizePath(path);
    let entry = this.entries.get(norm);
    if (!entry) {
      for (const [k, v] of this.entries.entries()) {
        if (k.toLowerCase() === norm.toLowerCase()) {
          entry = v;
          break;
        }
      }
    }
    if (!entry) {
      throw new Error(`Entry not found in ZIP: ${norm}`);
    }

    const lh = entry.localHeaderOffset;
    if (this.view.getUint32(lh, true) !== 0x04034b50) {
      throw new Error('Invalid local file header in ZIP');
    }
    const nameLen = this.view.getUint16(lh + 26, true);
    const extraLen = this.view.getUint16(lh + 28, true);
    const dataStart = lh + 30 + nameLen + extraLen;
    const rawSlice = this.bytes.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.compressionMethod === 0) {
      return rawSlice;
    }
    if (entry.compressionMethod === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(rawSlice);
      writer.close();
      const resp = new Response(ds.readable);
      const ab = await resp.arrayBuffer();
      return new Uint8Array(ab);
    }
    throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
  }

  async extractText(path) {
    const bytes = await this.extractBytes(path);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async extractBlobUrl(path, mimeType = 'application/octet-stream') {
    const bytes = await this.extractBytes(path);
    const blob = new Blob([bytes], { type: mimeType });
    return URL.createObjectURL(blob);
  }
}
