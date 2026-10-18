// Foliate-core EPUB 2 / EPUB 3 解析器与章节资源重写引擎
import { ZipArchive } from './zip.js';

function resolvePath(baseDir, relHref) {
  if (!relHref || /^(https?:|data:|blob:|mailto:|#)/i.test(relHref)) return relHref;
  const [cleanPath, hash] = relHref.split('#');
  const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const part of cleanPath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const joined = stack.join('/');
  return hash ? `${joined}#${hash}` : joined;
}

function getDir(filePath) {
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(0, idx) : '';
}

export class EPUBBook {
  constructor(arrayBuffer) {
    this.zip = new ZipArchive(arrayBuffer);
    this.blobUrlCache = new Map();
    this.metadata = { title: '', author: '', description: '' };
    this.toc = [];
    this.sections = [];
  }

  async init() {
    const containerXml = await this.zip.extractText('META-INF/container.xml');
    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(containerXml, 'application/xml');
    const rootfileEl = containerDoc.querySelector('rootfile');
    if (!rootfileEl) throw new Error('Invalid EPUB: missing rootfile');

    const opfPath = rootfileEl.getAttribute('full-path');
    const opfDir = getDir(opfPath);
    const opfXml = await this.zip.extractText(opfPath);
    const opfDoc = parser.parseFromString(opfXml, 'application/xml');

    // 1. 提取元数据
    const titleEl = opfDoc.querySelector('metadata title, metadata *|title');
    const creatorEl = opfDoc.querySelector('metadata creator, metadata *|creator');
    const descEl = opfDoc.querySelector('metadata description, metadata *|description');
    this.metadata.title = titleEl ? titleEl.textContent.trim() : '';
    this.metadata.author = creatorEl ? creatorEl.textContent.trim() : '';
    this.metadata.description = descEl ? descEl.textContent.trim() : '';

    // 2. 构建 Manifest 映射
    const manifest = new Map();
    let navHref = null;
    let ncxHref = null;

    for (const item of opfDoc.querySelectorAll('manifest > item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href') || '';
      const mediaType = item.getAttribute('media-type') || '';
      const props = item.getAttribute('properties') || '';
      const fullPath = resolvePath(opfDir, href);

      manifest.set(id, { id, href, fullPath, mediaType, props });
      if (props.split(/\s+/).includes('nav')) navHref = fullPath;
      if (mediaType === 'application/x-dtbncx+xml') ncxHref = fullPath;
    }

    // 3. 解析目录 TOC (优先 EPUB 3 Nav，回退 NCX)
    if (navHref && this.zip.has(navHref)) {
      await this._parseNavToc(navHref);
    } else if (ncxHref && this.zip.has(ncxHref)) {
      await this._parseNcxToc(ncxHref);
    }

    // 4. 构建 Spine 章节序列
    const spineItems = Array.from(opfDoc.querySelectorAll('spine > itemref'));
    this.sections = spineItems.map((itemref, index) => {
      const idref = itemref.getAttribute('idref');
      const mItem = manifest.get(idref);
      if (!mItem) return null;

      const matchedToc = this._findTocTitle(mItem.fullPath);
      return {
        id: idref,
        index,
        path: mItem.fullPath,
        title: matchedToc || `第 ${index + 1} 节`,
        loadHTML: () => this._loadProcessedChapter(mItem.fullPath)
      };
    }).filter(Boolean);

    // 若无显式 TOC，使用章节列表生成默认目录
    if (this.toc.length === 0) {
      this.toc = this.sections.map((s) => ({
        title: s.title,
        href: s.path,
        sectionIndex: s.index
      }));
    } else {
      for (const item of this.toc) {
        const cleanHref = item.href.split('#')[0];
        const sec = this.sections.find((s) => s.path === cleanHref);
        item.sectionIndex = sec ? sec.index : 0;
      }
    }

    return this;
  }

  _findTocTitle(fullPath) {
    for (const t of this.toc) {
      const [hPath] = t.href.split('#');
      if (hPath === fullPath) return t.title;
    }
    return '';
  }

  async _parseNavToc(navFullPath) {
    try {
      const navDir = getDir(navFullPath);
      const raw = await this.zip.extractText(navFullPath);
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const navEl = doc.querySelector('nav[*|type="toc"], nav#toc, nav');
      if (!navEl) return;
      for (const a of navEl.querySelectorAll('a[href]')) {
        const title = a.textContent.trim();
        const href = resolvePath(navDir, a.getAttribute('href'));
        if (title) this.toc.push({ title, href, sectionIndex: 0 });
      }
    } catch (_) {
      // 忽略目录解析异常
    }
  }

  async _parseNcxToc(ncxFullPath) {
    try {
      const ncxDir = getDir(ncxFullPath);
      const raw = await this.zip.extractText(ncxFullPath);
      const doc = new DOMParser().parseFromString(raw, 'application/xml');
      for (const np of doc.querySelectorAll('navPoint')) {
        const labelEl = np.querySelector('navLabel > text');
        const contentEl = np.querySelector('content');
        if (labelEl && contentEl) {
          const title = labelEl.textContent.trim();
          const src = contentEl.getAttribute('src') || '';
          if (title && src) {
            this.toc.push({
              title,
              href: resolvePath(ncxDir, src),
              sectionIndex: 0
            });
          }
        }
      }
    } catch (_) {
      // 忽略目录解析异常
    }
  }

  async _getAssetBlobUrl(fullPath, mime = 'application/octet-stream') {
    const clean = fullPath.split('#')[0];
    if (this.blobUrlCache.has(clean)) return this.blobUrlCache.get(clean);
    if (!this.zip.has(clean)) return null;
    const url = await this.zip.extractBlobUrl(clean, mime);
    this.blobUrlCache.set(clean, url);
    return url;
  }

  async _loadProcessedChapter(chapterPath) {
    const chDir = getDir(chapterPath);
    const rawHtml = await this.zip.extractText(chapterPath);
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

    // 内联样式表
    for (const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
      const cssPath = resolvePath(chDir, link.getAttribute('href'));
      if (this.zip.has(cssPath)) {
        try {
          const cssText = await this.zip.extractText(cssPath);
          const styleEl = doc.createElement('style');
          styleEl.textContent = cssText;
          link.replaceWith(styleEl);
        } catch (_) {
          link.remove();
        }
      } else {
        link.remove();
      }
    }

    // 替换章节内图片与 SVG 引用为 Blob URL
    for (const img of Array.from(doc.querySelectorAll('img[src], image[href], image[*|href]'))) {
      const attr = img.hasAttribute('src') ? 'src' : (img.hasAttribute('href') ? 'href' : 'xlink:href');
      const rawSrc = img.getAttribute(attr);
      if (!rawSrc || /^(data:|blob:|https?:)/i.test(rawSrc)) continue;
      const imgPath = resolvePath(chDir, rawSrc);
      const ext = imgPath.split('.').pop().toLowerCase();
      const mimeMap = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml'
      };
      const blobUrl = await this._getAssetBlobUrl(imgPath, mimeMap[ext] || 'image/jpeg');
      if (blobUrl) img.setAttribute(attr, blobUrl);
    }

    return {
      headHTML: doc.head ? doc.head.innerHTML : '',
      bodyHTML: doc.body ? doc.body.innerHTML : rawHtml
    };
  }

  destroy() {
    for (const url of this.blobUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrlCache.clear();
  }
}
