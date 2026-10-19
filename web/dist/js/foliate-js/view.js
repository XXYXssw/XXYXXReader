// Foliate-core 工业级流式排版阅读引擎（基于 johnfactotum/foliate-js 原版核心）
// 支持：Paginator 视口百分比留白架构、全格式 (EPUB 2/3, MOBI, KF8/AZW3)、跨节点鲁棒高亮与防误触选词
import { View } from './foliate-core-view.js?v=3.5.0';
import { ThemeManager } from '../theme.js';

export class FoliateView extends View {
  constructor() {
    super();
    this.settings = {
      flipMode: 'instant_tap',
      fontSize: 19,
      fontFamily: 'serif',
      lineHeight: 1.8,
      margin: 6, // 单侧屏幕宽度百分比 (0% ~ 35%)
      indent: true,
      justify: true
    };
    this.annotations = [];
    this._lastTapTime = 0;
    this._customStyles = '';
    this._currentSectionIndex = 0;

    // 监听官方原生 relocate 事件，映射转换给外层阅读器宿主（带重入阻断）
    this.addEventListener('relocate', (e) => {
      if (e.detail?.__xxyxx) return;
      e.stopImmediatePropagation();

      const { fraction, location, section, index, tocItem, cfi } = e.detail || {};
      const pct = typeof fraction === 'number' && !Number.isNaN(fraction) ? fraction * 100 : 0;
      const page = (this.renderer && !this.renderer.scrolled && this.renderer.page > 0)
        ? this.renderer.page
        : ((location?.current ?? 0) + 1);
      const totalPages = (this.renderer && !this.renderer.scrolled && this.renderer.pages > 2)
        ? (this.renderer.pages - 2)
        : Math.max(1, location?.total || 1);
      const chapterTitle = tocItem?.label || tocItem?.title || '';
      const sectionIndex = typeof index === 'number'
        ? index
        : (section?.current ?? this.renderer?.getContents?.()?.[0]?.index ?? this._currentSectionIndex ?? 0);
      this._currentSectionIndex = sectionIndex;

      this.dispatchEvent(new CustomEvent('relocate', {
        detail: {
          page,
          totalPages,
          percent: pct,
          cfi: typeof cfi === 'string' ? cfi : (this.lastLocation?.cfi || ''),
          chapterTitle,
          tocHref: tocItem?.href || '',
          tocId: tocItem?.id,
          sectionIndex,
          __xxyxx: true
        }
      }));
    }, true);

    // 监听章节加载事件，直接对传入的 doc 绑定事件并渲染高亮（避免此时 getContents 尚未挂载新视图）
    this.addEventListener('load', (e) => {
      const { doc, index } = e.detail || {};
      if (typeof index === 'number') this._currentSectionIndex = index;
      if (!doc) return;
      const secIdx = index ?? this._currentSectionIndex;
      this._bindDocEvents(doc, secIdx);
      this._renderDocHighlights(doc, secIdx);
      requestAnimationFrame(() => this._renderDocHighlights(doc, secIdx));
    });
  }

  setAnnotations(list) {
    this.annotations = Array.isArray(list) ? list : [];
    this.renderAnnotationsInCurrentSection();
  }

  renderAnnotationsInCurrentSection() {
    if (!this.renderer) return;
    try {
      const contents = this.renderer.getContents ? this.renderer.getContents() : [];
      for (const { doc, index } of contents) {
        if (!doc || !doc.body) continue;
        this._renderDocHighlights(doc, index);
      }
    } catch (_) {}
  }

  _renderDocHighlights(doc, sectionIndex) {
    if (!doc || !doc.body) return;

    // 1. 清理已有高亮标记并合并被分割的相邻文本节点
    const oldMarks = Array.from(doc.querySelectorAll('mark.xxyxx-highlight'));
    for (const m of oldMarks) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }

    if (!this.annotations || !this.annotations.length) return;

