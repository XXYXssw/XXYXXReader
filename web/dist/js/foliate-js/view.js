// Foliate-core <foliate-view> 统一流式阅读 Web Component
// 支持：Shadow DOM + iframe 样式穿透、三模翻页(0ms瞬切/水平滑动/连续滚动)、四色印彩高亮图层、二维九宫格热区转发
import { EPUBBook } from './epub.js?v=2.0.2';
import { MOBIBook } from './mobi.js?v=2.0.2';
import { CFIEngine } from './cfi.js';
import { ThemeManager } from '../theme.js';

export class FoliateView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.book = null;
    this.currentSectionIndex = 0;
    this.currentPage = 0;
    this.totalPagesInSection = 1;
    this.annotations = [];

    this.settings = {
      flipMode: 'instant_tap', // instant_tap | horiz_slide | continuous
      fontSize: 19,
      fontFamily: 'serif',     // serif | kaiti | sans | system
      lineHeight: 1.8,
      margin: 28,              // 12 | 28 | 48
      indent: true,
      justify: true
    };

    this._renderShadowShell();
  }

  _renderShadowShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          position: relative;
          overflow: hidden;
        }
        .stage {
          width: 100%;
          height: 100%;
          position: relative;
          overflow: hidden;
        }
        iframe {
          width: 100%;
          height: 100%;
          border: none;
          display: block;
          background: transparent;
        }
      </style>
      <div class="stage">
        <iframe id="chapter-frame"></iframe>
      </div>
    `;
    this.iframe = this.shadowRoot.getElementById('chapter-frame');
    this._lastTapTime = 0;
  }

  _emitTap(xRatio, yRatio, origEvent) {
    const now = Date.now();
    if (this._lastTapTime && (now - this._lastTapTime < 380)) {
      return;
    }
    this._lastTapTime = now;
    this.dispatchEvent(new CustomEvent('viewport-tap', {
      detail: { xRatio, yRatio, originalEvent: origEvent }
    }));
  }

  async openBuffer(arrayBuffer, fileType = 'epub') {
    if (this.book) {
      this.book.destroy();
    }
    if (fileType === 'azw3' || fileType === 'mobi') {
      this.book = new MOBIBook(arrayBuffer);
    } else {
      this.book = new EPUBBook(arrayBuffer);
    }
    await this.book.init();
    return {
      metadata: this.book.metadata,
      toc: this.book.toc,
      sectionCount: this.book.sections.length
    };
  }

  async goToSection(index, targetPageRatio = 0) {
    if (!this.book || !this.book.sections.length) return;
    const clamped = Math.max(0, Math.min(index, this.book.sections.length - 1));
    this.currentSectionIndex = clamped;
    const sec = this.book.sections[clamped];
    const { headHTML, bodyHTML } = await sec.loadHTML();

    const doc = this.iframe.contentDocument;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${headHTML}
  <style id="xxyxx-injected-style"></style>
</head>
<body>
  <div id="xxyxx-reader-root">${bodyHTML}</div>
</body>
</html>`);
    doc.close();

    this._applyIframeStyles();
    this._bindIframeEvents();
    this.renderAnnotationsInCurrentSection();

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    this._recalculatePagination();

    if (this.settings.flipMode === 'continuous') {
      const maxScroll = Math.max(0, doc.documentElement.scrollHeight - this.iframe.clientHeight);
      doc.documentElement.scrollTop = Math.round(maxScroll * targetPageRatio);
    } else {
      if (targetPageRatio >= 0.99) {
        this.currentPage = Math.max(0, this.totalPagesInSection - 1);
      } else {
        this.currentPage = Math.min(
          this.totalPagesInSection - 1,
          Math.max(0, Math.floor(targetPageRatio * this.totalPagesInSection))
        );
      }
      this._applyPageOffset(false);
    }
    this._emitRelocate();
  }

  async goToCFI(cfi, fallbackPercent = 0) {
    if (!this.book || !this.book.sections.length) return;
    if (cfi && cfi.startsWith('epubcfi(')) {
      const secIdx = CFIEngine.parseSectionIndex(cfi);
      const pageMatch = cfi.match(/\[p:(\d+)\/(\d+)\]/);
      let ratio = 0;
      if (pageMatch) {
        const p = parseInt(pageMatch[1], 10);
        const total = Math.max(1, parseInt(pageMatch[2], 10));
        ratio = p / total;
      }
      await this.goToSection(secIdx, ratio);
      return;
    }
    if (fallbackPercent > 0) {
      await this.goToPercent(fallbackPercent);
    } else {
      await this.goToSection(0, 0);
    }
  }

  async goToPercent(percent) {
    if (!this.book || !this.book.sections.length) return;
    const ratio = Math.max(0, Math.min(100, percent)) / 100;
    const exactSec = ratio * this.book.sections.length;
    const secIdx = Math.min(this.book.sections.length - 1, Math.floor(exactSec));
    const remRatio = exactSec - secIdx;
    await this.goToSection(secIdx, remRatio);
  }

  async next() {
    if (!this.book) return;
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    if (this.settings.flipMode === 'continuous') {
      const step = this.iframe.clientHeight * 0.85;
      const maxScroll = doc.documentElement.scrollHeight - this.iframe.clientHeight;
      if (doc.documentElement.scrollTop + 12 < maxScroll) {
        doc.documentElement.scrollTop += step;
        this._emitRelocate();
      } else if (this.currentSectionIndex + 1 < this.book.sections.length) {
        await this.goToSection(this.currentSectionIndex + 1, 0);
      }
      return;
    }

    this._recalculatePagination();
    if (this.currentPage + 1 < this.totalPagesInSection) {
      this.currentPage += 1;
      this._applyPageOffset(true);
      this._emitRelocate();
    } else if (this.currentSectionIndex + 1 < this.book.sections.length) {
      await this.goToSection(this.currentSectionIndex + 1, 0);
    }
  }

  async prev() {
    if (!this.book) return;
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    if (this.settings.flipMode === 'continuous') {
      const step = this.iframe.clientHeight * 0.85;
      if (doc.documentElement.scrollTop > 10) {
        doc.documentElement.scrollTop = Math.max(0, doc.documentElement.scrollTop - step);
        this._emitRelocate();
      } else if (this.currentSectionIndex > 0) {
        await this.goToSection(this.currentSectionIndex - 1, 1);
      }
      return;
    }

    this._recalculatePagination();
    if (this.currentPage > 0) {
      this.currentPage -= 1;
      this._applyPageOffset(true);
      this._emitRelocate();
    } else if (this.currentSectionIndex > 0) {
      await this.goToSection(this.currentSectionIndex - 1, 1);
    }
  }

  updateSettings(partial) {
    Object.assign(this.settings, partial);
    this._applyIframeStyles();
    this._recalculatePagination();
    this._applyPageOffset(false);
    this._emitRelocate();
  }

  setAnnotations(list) {
    this.annotations = Array.isArray(list) ? list : [];
    this.renderAnnotationsInCurrentSection();
  }

  _applyIframeStyles() {
    const doc = this.iframe.contentDocument;
    if (!doc) return;
    const styleEl = doc.getElementById('xxyxx-injected-style');
    if (!styleEl) return;

    const palette = ThemeManager.getPalette();
    const fontMap = {
      serif: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", Georgia, serif',
      kaiti: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif CJK SC", serif',
      sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      system: 'system-ui, -apple-system, sans-serif'
    };
    const fontStack = fontMap[this.settings.fontFamily] || fontMap.serif;
    const isContinuous = this.settings.flipMode === 'continuous';
    const isEinkOrInstant = palette.isEink || this.settings.flipMode === 'instant_tap';

    const viewW = Math.max(320, this.iframe.clientWidth || window.innerWidth);
    const viewH = Math.max(300, this.iframe.clientHeight || window.innerHeight);
    const padX = this.settings.margin !== undefined ? Math.max(0, Number(this.settings.margin)) : 28;
    const padY = 24;
    const colWidth = Math.max(160, viewW - padX * 2);
    const colGap = padX * 2;

    // 垂直整行网格对齐计算：严格保证栏高为整数行高，彻底杜绝半行字截断与跨页错行
    const rawH = viewH - padY * 2;
    const lineHeightPx = Number(this.settings.fontSize) * Number(this.settings.lineHeight);
    const exactLines = Math.max(5, Math.floor(rawH / lineHeightPx));
    const fittedH = Math.round(exactLines * lineHeightPx);
    const topPad = Math.round(padY + (rawH - fittedH) / 2);

    styleEl.textContent = `
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        color: ${palette.fg} !important;
        background: transparent !important;
        font-family: ${fontStack} !important;
        font-size: ${this.settings.fontSize}px !important;
        -webkit-font-smoothing: antialiased;
      }
      ${isContinuous ? `
      html {
        overflow-x: hidden !important;
        overflow-y: auto !important;
      }
      #xxyxx-reader-root {
        box-sizing: border-box !important;
        width: 100% !important;
        max-width: 100% !important;
        margin: 0 auto !important;
        padding: 32px ${padX}px 64px !important;
      }
      ` : `
      html, body {
        width: 100% !important;
        height: ${viewH}px !important;
        overflow: hidden !important;
      }
      #xxyxx-reader-root {
        box-sizing: content-box !important;
        width: ${colWidth}px !important;
        height: ${fittedH}px !important;
        margin: ${topPad}px 0 0 ${padX}px !important;
        padding: 0 !important;
        column-width: ${colWidth}px !important;
        column-gap: ${colGap}px !important;
        column-fill: auto !important;
        transition: ${isEinkOrInstant ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)'} !important;
        will-change: transform;
      }
      `}

      /* 穿透覆盖 EPUB 内自带的所有标签与类名行距与字体 */
      #xxyxx-reader-root,
      #xxyxx-reader-root p,
      #xxyxx-reader-root div,
      #xxyxx-reader-root span,
      #xxyxx-reader-root li,
      #xxyxx-reader-root blockquote,
      #xxyxx-reader-root a {
        font-family: ${fontStack} !important;
        line-height: ${this.settings.lineHeight} !important;
      }

      /* 穿透压制 EPUB 内置写死的最大宽度与自动外边距，彻底粉碎两边固定多余留白 */
      #xxyxx-reader-root,
      #xxyxx-reader-root > *,
      #xxyxx-reader-root p,
      #xxyxx-reader-root div,
      #xxyxx-reader-root blockquote,
      #xxyxx-reader-root .content,
      #xxyxx-reader-root [class*="content"],
      #xxyxx-reader-root [class*="calibre"] {
        padding-left: 0 !important;
        padding-right: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        box-sizing: border-box !important;
        max-width: 100% !important;
      }

      #xxyxx-reader-root h1,
      #xxyxx-reader-root h2,
      #xxyxx-reader-root h3,
      #xxyxx-reader-root h4,
      #xxyxx-reader-root h5,
      #xxyxx-reader-root h6 {
        color: ${palette.fg} !important;
        font-family: ${fontStack} !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        text-indent: 0 !important;
        line-height: 1.35 !important;
        break-inside: avoid;
      }

      /* 穿透覆盖 EPUB 段落的外边距、对齐与缩进 */
      #xxyxx-reader-root p,
      #xxyxx-reader-root .content,
      #xxyxx-reader-root [class*="content"] {
        margin-top: 0.55em !important;
        margin-bottom: 0.55em !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        text-indent: ${this.settings.indent ? '2em' : '0'} !important;
        text-align: ${this.settings.justify ? 'justify' : 'left'} !important;
      }
      img, svg {
        max-width: 100% !important;
        max-height: ${viewH - 80}px !important;
        height: auto !important;
        display: block;
        margin: 12px auto;
        break-inside: avoid;
      }
      blockquote {
        margin: 1em 0 !important;
        padding: 8px 14px !important;
        border-left: 3px solid ${palette.accent} !important;
        background: ${palette.quoteBg} !important;
        color: ${palette.muted} !important;
      }
      mark.xxyxx-highlight {
        color: inherit;
        padding: 1px 0;
        border-radius: 2px;
        cursor: pointer;
      }
      mark.xxyxx-highlight[data-color="zhusha"] {
        background: rgba(194, 53, 49, 0.24);
        border-bottom: 2px solid #c23531;
      }
      mark.xxyxx-highlight[data-color="zhuqing"] {
        background: rgba(49, 112, 86, 0.24);
        border-bottom: 2px solid #317056;
      }
      mark.xxyxx-highlight[data-color="songyan"] {
        background: rgba(92, 96, 104, 0.24);
        border-bottom: 2px solid #5c6068;
      }
      mark.xxyxx-highlight[data-color="qiukui"] {
        background: rgba(184, 134, 11, 0.24);
        border-bottom: 2px solid #b8860b;
      }
    `;
  }

  _recalculatePagination() {
    const doc = this.iframe.contentDocument;
    if (!doc) return;
    const root = doc.getElementById('xxyxx-reader-root');
    if (!root) return;

    if (this.settings.flipMode === 'continuous') {
      this.totalPagesInSection = 1;
      this.currentPage = 0;
      root.style.transform = 'none';
      return;
    }

    void root.offsetWidth; // 触发同步重排以获取最新的真实 scrollWidth
    const viewW = Math.max(320, this.iframe.clientWidth || window.innerWidth);
    const padX = this.settings.margin !== undefined ? Math.max(0, Number(this.settings.margin)) : 28;
    const colWidth = Math.max(160, viewW - padX * 2);
    const colGap = padX * 2;
    const pitch = colWidth + colGap;
    const scrollW = Math.max(colWidth, root.scrollWidth);
    this.totalPagesInSection = Math.max(1, Math.ceil((scrollW + colGap * 0.5) / pitch));
    if (this.currentPage >= this.totalPagesInSection) {
      this.currentPage = this.totalPagesInSection - 1;
    }
  }

  _applyPageOffset(animate = true) {
    const doc = this.iframe.contentDocument;
    if (!doc) return;
    const root = doc.getElementById('xxyxx-reader-root');
    if (!root) return;

    if (this.settings.flipMode === 'continuous') {
      root.style.transform = 'none';
      return;
    }
    const palette = ThemeManager.getPalette();
    const shouldAnimate = animate && !palette.isEink && this.settings.flipMode === 'horiz_slide';
    root.style.transition = shouldAnimate ? 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';

    const viewW = Math.max(320, this.iframe.clientWidth || window.innerWidth);
    const offset = -this.currentPage * viewW;
    root.style.transform = `translate3d(${offset}px, 0, 0)`;
  }

  _bindIframeEvents() {
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    // 1. 转发键盘事件至外层 window
    doc.addEventListener('keydown', (e) => {
      this.dispatchEvent(new CustomEvent('reader-keydown', {
        detail: { key: e.key, keyCode: e.keyCode, originalEvent: e }
      }));
    }, true);
    doc.addEventListener('keyup', (e) => {
      this.dispatchEvent(new CustomEvent('reader-keydown', {
        detail: { key: e.key, keyCode: e.keyCode, originalEvent: e }
      }));
    }, true);

    // 2. 监听选词完成事件（触发四色印彩浮层，兼容移动端与桌面端）
    let selectionJustHappened = false;
    let selectionDebounceTimer = null;

    const handleSelectionEnd = () => {
      clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = setTimeout(() => {
        try {
          const sel = doc.getSelection();
          if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
          const range = sel.getRangeAt(0);
          const cfiData = CFIEngine.fromRange(range, this.currentSectionIndex);
          if (!cfiData) return;

          selectionJustHappened = true;
          setTimeout(() => { selectionJustHappened = false; }, 320);

          const rect = range.getBoundingClientRect();
          const frameRect = this.iframe.getBoundingClientRect();
          const clientX = frameRect.left + (rect.width ? rect.left + rect.width / 2 : (rect.left || window.innerWidth / 2));
          const clientY = frameRect.top + (rect.bottom || (rect.top + 24));

          this.dispatchEvent(new CustomEvent('text-selected', {
            detail: {
              ...cfiData,
              chapterIndex: this.currentSectionIndex,
              chapterTitle: this.getCurrentChapterTitle(),
              clientX,
              clientY
            }
          }));
        } catch (err) {
          console.warn('[xxyxx-reader] selection error:', err);
        }
      }, 90);
    };

    doc.addEventListener('mouseup', handleSelectionEnd);
    doc.addEventListener('touchend', () => {
      handleSelectionEnd();
      setTimeout(handleSelectionEnd, 140);
    });
    doc.addEventListener('selectionchange', () => {
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        clearTimeout(selectionDebounceTimer);
        selectionDebounceTimer = setTimeout(handleSelectionEnd, 320);
      }
    });
    doc.addEventListener('contextmenu', () => {
      setTimeout(handleSelectionEnd, 120);
    });

    // 3. 移动端滑动与点按 (Tap) 统一手势处理
    let touchStartX = null;
    let touchStartY = null;
    let touchStartTime = 0;

    doc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
      }
    }, { passive: true });

    doc.addEventListener('touchend', (e) => {
      if (touchStartX === null || e.changedTouches.length === 0) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - touchStartX;
      const dy = endY - touchStartY;
      const dt = Date.now() - touchStartTime;
      touchStartX = null;
      touchStartY = null;

      // 如果当前正在选词或有选区，避让翻页
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;

      // 滑动手势 (dx > 38px 触发上一页/下一页)
      if (Math.abs(dx) > 38 && Math.abs(dx) > Math.abs(dy) * 1.3 && this.settings.flipMode !== 'continuous') {
        if (dx < 0) this.next();
        else this.prev();
        return;
      }

      // 点按手势 (微小位移且用时短，直接触发九宫格热区判定)
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18 && dt < 450) {
        const target = e.target;
        if (target && target.closest && (target.closest('a[href]') || target.closest('mark.xxyxx-highlight'))) {
          return;
        }
        const viewW = this.iframe.clientWidth || window.innerWidth;
        const viewH = this.iframe.clientHeight || window.innerHeight;
        this._emitTap(endX / viewW, endY / viewH, e);
      }
    }, { passive: true });

    // 4. 点击事件（已有高亮点击编辑，或二维九宫格触控热区判定）
    doc.addEventListener('click', (e) => {
      if (selectionJustHappened) return;

      const markEl = e.target.closest && e.target.closest('mark.xxyxx-highlight');
      if (markEl) {
        e.stopPropagation();
        const annId = markEl.getAttribute('data-ann-id');
        const rect = markEl.getBoundingClientRect();
        const frameRect = this.iframe.getBoundingClientRect();
        this.dispatchEvent(new CustomEvent('annotation-clicked', {
          detail: {
            id: annId,
            clientX: frameRect.left + rect.left + rect.width / 2,
            clientY: frameRect.top + rect.bottom
          }
        }));
        return;
      }

      if (e.target.closest && e.target.closest('a[href]')) return;

      const viewW = this.iframe.clientWidth || window.innerWidth;
      const viewH = this.iframe.clientHeight || window.innerHeight;
      this._emitTap(e.clientX / viewW, e.clientY / viewH, e);
    });

    // 5. 连续滚动模式下更新进度
    doc.addEventListener('scroll', () => {
      if (this.settings.flipMode === 'continuous') {
        this._emitRelocate();
      }
    }, { passive: true });
  }

  renderAnnotationsInCurrentSection() {
    const doc = this.iframe.contentDocument;
    if (!doc) return;
    const root = doc.getElementById('xxyxx-reader-root');
    if (!root) return;

    // 清理旧的包裹标签
    for (const oldMark of Array.from(root.querySelectorAll('mark.xxyxx-highlight'))) {
      const parent = oldMark.parentNode;
      while (oldMark.firstChild) parent.insertBefore(oldMark.firstChild, oldMark);
      parent.removeChild(oldMark);
      parent.normalize();
    }

    const secAnns = this.annotations.filter((a) => {
      if (typeof a.chapter_index === 'number' && a.chapter_index === this.currentSectionIndex) {
        return true;
      }
      return CFIEngine.parseSectionIndex(a.cfi) === this.currentSectionIndex;
    });

    for (const ann of secAnns) {
      this._highlightTextInRoot(doc, root, ann);
    }
  }

  _highlightTextInRoot(doc, root, ann) {
    const target = (ann.selected_text || '').trim();
    if (!target) return;

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(target);
      if (idx >= 0) {
        try {
          const range = doc.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + target.length);
          const mark = doc.createElement('mark');
          mark.className = 'xxyxx-highlight';
          mark.setAttribute('data-ann-id', ann.id);
          mark.setAttribute('data-color', ann.color || 'zhusha');
          if (ann.note) mark.title = ann.note;
          range.surroundContents(mark);
          return;
        } catch (_) {}
      }
    }
  }

  getCurrentChapterTitle() {
    if (!this.book || !this.book.sections[this.currentSectionIndex]) return '';
    return this.book.sections[this.currentSectionIndex].title;
  }

  _emitRelocate() {
    if (!this.book || !this.book.sections.length) return;
    const secCount = this.book.sections.length;
    let withinSecRatio = 0;

    if (this.settings.flipMode === 'continuous') {
      const doc = this.iframe.contentDocument;
      if (doc) {
        const maxScroll = Math.max(1, doc.documentElement.scrollHeight - this.iframe.clientHeight);
        withinSecRatio = Math.min(1, Math.max(0, doc.documentElement.scrollTop / maxScroll));
      }
    } else {
      withinSecRatio = this.totalPagesInSection > 1
        ? this.currentPage / (this.totalPagesInSection - 1)
        : 1;
    }

    const overallRatio = (this.currentSectionIndex + withinSecRatio / Math.max(1, this.totalPagesInSection)) / secCount;
    const percent = Math.min(100, Math.max(0, Number((overallRatio * 100).toFixed(1))));
    const spineStep = (this.currentSectionIndex + 1) * 2;
    const cfi = `epubcfi(/6/${spineStep}![p:${this.currentPage}/${this.totalPagesInSection}])`;
    const chapterTitle = this.getCurrentChapterTitle();

    this.dispatchEvent(new CustomEvent('relocate', {
      detail: {
        sectionIndex: this.currentSectionIndex,
        sectionCount: secCount,
        page: this.currentPage + 1,
        totalPages: this.totalPagesInSection,
        percent,
        cfi,
        chapterTitle
      }
    }));
  }

  clearSelection() {
    try {
      const doc = this.iframe?.contentDocument;
      if (doc) {
        const sel = doc.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      }
      const winSel = window.getSelection();
      if (winSel && winSel.removeAllRanges) winSel.removeAllRanges();
    } catch (_) {}
  }
}

if (!customElements.get('foliate-view')) {
  customElements.define('foliate-view', FoliateView);
}
