// 阅读器总控应用：排版五要素、三模翻页、二维九宫格热区、AI 伴读与全服务端 SQLite 状态同步（零 localStorage）
import './foliate-js/view.js?v=3.6.0';
import { SettingsStore, ThemeManager, showToast } from './theme.js';
import { AnnotatorController } from './annotator.js';
import { AIChatController } from './ai-chat.js';

const SEAL_LABELS = {
  zhusha: '朱砂印',
  zhuqing: '竹青印',
  songyan: '松烟印',
  qiukui: '秋葵印'
};

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function flattenToc(items, depth = 0, out = []) {
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item) continue;
    out.push({
      id: item.id,
      title: item.label || item.title || '未命名章节',
      href: item.href || '',
      sectionIndex: item.sectionIndex,
      depth
    });
    if (Array.isArray(item.subitems) && item.subitems.length > 0) {
      flattenToc(item.subitems, depth + 1, out);
    }
  }
  return out;
}

class ReaderApp {
  constructor() {
    const params = new URLSearchParams(window.location.search);
    this.bookId = params.get('id') || '';
    this.bookMeta = null;
    this.toc = [];
    this.view = document.getElementById('reader-view');
    this.barsVisible = false;
    this.progressTimer = null;
    this.initialLoadDone = false;

    this.settings = {
      flipMode: 'instant_tap',
      fontSize: 19,
      fontFamily: 'serif',
      lineHeight: 1.8,
      margin: 6,
      marginUnit: 'percent',
      indent: true,
      justify: true
    };
    this.customKeys = { next: [], prev: [] };
    this.recordingTarget = null;
    this.aiChat = null;
  }

  _applyLoadedSettings(remoteData) {
    const saved = remoteData?.reader_settings || {};
    let marginPct = 6;
    if (saved.marginUnit === 'percent' && saved.margin !== undefined) {
      marginPct = Math.max(0, Math.min(35, Number(saved.margin)));
    } else if (saved.margin !== undefined) {
      const raw = Number(saved.margin);
      marginPct = raw <= 35 ? Math.max(0, raw) : Math.min(35, Math.round((raw / 1200) * 100));
    }
    this.settings = {
      flipMode: saved.flipMode || 'instant_tap',
      fontSize: Number(saved.fontSize) || 19,
      fontFamily: saved.fontFamily || 'serif',
      lineHeight: Number(saved.lineHeight) || 1.8,
      margin: marginPct,
      marginUnit: 'percent',
      indent: saved.indent !== undefined ? Boolean(saved.indent) : true,
      justify: saved.justify !== undefined ? Boolean(saved.justify) : true
    };

    const ck = remoteData?.custom_keys || {};
    this.customKeys = {
      next: Array.isArray(ck.next) ? ck.next : [],
      prev: Array.isArray(ck.prev) ? ck.prev : []
    };
  }

  _saveSettings() {
    this.settings.marginUnit = 'percent';
    SettingsStore.save({ reader_settings: this.settings });
  }

  _saveCustomKeys() {
    SettingsStore.save({ custom_keys: this.customKeys });
    this._renderCustomKeysHint();
  }

