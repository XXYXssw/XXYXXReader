// Foliate-core 工业级流式排版阅读引擎（基于 johnfactotum/foliate-js 原版核心）
// 支持：Paginator CSS Grid 视口留白架构、全格式 (EPUB 2/3, MOBI, KF8/AZW3)、双模排版 (流式分页/连续滚动)
import { View, makeBook } from './foliate-core-view.js';
import { ThemeManager } from '../theme.js';
import { Overlayer } from './overlayer.js';

export class FoliateView extends View {
  constructor() {
    super();
    this.settings = {
      flipMode: 'instant_tap',
      fontSize: 19,
      fontFamily: 'serif',
      lineHeight: 1.8,
      margin: 28,
      indent: true,
      justify: true
    };
    this.annotations = [];
    this._lastTapTime = 0;
    this._customStyles = '';

    // 监听官方原生 relocate 事件，映射转换给外层阅读器宿主（带重入阻断）
    this.addEventListener('relocate', (e) => {
      if (e.detail?.__xxyxx) return;
      e.stopImmediatePropagation();

      const { fraction, location, tocItem, cfi } = e.detail || {};
      const pct = typeof fraction === 'number' ? fraction * 100 : 0;
      const page = location?.current || 1;
      const totalPages = location?.total || 1;
      const chapterTitle = tocItem?.label || tocItem?.title || '';
      const sectionIndex = this.renderer?.currentSection?.index ?? 0;

      this.dispatchEvent(new CustomEvent('relocate', {
        detail: {
          page,
          totalPages,
          percent: pct,
          cfi: typeof cfi === 'string' ? cfi : (this.lastLocation?.cfi || ''),
          chapterTitle,
          sectionIndex,
          __xxyxx: true
        }
      }));
    }, true);

    // 监听章节加载事件，在当前文档层绑定点按热区、选词划线与墨水屏物理键转发
    this.addEventListener('load', (e) => {
      const { doc, index } = e.detail;
      if (!doc) return;
      this._bindDocEvents(doc, index);
      this.renderAnnotationsInCurrentSection();
    });
  }

  setAnnotations(list) {
    this.annotations = Array.isArray(list) ? list : [];
    this.renderAnnotationsInCurrentSection();
  }

  renderAnnotationsInCurrentSection() {
    if (!this.annotations || !this.annotations.length) return;
    try {
      for (const ann of this.annotations) {
        if (ann.cfi) {
          this.addAnnotation({ value: ann.cfi, color: ann.color || 'zhusha', id: ann.id });
        }
      }
    } catch (_) {}
  }

  get currentSectionIndex() {
    return this.renderer?.currentSection?.index ?? 0;
  }

  async openBuffer(arrayBuffer, fileType = 'epub') {
    console.log('[XXYXX-FOLIATE] openBuffer called, size:', arrayBuffer.byteLength, 'type:', fileType);
    if (this.book) {
      try { this.close(); } catch (_) {}
    }

    const ext = (fileType === 'azw3' || fileType === 'mobi') ? fileType : 'epub';
    const mime = ext === 'epub' ? 'application/epub+zip' : 'application/x-mobipocket-ebook';
    const blob = new Blob([arrayBuffer], { type: mime });
    const file = new File([blob], `book.${ext}`);

    try {
      // 调用官方原生 makeBook & open
      await this.open(file);
      console.log('[XXYXX-FOLIATE] book opened, sections:', this.book.sections?.length);

      // 应用当前排版与留白设置
      this.updateSettings(this.settings);

      // 展卷第一页
      await this.init({ showTextStart: true });
      console.log('[XXYXX-FOLIATE] init done');
    } catch (err) {
      console.error('[XXYXX-FOLIATE-ERR] open failed:', err.message, err.stack);
      throw err;
    }

    return {
      toc: this.book.toc || [],
      sectionCount: this.book.sections?.length || 1
    };
  }

