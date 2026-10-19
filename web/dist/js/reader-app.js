// 阅读器总控应用：排版五要素、三模翻页、二维九宫格热区、墨水屏物理按键录制与进度同步
import './foliate-js/view.js?v=2.0.6';
import { ThemeManager, showToast } from './theme.js';
import { AnnotatorController } from './annotator.js';

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

class ReaderApp {
  constructor() {
    const params = new URLSearchParams(window.location.search);
    this.bookId = params.get('id') || '';
    this.bookMeta = null;
    this.toc = [];
    this.view = document.getElementById('reader-view');
    this.barsVisible = false;
    this.progressTimer = null;

    this.settings = this._loadSettings();
    this.customKeys = this._loadCustomKeys();
    this.recordingTarget = null; // 'next' | 'prev' | null
  }

  _loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('xxyxx_reader_settings') || '{}');
      return {
        flipMode: saved.flipMode || 'instant_tap',
        fontSize: Number(saved.fontSize) || 19,
        fontFamily: saved.fontFamily || 'serif',
        lineHeight: Number(saved.lineHeight) || 1.8,
        margin: Number(saved.margin) || 28,
        indent: saved.indent !== undefined ? Boolean(saved.indent) : true,
        justify: saved.justify !== undefined ? Boolean(saved.justify) : true
      };
    } catch (_) {
      return {
        flipMode: 'instant_tap',
        fontSize: 19,
        fontFamily: 'serif',
        lineHeight: 1.8,
        margin: 28,
        indent: true,
        justify: true
      };
    }
  }

  _saveSettings() {
    localStorage.setItem('xxyxx_reader_settings', JSON.stringify(this.settings));
  }

  _loadCustomKeys() {
    try {
      return JSON.parse(localStorage.getItem('xxyxx_custom_keys') || '{"next":[],"prev":[]}');
    } catch (_) {
      return { next: [], prev: [] };
    }
  }

  _saveCustomKeys() {
    localStorage.setItem('xxyxx_custom_keys', JSON.stringify(this.customKeys));
    this._renderCustomKeysHint();
  }

  async init() {
    ThemeManager.init();
    if (!this.bookId) {
      showToast('缺少书籍 ID，正在返回书架');
      setTimeout(() => { window.location.href = '/'; }, 1000);
      return;
    }

    this.annotator = new AnnotatorController({
      bookId: this.bookId,
      view: this.view,
      onAnnotationsChanged: (anns) => this._renderAnnotationsList(anns)
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

      // 拉取书籍字节流（MD/TXT 后端已自动转为虚拟 EPUB 缓存流）
      const contentRes = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/content`);
      if (!contentRes.ok) throw new Error('拉取书籍内容失败');
      const buffer = await contentRes.arrayBuffer();

      const engineFormat = (this.bookMeta.file_type === 'azw3' || this.bookMeta.file_type === 'mobi')
        ? this.bookMeta.file_type
        : 'epub';

      this.view.updateSettings(this.settings);
      const bookInfo = await this.view.openBuffer(buffer, engineFormat);
      this.toc = bookInfo.toc || [];
      this._renderTocList();

      await this.annotator.loadAnnotations();
      await this.view.goToCFI(this.bookMeta.progress_cfi, this.bookMeta.progress_percent);
    } catch (err) {
      showToast(`加载书籍出错: ${err.message}`);
    }
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
    // 1. 二维九宫格触控热区判定
    this.view.addEventListener('viewport-tap', (e) => {
      // 若当前笔记/批注界面正处于弹出状态，点击任意区域的首要行为是收起笔记浮层，绝不误触翻页或菜单！
      if (this.annotator && this.annotator.isActive()) {
        this.annotator.hidePopover();
        return;
      }

      const { xRatio, yRatio } = e.detail;
      // 中心九宫格矩形 [X: 30%~70%, Y: 25%~75%] 呼出/收起菜单
      if (xRatio >= 0.30 && xRatio <= 0.70 && yRatio >= 0.25 && yRatio <= 0.75) {
        this._toggleBars();
        return;
      }
      if (this.barsVisible) {
        this._setBarsVisible(false);
      }
      // 左侧 < 35% 上一页，右侧 >= 35% 下一页（单手盲按友好）
      if (xRatio < 0.35) {
        this.view.prev();
      } else {
        this.view.next();
      }
    });

    // 2. 选词触发四色印彩批注框
    this.view.addEventListener('text-selected', (e) => {
      this.annotator.showForSelection(e.detail);
    });

    // 3. 点击已有高亮编辑或删除
    this.view.addEventListener('annotation-clicked', (e) => {
      this.annotator.showForExisting(e.detail.id, e.detail.clientX, e.detail.clientY);
    });

    // 4. 翻页进度变更与自动防抖落库
    this.view.addEventListener('relocate', (e) => {
      const { page, totalPages, percent, cfi, chapterTitle, sectionIndex } = e.detail;
      document.getElementById('topbar-chapter-title').textContent = chapterTitle || '';
      document.getElementById('status-chapter').textContent = chapterTitle || `第 ${sectionIndex + 1} 节`;
      document.getElementById('status-page').textContent = `${page} / ${totalPages} · ${percent.toFixed(1)}%`;

      const slider = document.getElementById('progress-slider');
      const label = document.getElementById('progress-percent-label');
      if (slider) slider.value = percent;
      if (label) label.textContent = `${percent.toFixed(1)}%`;

      this._highlightActiveToc(sectionIndex);
      this._debounceSaveProgress({ percent, cfi, label: chapterTitle });
    });

    // 5. 键盘与墨水屏实体按键支持
    let lastTurnTime = 0;
    const handleKey = (rawKey, rawCode, origEvent) => {
      const { key, keyCode } = this._normalizeKey(rawKey, rawCode);
      if (this.recordingTarget) {
        if (origEvent) origEvent.preventDefault();
        this._recordKey(this.recordingTarget, key, keyCode);
        return;
      }
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'textarea' || activeTag === 'input') return;

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
        // 280ms 严格翻页冷却保护：坚决杜绝物理按键连击或硬件 repeat 导致连续跳多页
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
    });

    document.getElementById('btn-open-settings')?.addEventListener('click', () => {
      this._setBarsVisible(false);
      backdrop?.classList.add('active');
      rightDrawer?.classList.add('active');
    });

    // 左侧抽屉 Tab 切换（目录 / 朱批 / Obsidian 笔记预览）
    for (const tabBtn of document.querySelectorAll('.drawer-tab')) {
      tabBtn.addEventListener('click', async () => {
        const target = tabBtn.getAttribute('data-tab');
        for (const b of document.querySelectorAll('.drawer-tab')) {
          b.classList.toggle('active', b === tabBtn);
        }
        document.getElementById('tab-panel-toc').style.display = target === 'toc' ? 'block' : 'none';
        document.getElementById('tab-panel-anns').style.display = target === 'anns' ? 'block' : 'none';
        document.getElementById('tab-panel-obsidian').style.display = target === 'obsidian' ? 'block' : 'none';

        if (target === 'obsidian') {
          const md = await this.annotator.fetchObsidianMarkdown();
          document.getElementById('obsidian-md-preview').textContent = md || '尚无笔记内容';
        }
      });
    }

    document.getElementById('btn-copy-obsidian')?.addEventListener('click', async () => {
      const md = await this.annotator.fetchObsidianMarkdown();
      if (navigator.clipboard && md) {
        await navigator.clipboard.writeText(md);
        showToast('已复制 Obsidian Markdown 笔记全文');
      }
    });

    // 底部章节与进度条控制
    document.getElementById('btn-prev-chapter')?.addEventListener('click', () => {
      if (this.view.currentSectionIndex > 0) {
        this.view.goToSection(this.view.currentSectionIndex - 1, 0);
      }
    });
    document.getElementById('btn-next-chapter')?.addEventListener('click', () => {
      if (this.view.book && this.view.currentSectionIndex + 1 < this.view.book.sections.length) {
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
        ThemeManager.setTheme(t);
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

    // 1. 字号微调 (12px ~ 36px + A-/A+)
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

    // 4. 版心边距
    for (const btn of document.querySelectorAll('[data-set-margin]')) {
      btn.addEventListener('click', () => {
        this.settings.margin = Number(btn.getAttribute('data-set-margin'));
        this._saveSettings();
        this.view.updateSettings(this.settings);
        this._syncSettingsUI();
      });
    }

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

    // 九宫格热区示意浮层
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
    for (const btn of document.querySelectorAll('[data-set-margin]')) {
      btn.classList.toggle('active', Number(btn.getAttribute('data-set-margin')) === this.settings.margin);
    }
    document.getElementById('btn-toggle-indent')?.classList.toggle('active', this.settings.indent);
    document.getElementById('btn-toggle-justify')?.classList.toggle('active', this.settings.justify);
    this._renderCustomKeysHint();
  }

  _renderTocList() {
    const listEl = document.getElementById('toc-list');
    if (!listEl) return;
    listEl.innerHTML = this.toc.map((item, idx) => `
      <li class="toc-item" data-sec-idx="${item.sectionIndex ?? idx}">
        <span>${escapeHTML(item.title)}</span>
        <span style="font-size:12px;color:var(--stone);">#${(item.sectionIndex ?? idx) + 1}</span>
      </li>
    `).join('');

    for (const li of listEl.querySelectorAll('.toc-item')) {
      li.addEventListener('click', () => {
        const secIdx = Number(li.getAttribute('data-sec-idx'));
        this.view.goToSection(secIdx, 0);
        document.getElementById('drawer-backdrop')?.classList.remove('active');
        document.getElementById('drawer-left')?.classList.remove('active');
      });
    }
  }

  _highlightActiveToc(sectionIndex) {
    const listEl = document.getElementById('toc-list');
    if (!listEl) return;
    for (const li of listEl.querySelectorAll('.toc-item')) {
      li.classList.toggle('active', Number(li.getAttribute('data-sec-idx')) === sectionIndex);
    }
  }

  _renderAnnotationsList(annotations) {
    const container = document.getElementById('annotations-list');
    const countBadge = document.getElementById('ann-count-badge');
    if (countBadge) countBadge.textContent = annotations.length;
    if (!container) return;

    if (annotations.length === 0) {
      container.innerHTML = `<p style="color:var(--stone);font-size:13px;text-align:center;padding:32px 0;">在正文中长按或鼠标选词，即可加盖文人四色印彩并直写 Obsidian 笔记。</p>`;
      return;
    }

    container.innerHTML = annotations.map((a) => `
      <div class="ann-card" data-color="${escapeHTML(a.color || 'zhusha')}">
        <div class="ann-quote" data-cfi="${escapeHTML(a.cfi)}">“${escapeHTML(a.selected_text)}”</div>
        ${a.note ? `<div class="ann-note">批注：${escapeHTML(a.note)}</div>` : ''}
        <div class="ann-meta">
          <span>${SEAL_LABELS[a.color] || '朱砂印'} · ${escapeHTML(a.chapter_title || '正文')}</span>
          <button class="btn btn-danger js-del-ann" style="padding:2px 6px;font-size:11px;" data-ann-id="${escapeHTML(a.id)}">删</button>
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