  async init() {
    const allSettings = await SettingsStore.load();
    ThemeManager.setTheme(allSettings.theme || 'rice-paper', false);
    this._applyLoadedSettings(allSettings);

    if (!this.bookId) {
      showToast('缺少书籍 ID，正在返回书架');
      setTimeout(() => { window.location.href = '/'; }, 1000);
      return;
    }

    this.aiChat = new AIChatController({
      bookId: this.bookId,
      getBookContext: () => ({
        chapterIndex: this.view.currentSectionIndex,
        chapterTitle: document.getElementById('status-chapter')?.textContent || ''
      }),
      onJumpToCFI: (cfi) => {
        this.view.goToCFI(cfi);
        if (window.innerWidth <= 640) {
          document.getElementById('drawer-backdrop')?.classList.remove('active');
          document.getElementById('drawer-left')?.classList.remove('active');
        }
      }
    });

    this.annotator = new AnnotatorController({
      bookId: this.bookId,
      view: this.view,
      onAnnotationsChanged: (anns) => this._renderAnnotationsList(anns),
      onAskAI: (quotePayload) => this.openAIChatWithQuote(quotePayload)
    });

    this._bindUIControls();
    this._bindViewEvents();
    this._syncSettingsUI();

    try {
      const metaRes = await fetch(`/api/books/${encodeURIComponent(this.bookId)}`);
      if (!metaRes.ok) throw new Error('未找到该藏书');
      this.bookMeta = await metaRes.json();
      document.title = `《${this.bookMeta.title}》 · 阅境`;
      document.getElementById('topbar-book-title').textContent = `《${this.bookMeta.title}》`;

      await Promise.all([
        this.annotator.loadAnnotations(),
        this.aiChat.loadSessions()
      ]);

      const contentRes = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/content`);
      if (!contentRes.ok) throw new Error('拉取书籍内容失败');
      const buffer = await contentRes.arrayBuffer();

      const engineFormat = (this.bookMeta.file_type === 'azw3' || this.bookMeta.file_type === 'mobi')
        ? this.bookMeta.file_type
        : 'epub';

      this.view.updateSettings(this.settings);
      const bookInfo = await this.view.openBuffer(buffer, engineFormat);
      this.toc = flattenToc(bookInfo.toc || []);
      this._renderTocList();

      await this.view.goToCFI(this.bookMeta.progress_cfi, this.bookMeta.progress_percent);
      this.view.renderAnnotationsInCurrentSection();
      this.initialLoadDone = true;
    } catch (err) {
      showToast(`加载书籍出错: ${err.message}`);
    }
  }

  // 打开左侧边栏的 AI 伴读标签并挂载特殊引用块
  openAIChatWithQuote(quotePayload) {
    this._setBarsVisible(false);
    const backdrop = document.getElementById('drawer-backdrop');
    const leftDrawer = document.getElementById('drawer-left');
    backdrop?.classList.add('active');
    leftDrawer?.classList.add('active');
    leftDrawer?.classList.add('ai-expanded');
    this._switchLeftTab('ai');
    if (quotePayload && this.aiChat) {
      this.aiChat.attachQuote(quotePayload);
    }
  }

  _switchLeftTab(target) {
    const leftDrawer = document.getElementById('drawer-left');
    leftDrawer?.classList.toggle('ai-expanded', target === 'ai');
    for (const b of document.querySelectorAll('.drawer-tab')) {
      b.classList.toggle('active', b.getAttribute('data-tab') === target);
    }
    const tocPanel = document.getElementById('tab-panel-toc');
    const annsPanel = document.getElementById('tab-panel-anns');
    const aiPanel = document.getElementById('tab-panel-ai');
    if (tocPanel) tocPanel.style.display = target === 'toc' ? 'block' : 'none';
    if (annsPanel) annsPanel.style.display = target === 'anns' ? 'block' : 'none';
    if (aiPanel) aiPanel.style.display = target === 'ai' ? 'flex' : 'none';
  }

  _normalizeKey(key, keyCode) {
    let k = key;
    const c = Number(keyCode) || 0;
    if (c === 25 || k === 'VolumeDown') return { key: 'VolumeDown', keyCode: 25 };
    if (c === 24 || k === 'VolumeUp') return { key: 'VolumeUp', keyCode: 24 };
    if (c === 93 || k === 'PageDown') return { key: 'PageDown', keyCode: 93 };
    if (c === 92 || k === 'PageUp') return { key: 'PageUp', keyCode: 92 };
    if (c === 39 || c === 22 || k === 'ArrowRight') return { key: 'ArrowRight', keyCode: c || 39 };
    if (c === 37 || c === 21 || k === 'ArrowLeft') return { key: 'ArrowLeft', keyCode: c || 37 };
    if (c === 32 || k === ' ' || k === 'Space') return { key: 'Space', keyCode: 32 };
    if (!k || k === 'Unidentified') k = `Key#${c}`;
    return { key: k, keyCode: c };
  }

  _bindViewEvents() {
    this.view.addEventListener('viewport-tap', (e) => {
      if (this.annotator && this.annotator.isActive()) {
        this.annotator.hidePopover();
        return;
      }

      const { xRatio, yRatio } = e.detail;
      if (xRatio >= 0.30 && xRatio <= 0.70 && yRatio >= 0.25 && yRatio <= 0.75) {
        this._toggleBars();
        return;
      }
      if (this.barsVisible) {
        this._setBarsVisible(false);
      }
      if (xRatio < 0.35) {
        this.view.prev();
      } else {
        this.view.next();
      }
    });

    this.view.addEventListener('text-selected', (e) => {
      this.annotator.showForSelection(e.detail);
    });

    this.view.addEventListener('annotation-clicked', (e) => {
      this.annotator.showForExisting(e.detail.id, e.detail.clientX, e.detail.clientY);
    });

    this.view.addEventListener('relocate', (e) => {
      const {
        page = 1,
        totalPages = 1,
        percent = 0,
        cfi = '',
        chapterTitle = '',
        tocHref = '',
        tocId,
        sectionIndex = 0
      } = e.detail || {};
      const numPercent = typeof percent === 'number' ? percent : (Number(percent) || 0);

      document.getElementById('topbar-chapter-title').textContent = chapterTitle || '';
      document.getElementById('status-chapter').textContent = chapterTitle || `第 ${sectionIndex + 1} 节`;
      document.getElementById('status-page').textContent = `${page} / ${totalPages} · ${numPercent.toFixed(1)}%`;

      const slider = document.getElementById('progress-slider');
      const label = document.getElementById('progress-percent-label');
      if (slider) slider.value = numPercent;
      if (label) label.textContent = `${numPercent.toFixed(1)}%`;

      this._highlightActiveToc(sectionIndex, tocHref, tocId);
      if (this.initialLoadDone) {
        this._debounceSaveProgress({ percent: numPercent, cfi, label: chapterTitle });
      }
    });

    let lastTurnTime = 0;
    const handleKey = (rawKey, rawCode, origEvent) => {
      const { key, keyCode } = this._normalizeKey(rawKey, rawCode);
      if (this.recordingTarget) {
        if (origEvent) origEvent.preventDefault();
        this._recordKey(this.recordingTarget, key, keyCode);
        return;
      }
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'textarea' || activeTag === 'input' || activeTag === 'select') return;

      const token = `${key}#${keyCode}`;
      const isNext = [
        'ArrowRight', 'PageDown', 'VolumeDown', 'Space'
      ].includes(key) || [93, 25, 39, 22, 32].includes(keyCode) || this.customKeys.next.includes(token) || this.customKeys.next.includes(key);

      const isPrev = [
        'ArrowLeft', 'PageUp', 'VolumeUp'
      ].includes(key) || [92, 24, 37, 21].includes(keyCode) || this.customKeys.prev.includes(token) || this.customKeys.prev.includes(key);

      if (isNext || isPrev) {
        if (origEvent) origEvent.preventDefault();
        const now = Date.now();
        if (now - lastTurnTime < 280) {
          return;
        }
        lastTurnTime = now;
        if (isNext) this.view.next();
        else this.view.prev();
      }
    };

    window.addEventListener('keydown', (e) => handleKey(e.key, e.keyCode, e), true);
    this.view.addEventListener('reader-keydown', (e) => {
      handleKey(e.detail.key, e.detail.keyCode, e.detail.originalEvent);
    });

    window.addEventListener('theme-changed', () => {
      this.view.updateSettings({});
      this._syncSettingsUI();
    });

    window.addEventListener('resize', () => {
      this.view.updateSettings({});
    });
  }