    // 2. 逐条匹配并渲染高亮（优先 CFI 精确还原，降级使用跨节点空白归一化文本匹配）
    for (const ann of this.annotations) {
      let range = null;
      let cfiBelongsToOtherSection = false;

      if (ann.cfi && typeof ann.cfi === 'string' && ann.cfi.startsWith('epubcfi(')) {
        try {
          const resolved = this.resolveCFI(ann.cfi);
          if (resolved && typeof resolved.index === 'number') {
            if (resolved.index !== sectionIndex) {
              cfiBelongsToOtherSection = true;
            } else if (typeof resolved.anchor === 'function') {
              const r = resolved.anchor(doc);
              if (r && !r.collapsed && r.toString().trim().length > 0) {
                range = r;
              }
            }
          }
        } catch (_) {}
      }

      if (cfiBelongsToOtherSection && typeof ann.chapter_index === 'number' && ann.chapter_index !== sectionIndex) {
        continue;
      }

      if (!range) {
        range = this._findRangeByNormalizedText(doc, ann.selected_text);
      }

      if (range) {
        this._wrapRangeWithMark(doc, range, ann);
      }
    }
  }

  // 跨文本节点、跨段落且忽略换行/多空格差异的鲁棒文本范围定位
  _findRangeByNormalizedText(doc, rawTarget) {
    const needle = (rawTarget || '').replace(/[\s\u00A0]+/g, ' ').trim();
    if (!needle || !doc.body) return null;

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let haystack = '';
    const charMap = [];
    let lastWasSpace = true;

    let node;
    while ((node = walker.nextNode())) {
      const val = node.nodeValue || '';
      for (let i = 0; i < val.length; i++) {
        const ch = val[i];
        if (/[\s\u00A0]/.test(ch)) {
          if (!lastWasSpace) {
            haystack += ' ';
            charMap.push({ node, offset: i });
            lastWasSpace = true;
          }
        } else {
          haystack += ch;
          charMap.push({ node, offset: i });
          lastWasSpace = false;
        }
      }
    }

    const matchIdx = haystack.indexOf(needle);
    if (matchIdx < 0) return null;

    const startEntry = charMap[matchIdx];
    const endEntry = charMap[matchIdx + needle.length - 1];
    if (!startEntry || !endEntry) return null;

    try {
      const range = doc.createRange();
      range.setStart(startEntry.node, startEntry.offset);
      range.setEnd(endEntry.node, endEntry.offset + 1);
      return range;
    } catch (_) {
      return null;
    }
  }

  // 使用 splitText 逐个文本节点包裹 <mark>，彻底解决跨标签/跨段落时 surroundContents 抛异常导致划线不显示的问题
  _wrapRangeWithMark(doc, range, ann) {
    if (!range || range.collapsed) return;

    const textNodes = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      try {
        if (range.intersectsNode(n)) {
          textNodes.push(n);
        }
      } catch (_) {}
    }

    const startContainer = range.startContainer;
    const startOffset = range.startOffset;
    const endContainer = range.endContainer;
    const endOffset = range.endOffset;

    for (const tNode of textNodes) {
      if (!tNode.parentNode) continue;
      const sOff = tNode === startContainer ? startOffset : 0;
      const eOff = tNode === endContainer ? endOffset : tNode.nodeValue.length;
      if (eOff <= sOff) continue;
      if (!tNode.nodeValue.slice(sOff, eOff).trim()) continue;

      try {
        let targetNode = tNode;
        if (eOff < targetNode.nodeValue.length) {
          targetNode.splitText(eOff);
        }
        if (sOff > 0) {
          targetNode = targetNode.splitText(sOff);
        }
        const mark = doc.createElement('mark');
        mark.className = 'xxyxx-highlight';
        mark.setAttribute('data-ann-id', ann.id);
        mark.setAttribute('data-color', ann.color || 'zhusha');
        if (ann.note) mark.title = ann.note;
        targetNode.parentNode.insertBefore(mark, targetNode);
        mark.appendChild(targetNode);
      } catch (_) {}
    }
  }

  clearSelection() {
    try {
      const contents = this.renderer?.getContents ? this.renderer.getContents() : [];
      for (const { doc } of contents) {
        doc?.defaultView?.getSelection()?.removeAllRanges();
      }
      window.getSelection()?.removeAllRanges();
    } catch (_) {}
  }

  get currentSectionIndex() {
    const activeIdx = this.renderer?.getContents?.()?.[0]?.index;
    return typeof activeIdx === 'number' ? activeIdx : (this._currentSectionIndex ?? 0);
  }

  async openBuffer(arrayBuffer, fileType = 'epub') {
    if (this.book) {
      try { this.close(); } catch (_) {}
    }

    const ext = (fileType === 'azw3' || fileType === 'mobi') ? fileType : 'epub';
    const mime = ext === 'epub' ? 'application/epub+zip' : 'application/x-mobipocket-ebook';
    const blob = new Blob([arrayBuffer], { type: mime });
    const file = new File([blob], `book.${ext}`);

    await this.open(file);
    this.updateSettings(this.settings);
    await this.init({ showTextStart: true });

    return {
      toc: this.book.toc || [],
      sectionCount: this.book.sections?.length || 1
    };
  }

  updateSettings(partial = {}) {
    Object.assign(this.settings, partial);
    if (!this.renderer) return;

    const palette = ThemeManager.getPalette();

    // 1. 排版流引擎 (分页 paginated / 连续滚动 scrolled) 与翻页动效开关
    const flow = this.settings.flipMode === 'continuous' ? 'scrolled' : 'paginated';
    this.renderer.setAttribute('flow', flow);

    const shouldAnimate = !palette.isEink && this.settings.flipMode === 'horiz_slide';
    if (shouldAnimate) {
      this.renderer.setAttribute('animated', '');
    } else {
      this.renderer.removeAttribute('animated');
    }

    // 2. 版心左右留白控制（按单侧屏幕宽度比例 0% ~ 35% 自适应）
    const marginPct = this.settings.margin !== undefined
      ? Math.max(0, Math.min(35, Number(this.settings.margin)))
      : 6;
    this.style.paddingLeft = '0';
    this.style.paddingRight = '0';
    this.renderer.setAttribute('max-column-count', '1');
    this.renderer.setAttribute('margin', '0px');
    this.renderer.setAttribute('gap', '0px');
    this.renderer.setAttribute('side-margin', `${marginPct}%`);

    // 3. 全局穿透 CSS (字号、行距、字体栈、两端对齐、段首缩进、主题配色及强制可见的四色印彩高亮)
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
      body, section.chapter {
        margin-left: 0 !important;
        margin-right: 0 !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
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
      /* 四色印彩高亮样式（强制 !important 确保不被书籍自带样式覆盖） */
      mark.xxyxx-highlight {
        color: inherit !important;
        padding: 1px 0 !important;
        border-radius: 2px !important;
        cursor: pointer !important;
        display: inline !important;
        visibility: visible !important;
      }
      mark.xxyxx-highlight[data-color="zhusha"] {
        background: rgba(184, 51, 42, 0.26) !important;
        border-bottom: 2px solid #b8332a !important;
      }
      mark.xxyxx-highlight[data-color="zhuqing"] {
        background: rgba(46, 125, 90, 0.26) !important;
        border-bottom: 2px solid #2e7d5a !important;
      }
      mark.xxyxx-highlight[data-color="songyan"] {
        background: rgba(92, 96, 104, 0.26) !important;
        border-bottom: 2px solid #5c6068 !important;
      }
      mark.xxyxx-highlight[data-color="qiukui"] {
        background: rgba(184, 134, 11, 0.26) !important;
        border-bottom: 2px solid #b8860b !important;
      }
    `;

    this._customStyles = customCSS;
    if (this.renderer.setStyles) {
      this.renderer.setStyles(customCSS);
    }
    if (typeof this.renderer.render === 'function') {
      this.renderer.render();
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
    if (!this.book || !this.book.sections) return;
    const clamped = Math.max(0, Math.min(index, this.book.sections.length - 1));
    await this.renderer?.goTo?.({ index: clamped, anchor: targetRatio });
  }

  async goToPercent(percent) {
    await this.goToFraction(Math.max(0, Math.min(100, Number(percent))) / 100);
  }

  _bindDocEvents(doc, sectionIndex) {
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

    // 2. 鼠标按压/拖选/长按状态追踪（彻底杜绝鼠标选词或长按抬起时被 click 误判为翻页）
    let mouseDownX = 0;
    let mouseDownY = 0;
    let mouseDownTime = 0;
    let mouseMoved = false;
    let hadSelectionOnDown = false;
    let lastTouchTime = 0;
    let lastSelectionTime = 0;

    doc.addEventListener('mousedown', (e) => {
      mouseDownX = e.clientX;
      mouseDownY = e.clientY;
      mouseDownTime = Date.now();
      mouseMoved = false;
      const sel = doc.getSelection();
      hadSelectionOnDown = Boolean(sel && !sel.isCollapsed && sel.toString().trim());
    });

    doc.addEventListener('mousemove', (e) => {
      if (mouseDownTime > 0 && Math.hypot(e.clientX - mouseDownX, e.clientY - mouseDownY) > 5) {
        mouseMoved = true;
      }
    });

    // 3. 移动端触摸滑动与九宫格轻点 (Tap) 判定
    let touchStartX = null, touchStartY = null, touchStartTime = 0;
    let hadSelectionOnTouchStart = false;

    doc.addEventListener('touchstart', (e) => {
      lastTouchTime = Date.now();
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
        const sel = doc.getSelection();
        hadSelectionOnTouchStart = Boolean(sel && !sel.isCollapsed && sel.toString().trim());
      }
    }, { passive: true });

    doc.addEventListener('touchend', (e) => {
      lastTouchTime = Date.now();
      if (touchStartX === null || e.changedTouches.length === 0) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - touchStartX;
      const dy = endY - touchStartY;
      const dt = Date.now() - touchStartTime;
      touchStartX = null;
      touchStartY = null;

      // 文本选词状态下绝不翻页，并立即触发选词印彩弹窗
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        lastSelectionTime = Date.now();
        handleSelectionEnd();
        setTimeout(handleSelectionEnd, 140);
        return;
      }
      if (hadSelectionOnTouchStart || Date.now() - lastSelectionTime < 600) {
        return;
      }

      // 0ms 点按瞬切模式下的水平滑动手势翻页
      if (!this.renderer?.hasAttribute('animated') && Math.abs(dx) > 38 && Math.abs(dx) > Math.abs(dy) * 1.3 && this.settings.flipMode !== 'continuous') {
        if (dx < 0) this.next();
        else this.prev();
        return;
      }

      // 瞬时轻点 (Tap < 280ms 且无位移) 才判定为翻页/菜单呼出，长按 (>280ms) 绝不翻页
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 280) {
        const target = e.target;
        if (target && target.closest && (target.closest('a[href]') || target.closest('mark.xxyxx-highlight'))) return;
        const coords = getScreenCoords(endX, endY);
        this._emitTap(coords.x / window.innerWidth, coords.y / window.innerHeight, e);
      }
    }, { passive: true });

    doc.addEventListener('click', (e) => {
      // 点击已有高亮标记：弹出编辑/删除框
      const mark = e.target.closest && e.target.closest('mark.xxyxx-highlight');
      if (mark) {
        e.preventDefault();
        e.stopPropagation();
        const annId = mark.getAttribute('data-ann-id');
        const rect = mark.getBoundingClientRect();
        const coords = getScreenCoords(rect.left + rect.width / 2, rect.bottom);
        this.dispatchEvent(new CustomEvent('annotation-clicked', {
          detail: {
            id: annId,
            clientX: coords.x,
            clientY: coords.y
          }
        }));
        return;
      }

      // 若刚发生过触摸事件（移动端浏览器在 touchend 后合成的兼容性 click），直接忽略，防止长按选词抬起后误翻页
      if (Date.now() - lastTouchTime < 800) return;
      if (e.button !== 0) return;

      // 鼠标防误触核心保护：
      // 1) 按下前已有选区、当前存在非空选区、或刚完成选词；
      // 2) 鼠标发生过拖拽位移 (mouseMoved 或位移 > 5px)；
      // 3) 鼠标长按抬起 (按住时长 >= 240ms)；
      // 满足任一条件均视为选词/长按操作，严禁触发翻页！
      const sel = doc.getSelection();
      const hasActiveSelection = Boolean(sel && !sel.isCollapsed && sel.toString().trim());
      const pressDuration = mouseDownTime > 0 ? (Date.now() - mouseDownTime) : 0;
      const moveDist = Math.hypot(e.clientX - mouseDownX, e.clientY - mouseDownY);

      if (
        hadSelectionOnDown ||
        hasActiveSelection ||
        mouseMoved ||
        moveDist > 5 ||
        pressDuration >= 240 ||
        (Date.now() - lastSelectionTime < 600)
      ) {
        return;
      }

      const target = e.target;
      if (target && target.closest && (target.closest('a[href]') || target.closest('mark.xxyxx-highlight'))) return;
      const coords = getScreenCoords(e.clientX, e.clientY);
      this._emitTap(coords.x / window.innerWidth, coords.y / window.innerHeight, e);
    });

    // 4. 选词完成通知 (仅在鼠标/手指抬起或菜单呼出且选区非空时弹出四色印彩浮层)
    let selTimer = null;
    const handleSelectionEnd = () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        try {
          const sel = doc.getSelection();
          if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
          lastSelectionTime = Date.now();
          const selectedStr = sel.toString().trim();
          const range = sel.getRangeAt(0);
          const cfi = this.getCFI(sectionIndex, range);
          const rect = range.getBoundingClientRect();
          const coords = getScreenCoords(rect.left + rect.width / 2, rect.top - 10);
          const currentChapterTitle = this.lastLocation?.tocItem?.label
            || this.book?.sections?.[sectionIndex]?.title
            || document.getElementById('status-chapter')?.textContent
            || '';

          this.dispatchEvent(new CustomEvent('text-selected', {
            detail: {
              cfi: typeof cfi === 'string' ? cfi : '',
              selectedText: selectedStr,
              text: selectedStr,
              chapterIndex: sectionIndex,
              chapterTitle: currentChapterTitle,
              sectionIndex,
              clientX: coords.x,
              clientY: coords.y
            }
          }));
        } catch (err) {
          console.error('[XXYXX-SEL-ERR]', err.message, err.stack);
        }
      }, 120);
    };

    doc.addEventListener('selectionchange', () => {
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        lastSelectionTime = Date.now();
      }
    });
    doc.addEventListener('mouseup', () => {
      handleSelectionEnd();
      setTimeout(handleSelectionEnd, 140);
    });
    doc.addEventListener('contextmenu', () => {
      handleSelectionEnd();
      setTimeout(handleSelectionEnd, 140);
    });
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

if (!customElements.get('foliate-view')) {
  customElements.define('foliate-view', FoliateView);
}