  updateSettings(partial = {}) {
    Object.assign(this.settings, partial);
    if (!this.renderer) return;

    // 1. 排版流引擎 (分页 paginated / 连续滚动 scrolled)
    const flow = this.settings.flipMode === 'continuous' ? 'scrolled' : 'paginated';
    this.renderer.setAttribute('flow', flow);

    // 2. 版心左右留白控制 (直接作用于 Paginator 的 side-pad，由 Grid 绝对均分，清空外层 padding)
    const rawMargin = this.settings.margin !== undefined ? Math.max(0, Number(this.settings.margin)) : 28;
    this.style.paddingLeft = '0';
    this.style.paddingRight = '0';
    this.renderer.setAttribute('side-pad', `${rawMargin}px`);
    this.renderer.setAttribute('margin', '0px');
    this.renderer.setAttribute('gap', '0%');
    this.renderer.setAttribute('max-inline-size', '820px');

    // 3. 全局穿透 CSS (字号、行距、字体栈、两端对齐、段首缩进、主题配色)
    const palette = ThemeManager.getPalette();
    const fontMap = {
      serif: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", Georgia, serif',
      kaiti: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif CJK SC", serif',
      sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      system: 'system-ui, -apple-system, sans-serif'
    };
    const fontStack = fontMap[this.settings.fontFamily] || fontMap.serif;

    const customCSS = `
      html, body {
        color: ${palette.fg} !important;
        background: transparent !important;
        font-family: ${fontStack} !important;
        font-size: ${this.settings.fontSize}px !important;
        -webkit-font-smoothing: antialiased;
      }
      p, li, blockquote, dd, div {
        line-height: ${this.settings.lineHeight} !important;
        text-align: ${this.settings.justify ? 'justify' : 'left'} !important;
      }
      p {
        text-indent: ${this.settings.indent ? '2em' : '0'} !important;
        margin-top: 0.55em !important;
        margin-bottom: 0.55em !important;
      }
      h1, h2, h3, h4, h5, h6 {
        color: ${palette.fg} !important;
        font-family: ${fontStack} !important;
        line-height: 1.35 !important;
        break-inside: avoid;
      }
      img, svg {
        max-width: 100% !important;
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
      /* 四色印彩高亮样式 */
      mark.xxyxx-highlight {
        color: inherit;
        padding: 1px 0;
        border-radius: 2px;
        cursor: pointer;
      }
      mark.xxyxx-highlight[data-color="zhusha"] {
        background: rgba(184, 51, 42, 0.24);
        border-bottom: 2px solid #b8332a;
      }
      mark.xxyxx-highlight[data-color="zhuqing"] {
        background: rgba(46, 125, 90, 0.24);
        border-bottom: 2px solid #2e7d5a;
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

    this._customStyles = customCSS;
    if (this.renderer.setStyles) {
      this.renderer.setStyles(customCSS);
    }
  }

  async goToCFI(cfi, percent) {
    if (cfi && typeof cfi === 'string' && cfi.startsWith('epubcfi(')) {
      try {
        await this.goTo(cfi);
        return;
      } catch (_) {}
    }
    if (percent !== undefined && percent !== null && Number(percent) > 0) {
      try {
        await this.goToFraction(Number(percent) / 100);
        return;
      } catch (_) {}
    }
    try {
      await this.goTo(0);
    } catch (_) {}
  }

  async goToSection(index, targetRatio = 0) {
    if (!this.book || !this.book.sections || !this.book.sections[index]) return;
    const sec = this.book.sections[index];
    if (sec.href) {
      await this.goTo(sec.href);
    } else {
      await this.renderer?.goTo?.({ index, anchor: targetRatio });
    }
  }

  async goToPercent(percent) {
    await this.goToFraction(Math.max(0, Math.min(100, Number(percent))) / 100);
  }

  _bindDocEvents(doc, sectionIndex) {
    // 换算 iframe 内部坐标为全局真实屏幕坐标
    const getScreenCoords = (clientX, clientY) => {
      let fLeft = 0, fTop = 0;
      try {
        const frame = doc.defaultView?.frameElement;
        if (frame) {
          const fr = frame.getBoundingClientRect();
          fLeft = fr.left;
          fTop = fr.top;
        }
      } catch (_) {}
      return {
        x: fLeft + clientX,
        y: fTop + clientY
      };
    };

    // 1. 键盘与实体按键转发至父层
    doc.addEventListener('keydown', (e) => {
      this.dispatchEvent(new CustomEvent('reader-keydown', {
        detail: { key: e.key, keyCode: e.keyCode, originalEvent: e }
      }));
    });

    // 2. 移动端滑动与九宫格点按 (Tap) 统一手势判定
    let touchStartX = null, touchStartY = null, touchStartTime = 0;

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
      touchStartX = null; touchStartY = null;

      // 文本选词状态下避让翻页
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;

      // 水平滑动手势
      if (Math.abs(dx) > 38 && Math.abs(dx) > Math.abs(dy) * 1.3 && this.settings.flipMode !== 'continuous') {
        if (dx < 0) this.next();
        else this.prev();
        return;
      }

      // 瞬时点按 (Tap) 判定 (精确换算为全局屏幕百分比)
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18 && dt < 450) {
        const target = e.target;
        if (target && target.closest && (target.closest('a[href]') || target.closest('mark.xxyxx-highlight'))) return;
        const coords = getScreenCoords(endX, endY);
        this._emitTap(coords.x / window.innerWidth, coords.y / window.innerHeight, e);
      }
    }, { passive: true });

    doc.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.closest && (target.closest('a[href]') || target.closest('mark.xxyxx-highlight'))) return;
      const coords = getScreenCoords(e.clientX, e.clientY);
      this._emitTap(coords.x / window.innerWidth, coords.y / window.innerHeight, e);
    });

    // 3. 选词完成通知 (触发四色印彩划线批注)
    let selTimer = null;
    const handleSelectionEnd = () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        try {
          const sel = doc.getSelection();
          if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
          const range = sel.getRangeAt(0);
          const cfi = this.getCFI(sectionIndex, range);
          const rect = range.getBoundingClientRect();
          const iframes = this.shadowRoot.querySelectorAll('iframe');
          let frameRect = { left: 0, top: 0 };
          for (const iframe of iframes) {
            if (iframe.contentDocument === doc) {
              frameRect = iframe.getBoundingClientRect();
              break;
            }
          }
          this.dispatchEvent(new CustomEvent('text-selected', {
            detail: {
              cfi: typeof cfi === 'string' ? cfi : '',
              text: sel.toString().trim(),
              sectionIndex,
              clientX: frameRect.left + rect.left + rect.width / 2,
              clientY: frameRect.top + rect.top - 10
            }
          }));
        } catch (_) {}
      }, 180);
    };

    doc.addEventListener('selectionchange', handleSelectionEnd);
    doc.addEventListener('contextmenu', () => setTimeout(handleSelectionEnd, 120));
  }

  _emitTap(xRatio, yRatio, origEvent) {
    const now = Date.now();
    if (this._lastTapTime && (now - this._lastTapTime < 380)) return;
    this._lastTapTime = now;
    this.dispatchEvent(new CustomEvent('viewport-tap', {
      detail: { xRatio, yRatio, originalEvent: origEvent }
    }));
  }
}

customElements.define('foliate-view', FoliateView);
