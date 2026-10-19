// 零依赖纯浏览器端 ZIP 解包器 (内置快速 rawInflate 引擎，优雅兼容 Chrome 87 等老旧 WebView)
const u8 = Uint8Array, u16 = Uint16Array, i32 = Int32Array;
const flgArr = new u8([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0]);
const distArr = new u8([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0]);
const clenArr = new u8([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]);

function mkTab(r, e) {
  const i = new u16(31);
  for (let t = 0; t < 31; ++t) i[t] = (e += 1 << r[t - 1]);
  const f = new i32(i[30]);
  for (let t = 1; t < 30; ++t) {
    for (let o = i[t]; o < i[t + 1]; ++o) f[o] = ((o - i[t]) << 5) | t;
  }
  return { b: i, r: f };
}

const tabO = mkTab(flgArr, 2);
const flgB = tabO.b, flgR = tabO.r;
flgB[28] = 258;
flgR[258] = 28;
const distB = mkTab(distArr, 0).b;
const revMap = new u16(32768);
for (let d = 0; d < 32768; ++d) {
  let w = ((43690 & d) >> 1) | ((21845 & d) << 1);
  w = ((61680 & (w = ((52428 & w) >> 2) | ((13107 & w) << 2))) >> 4) | ((3855 & w) << 4);
  revMap[d] = (((65280 & w) >> 8) | ((255 & w) << 8)) >> 1;
}

function buildTree(r, a, e) {
  const len = r.length;
  const f = new u16(a);
  for (let t = 0; t < len; ++t) if (r[t]) ++f[r[t] - 1];
  const v = new u16(a);
  for (let t = 1; t < a; ++t) v[t] = (v[t - 1] + f[t - 1]) << 1;
  let o;
  if (e) {
    o = new u16(1 << a);
    const l = 15 - a;
    for (let t = 0; t < len; ++t) {
      if (r[t]) {
        let u = (t << 4) | r[t], d = a - r[t], w = v[r[t] - 1]++ << d, b = w | ((1 << d) - 1);
        for (; w <= b; ++w) o[revMap[w] >> l] = u;
      }
    }
  } else {
    o = new u16(len);
    for (let t = 0; t < len; ++t) if (r[t]) o[t] = revMap[v[r[t] - 1]++] >> (15 - r[t]);
  }
  return o;
}

const fixedLitBits = new u8(288);
for (let d = 0; d < 144; ++d) fixedLitBits[d] = 8;
for (let d = 144; d < 256; ++d) fixedLitBits[d] = 9;
for (let d = 256; d < 280; ++d) fixedLitBits[d] = 7;
for (let d = 280; d < 288; ++d) fixedLitBits[d] = 8;
const fixedDistBits = new u8(32);
for (let d = 0; d < 32; ++d) fixedDistBits[d] = 5;
const fixedLitTree = buildTree(fixedLitBits, 9, 1);
const fixedDistTree = buildTree(fixedDistBits, 5, 1);

function maxArr(r) {
  let m = r[0];
  for (let a = 1; a < r.length; ++a) if (r[a] > m) m = r[a];
  return m;
}

function bits(r, n, a) {
  const e = (n / 8) | 0;
  return ((r[e] | (r[e + 1] << 8)) >> (7 & n)) & a;
}

function bits16(r, n) {
  const a = (n / 8) | 0;
  return (r[a] | (r[a + 1] << 8) | (r[a + 2] << 16)) >> (7 & n);
}

function byteAlign(r) {
  return ((r + 7) / 8) | 0;
}

function rawInflate(n) {
  const l = n.length;
  if (!l) return new u8(0);
  let f = new u8(3 * l);
  const grow = (need) => {
    if (need > f.length) {
      const e = new u8(Math.max(2 * f.length, need));
      e.set(f);
      f = e;
    }
  };
  let T = 0, z = 0, A = 0, U = null, D = null, F = 0, M = 0;
  const S = 8 * l;
  do {
    if (!U) {
      T = bits(n, z, 1);
      const I = bits(n, z + 1, 3);
      z += 3;
      if (!I) {
        const P = byteAlign(z) + 4;
        const O = n[P - 4] | (n[P - 3] << 8);
        const j = P + O;
        grow(A + O);
        f.set(n.subarray(P, j), A);
        A += O;
        z = 8 * j;
        continue;
      }
      if (I === 1) {
        U = fixedLitTree; D = fixedDistTree; F = 9; M = 5;
      } else if (I === 2) {
        const q = bits(n, z, 31) + 257, B = bits(n, z + 10, 15) + 4, C = q + bits(n, z + 5, 31) + 1;
        z += 14;
        const G = new u8(C), H = new u8(19);
        for (let J = 0; J < B; ++J) H[clenArr[J]] = bits(n, z + 3 * J, 7);
        z += 3 * B;
        const K = maxArr(H), L = (1 << K) - 1, N = buildTree(H, K, 1);
        for (let J = 0; J < C;) {
          const Q = N[bits(n, z, L)];
          z += 15 & Q;
          const P = Q >> 4;
          if (P < 16) {
            G[J++] = P;
          } else {
            let R = 0, V = 0;
            if (P === 16) { V = 3 + bits(n, z, 3); z += 2; R = G[J - 1]; }
            else if (P === 17) { V = 3 + bits(n, z, 7); z += 3; }
            else if (P === 18) { V = 11 + bits(n, z, 127); z += 7; }
            for (; V--;) G[J++] = R;
          }
        }
        const W = G.subarray(0, q), X = G.subarray(q);
        F = maxArr(W); M = maxArr(X);
        U = buildTree(W, F, 1); D = buildTree(X, M, 1);
      } else {
        throw new Error('invalid block type in rawInflate');
      }
    }
    grow(A + 131072);
    const Y = (1 << F) - 1, Z = (1 << M) - 1;
    for (;;) {
      const R = U[bits16(n, z) & Y];
      const _ = R >> 4;
      z += 15 & R;
      if (_ < 256) {
        f[A++] = _;
      } else {
        if (_ === 256) { U = null; break; }
        let rr = _ - 254;
        if (_ > 264) {
          const J = _ - 257, nr = flgArr[J];
          rr = bits(n, z, (1 << nr) - 1) + flgB[J];
          z += nr;
        }
        const er = D[bits16(n, z) & Z] >> 4;
        z += 15 & D[bits16(n, z) & Z];
        let X = distB[er];
        if (er > 3) {
          const nr = distArr[er];
          X += bits16(n, z) & ((1 << nr) - 1);
          z += nr;
        }
        grow(A + 131072);
        const ir = A + rr;
        for (; A < ir; ++A) f[A] = f[A - X];
      }
    }
  } while (!T);
  return f.subarray(0, A);
}

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
        filename: fileName,
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
      // 优先尝试原生硬件流，遇老旧内核 (如 Chrome 87 报 unsupported compression format: deflate-raw) 自动优雅降级
      if (typeof DecompressionStream !== 'undefined') {
        try {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          writer.write(rawSlice);
          writer.close();
          const resp = new Response(ds.readable);
          const ab = await resp.arrayBuffer();
          return new Uint8Array(ab);
        } catch (_) {
          // 降级使用内置极速 rawInflate
        }
      }
      return rawInflate(rawSlice);
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