  _debounceSaveProgress(payload) {
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => {
      fetch(`/api/books/${encodeURIComponent(this.bookId)}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    }, 600);
  }

  _toggleBars() {
    this._setBarsVisible(!this.barsVisible);
  }

  _setBarsVisible(visible) {
    this.barsVisible = visible;
    document.getElementById('reader-topbar')?.classList.toggle('visible', visible);
    document.getElementById('reader-bottombar')?.classList.toggle('visible', visible);
  }

  _bindUIControls() {
    const backdrop = document.getElementById('drawer-backdrop');
    const leftDrawer = document.getElementById('drawer-left');
    const rightDrawer = document.getElementById('drawer-right');

    const updateRecordButtons = () => {
      const btnNext = document.getElementById('btn-record-next');
      const btnPrev = document.getElementById('btn-record-prev');
      if (btnNext) btnNext.textContent = this.recordingTarget === 'next' ? '⏳ 请按下按键…' : '录制「下页键」';
      if (btnPrev) btnPrev.textContent = this.recordingTarget === 'prev' ? '⏳ 请按下按键…' : '录制「上页键」';
    };

    const closeDrawers = () => {
      backdrop?.classList.remove('active');
      leftDrawer?.classList.remove('active');
      rightDrawer?.classList.remove('active');
      if (this.recordingTarget) {
        this.recordingTarget = null;
        updateRecordButtons();
      }
    };

    window.addEventListener('click', (e) => {
      if (this.annotator && this.annotator.isActive() && !e.target.closest('#annotator-popover')) {
        this.annotator.hidePopover();
      }
    });

    backdrop?.addEventListener('click', closeDrawers);
    document.getElementById('btn-close-left-drawer')?.addEventListener('click', closeDrawers);
    document.getElementById('btn-close-right-drawer')?.addEventListener('click', closeDrawers);

    document.getElementById('btn-open-toc')?.addEventListener('click', () => {
      this._setBarsVisible(false);
      backdrop?.classList.add('active');
      leftDrawer?.classList.add('active');
      this._switchLeftTab('toc');
    });

    document.getElementById('btn-open-ai')?.addEventListener('click', () => {
      this.openAIChatWithQuote(null);
    });

    document.getElementById('btn-open-settings')?.addEventListener('click', () => {
      this._setBarsVisible(false);
      backdrop?.classList.add('active');
      rightDrawer?.classList.add('active');
    });

    // 左侧抽屉 Tab 切换（卷章目录 / 朱批笔记 / AI 伴读）
    for (const tabBtn of document.querySelectorAll('.drawer-tab')) {
      tabBtn.addEventListener('click', () => {
        const target = tabBtn.getAttribute('data-tab');
        this._switchLeftTab(target);
      });
    }

    // 底部章节与进度条控制
    document.getElementById('btn-prev-chapter')?.addEventListener('click', () => {
      if (this.view.renderer?.prevSection) {
        this.view.renderer.prevSection();
      } else if (this.view.currentSectionIndex > 0) {
        this.view.goToSection(this.view.currentSectionIndex - 1, 0);
      }
    });
    document.getElementById('btn-next-chapter')?.addEventListener('click', () => {
      if (this.view.renderer?.nextSection) {
        this.view.renderer.nextSection();
      } else if (this.view.book && this.view.currentSectionIndex + 1 < this.view.book.sections.length) {
        this.view.goToSection(this.view.currentSectionIndex + 1, 0);
      }
    });
    document.getElementById('progress-slider')?.addEventListener('change', (e) => {
      this.view.goToPercent(Number(e.target.value));
    });

    // 主题选择
    for (const btn of document.querySelectorAll('[data-set-theme]')) {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-set-theme');
        ThemeManager.setTheme(t, true);
        if (t === 'e-ink') {
          this.settings.flipMode = 'instant_tap';
          this._saveSettings();
          this.view.updateSettings(this.settings);
          this._syncSettingsUI();
        }
      });
    }

    // 翻页模式
    for (const btn of document.querySelectorAll('[data-set-flip]')) {
      btn.addEventListener('click', () => {
        this.settings.flipMode = btn.getAttribute('data-set-flip');
        this._saveSettings();
        this.view.updateSettings(this.settings);
        this._syncSettingsUI();
      });
    }

    // 1. 字号微调
    const applyFontSize = (sz) => {
      this.settings.fontSize = Math.max(12, Math.min(36, sz));
      this._saveSettings();
      this.view.updateSettings(this.settings);
      this._syncSettingsUI();
    };
    document.getElementById('btn-font-dec')?.addEventListener('click', () => applyFontSize(this.settings.fontSize - 1));
    document.getElementById('btn-font-inc')?.addEventListener('click', () => applyFontSize(this.settings.fontSize + 1));
    document.getElementById('font-size-range')?.addEventListener('input', (e) => applyFontSize(Number(e.target.value)));

    // 2. 字体家族
    for (const btn of document.querySelectorAll('[data-set-font]')) {
      btn.addEventListener('click', () => {
        this.settings.fontFamily = btn.getAttribute('data-set-font');
        this._saveSettings();
        this.view.updateSettings(this.settings);
        this._syncSettingsUI();
      });
    }

    // 3. 行间距
    for (const btn of document.querySelectorAll('[data-set-lh]')) {
      btn.addEventListener('click', () => {
        this.settings.lineHeight = Number(btn.getAttribute('data-set-lh'));
        this._saveSettings();
        this.view.updateSettings(this.settings);
        this._syncSettingsUI();
      });
    }

    // 4. 版心留白比例微调 (单侧 0% ~ 35% 屏幕宽度比例)
    const applyMargin = (m) => {
      this.settings.margin = Math.max(0, Math.min(35, Math.round(Number(m) || 0)));
      this._saveSettings();
      this.view.updateSettings(this.settings);
      this._syncSettingsUI();
    };
    document.getElementById('btn-margin-dec')?.addEventListener('click', () => applyMargin(this.settings.margin - 1));
    document.getElementById('btn-margin-inc')?.addEventListener('click', () => applyMargin(this.settings.margin + 1));
    document.getElementById('margin-range')?.addEventListener('input', (e) => applyMargin(Number(e.target.value)));

    // 5. 段首缩进与两端对齐
    document.getElementById('btn-toggle-indent')?.addEventListener('click', () => {
      this.settings.indent = !this.settings.indent;
      this._saveSettings();
      this.view.updateSettings(this.settings);
      this._syncSettingsUI();
    });
    document.getElementById('btn-toggle-justify')?.addEventListener('click', () => {
      this.settings.justify = !this.settings.justify;
      this._saveSettings();
      this.view.updateSettings(this.settings);
      this._syncSettingsUI();
    });

    // 墨水屏实体按键录制绑定
    const startRecord = (target) => {
      this.recordingTarget = target;
      updateRecordButtons();
      showToast(`请按下墨水屏「${target === 'next' ? '下一页' : '上一页'}」物理按键，或直接点选下方快捷键…`);
    };

    document.getElementById('btn-record-next')?.addEventListener('click', () => startRecord('next'));
    document.getElementById('btn-record-prev')?.addEventListener('click', () => startRecord('prev'));

    for (const btn of document.querySelectorAll('.js-quick-key')) {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-target');
        const key = btn.getAttribute('data-key');
        const code = Number(btn.getAttribute('data-code'));
        this._recordKey(target, key, code);
      });
    }

    document.getElementById('btn-reset-keys')?.addEventListener('click', () => {
      this.customKeys = { next: [], prev: [] };
      this.recordingTarget = null;
      updateRecordButtons();
      this._saveCustomKeys();
      showToast('已恢复默认翻页键映射');
    });

    const tzGuide = document.getElementById('touch-zone-guide');
    document.getElementById('btn-show-tz-guide')?.addEventListener('click', () => {
      closeDrawers();
      tzGuide?.classList.add('active');
    });
    tzGuide?.addEventListener('click', () => {
      tzGuide.classList.remove('active');
    });
  }

  _recordKey(target, rawKey, rawCode) {
    const { key, keyCode } = this._normalizeKey(rawKey, rawCode);
    const token = `${key}#${keyCode}`;
    if (!this.customKeys[target].includes(token)) {
      this.customKeys[target].push(token);
    }
    this.recordingTarget = null;
    const btnNext = document.getElementById('btn-record-next');
    const btnPrev = document.getElementById('btn-record-prev');
    if (btnNext) btnNext.textContent = '录制「下页键」';
    if (btnPrev) btnPrev.textContent = '录制「上页键」';
    this._saveCustomKeys();
    showToast(`已成功绑定「${target === 'next' ? '下一页' : '上一页'}」实体键 (${key} / Code ${keyCode})`);
  }

  _renderCustomKeysHint() {
    const el = document.getElementById('custom-keys-status');
    if (!el) return;
    const nextStr = this.customKeys.next.length ? this.customKeys.next.join(', ') : '默认 (方向右/PageDown/音量下)';
    const prevStr = this.customKeys.prev.length ? this.customKeys.prev.join(', ') : '默认 (方向左/PageUp/音量上)';
    el.textContent = `下页键: ${nextStr} ｜ 上页键: ${prevStr}`;
  }

  _syncSettingsUI() {
    document.getElementById('font-size-label').textContent = `${this.settings.fontSize}px`;
    const range = document.getElementById('font-size-range');
    if (range) range.value = this.settings.fontSize;

    for (const btn of document.querySelectorAll('[data-set-theme]')) {
      btn.classList.toggle('active', btn.getAttribute('data-set-theme') === ThemeManager.current);
    }
    for (const btn of document.querySelectorAll('[data-set-flip]')) {
      btn.classList.toggle('active', btn.getAttribute('data-set-flip') === this.settings.flipMode);
    }
    for (const btn of document.querySelectorAll('[data-set-font]')) {
      btn.classList.toggle('active', btn.getAttribute('data-set-font') === this.settings.fontFamily);
    }
    for (const btn of document.querySelectorAll('[data-set-lh]')) {
      btn.classList.toggle('active', Number(btn.getAttribute('data-set-lh')) === this.settings.lineHeight);
    }
    const marginLabel = document.getElementById('margin-size-label');
    if (marginLabel) {
      marginLabel.textContent = this.settings.margin === 0 ? '0% (满屏)' : `${this.settings.margin}%`;
    }
    const marginRange = document.getElementById('margin-range');
    if (marginRange) marginRange.value = this.settings.margin;
    document.getElementById('btn-toggle-indent')?.classList.toggle('active', this.settings.indent);
    document.getElementById('btn-toggle-justify')?.classList.toggle('active', this.settings.justify);
    this._renderCustomKeysHint();
  }

  _renderTocList() {
    const listEl = document.getElementById('toc-list');
    if (!listEl) return;
    listEl.innerHTML = this.toc.map((item, idx) => `
      <li class="toc-item"
          data-sec-idx="${item.sectionIndex ?? idx}"
          data-href="${escapeHTML(item.href || '')}"
          data-toc-id="${item.id ?? idx}"
          style="padding-left:${8 + (item.depth || 0) * 14}px;">
        <span>${escapeHTML(item.title)}</span>
        <span style="font-size:12px;color:var(--stone);">#${idx + 1}</span>
      </li>
    `).join('');

    for (const li of listEl.querySelectorAll('.toc-item')) {
      li.addEventListener('click', () => {
        const href = li.getAttribute('data-href');
        const secIdx = Number(li.getAttribute('data-sec-idx'));
        if (href) {
          this.view.goTo(href);
        } else {
          this.view.goToSection(secIdx, 0);
        }
        document.getElementById('drawer-backdrop')?.classList.remove('active');
        document.getElementById('drawer-left')?.classList.remove('active');
      });
    }
  }

  _highlightActiveToc(sectionIndex, tocHref = '', tocId = undefined) {
    const listEl = document.getElementById('toc-list');
    if (!listEl) return;
    for (const li of listEl.querySelectorAll('.toc-item')) {
      const liId = li.getAttribute('data-toc-id');
      const liHref = li.getAttribute('data-href');
      const liSec = Number(li.getAttribute('data-sec-idx'));
      const matched = (tocId !== undefined && String(tocId) === liId)
        || (tocHref && liHref === tocHref)
        || (!tocHref && tocId === undefined && liSec === sectionIndex);
      li.classList.toggle('active', Boolean(matched));
    }
  }

  _renderAnnotationsList(annotations) {
    const container = document.getElementById('annotations-list');
    const countBadge = document.getElementById('ann-count-badge');
    if (countBadge) countBadge.textContent = annotations.length;
    if (!container) return;

    if (annotations.length === 0) {
      container.innerHTML = `<p style="color:var(--stone);font-size:13px;text-align:center;padding:32px 0;">在正文中长按或鼠标选词，即可加盖四色印彩或点击「✦ 问 AI」交谈。</p>`;
      return;
    }

    container.innerHTML = annotations.map((a) => `
      <div class="ann-card" data-color="${escapeHTML(a.color || 'zhusha')}">
        <div class="ann-quote" data-cfi="${escapeHTML(a.cfi)}">“${escapeHTML(a.selected_text)}”</div>
        ${a.note ? `<div class="ann-note">批注：${escapeHTML(a.note)}</div>` : ''}
        <div class="ann-meta">
          <span>${SEAL_LABELS[a.color] || '朱砂印'} · ${escapeHTML(a.chapter_title || '正文')}</span>
          <div style="display:flex;gap:5px;">
            <button class="btn js-ask-ai-ann" style="padding:2px 7px;font-size:11px;" data-ann-id="${escapeHTML(a.id)}">✦ 问 AI</button>
            <button class="btn btn-danger js-del-ann" style="padding:2px 6px;font-size:11px;" data-ann-id="${escapeHTML(a.id)}">删</button>
          </div>
        </div>
      </div>
    `).join('');

    for (const q of container.querySelectorAll('.ann-quote')) {
      q.addEventListener('click', () => {
        this.view.goToCFI(q.getAttribute('data-cfi'));
        document.getElementById('drawer-backdrop')?.classList.remove('active');
        document.getElementById('drawer-left')?.classList.remove('active');
      });
    }

    for (const aiBtn of container.querySelectorAll('.js-ask-ai-ann')) {
      aiBtn.addEventListener('click', () => {
        const annId = aiBtn.getAttribute('data-ann-id');
        const found = annotations.find((item) => item.id === annId);
        if (found) {
          this.openAIChatWithQuote({
            selected_text: found.selected_text,
            chapter_title: found.chapter_title || '',
            chapter_index: found.chapter_index || 0,
            cfi: found.cfi || ''
          });
        }
      });
    }

    for (const delBtn of container.querySelectorAll('.js-del-ann')) {
      delBtn.addEventListener('click', () => {
        this.annotator.deleteAnnotation(delBtn.getAttribute('data-ann-id'));
      });
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new ReaderApp();
  app.init();
});
