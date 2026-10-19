// 四色文人印彩划线批注与 Obsidian 实时同步前端模块
import { showToast } from './theme.js';

export class AnnotatorController {
  constructor({ bookId, view, onAnnotationsChanged }) {
    this.bookId = bookId;
    this.view = view;
    this.onAnnotationsChanged = onAnnotationsChanged;
    this.annotations = [];
    this.pendingSelection = null;
    this.activeColor = 'zhusha';

    this.popover = document.getElementById('annotator-popover');
    this.backdrop = document.getElementById('annotator-backdrop');
    this.noteInput = document.getElementById('annotator-note-input');
    this.deleteBtn = document.getElementById('btn-delete-annotation');
    this._bindPopoverEvents();
  }

  isActive() {
    return this.popover ? this.popover.classList.contains('active') : false;
  }

  _bindPopoverEvents() {
    if (this.backdrop) {
      const handleDismiss = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hidePopover();
      };
      this.backdrop.addEventListener('click', handleDismiss);
      this.backdrop.addEventListener('touchend', handleDismiss);
    }

    if (!this.popover) return;

    // 防止在 popover 内部点击/输入时事件冒泡导致误触发背景点击
    this.popover.addEventListener('click', (e) => e.stopPropagation());
    this.popover.addEventListener('touchend', (e) => e.stopPropagation());

    for (const btn of this.popover.querySelectorAll('.seal-btn')) {
      btn.addEventListener('click', () => {
        this.setActiveColor(btn.getAttribute('data-color'));
      });
    }

    document.getElementById('btn-save-annotation')?.addEventListener('click', () => {
      this.saveCurrentAnnotation();
    });

    document.getElementById('btn-cancel-annotation')?.addEventListener('click', () => {
      this.hidePopover();
    });

    this.deleteBtn?.addEventListener('click', () => {
      if (this.pendingSelection && this.pendingSelection.id) {
        this.deleteAnnotation(this.pendingSelection.id);
      }
    });
  }

  setActiveColor(color) {
    this.activeColor = color || 'zhusha';
    if (!this.popover) return;
    for (const btn of this.popover.querySelectorAll('.seal-btn')) {
      btn.classList.toggle('active', btn.getAttribute('data-color') === this.activeColor);
    }
  }

  async loadAnnotations() {
    const res = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/annotations`);
    if (res.ok) {
      this.annotations = await res.json();
      this.view.setAnnotations(this.annotations);
      if (this.onAnnotationsChanged) this.onAnnotationsChanged(this.annotations);
    }
    return this.annotations;
  }

  showForSelection(selectionDetail) {
    const txt = selectionDetail.selectedText || selectionDetail.text || '';
    this.pendingSelection = {
      id: '',
      cfi: selectionDetail.cfi,
      selected_text: txt,
      prefix_text: selectionDetail.prefixText || '',
      suffix_text: selectionDetail.suffixText || '',
      chapter_index: selectionDetail.chapterIndex || selectionDetail.sectionIndex || 0,
      chapter_title: selectionDetail.chapterTitle || '',
      note: '',
      color: this.activeColor
    };
    if (this.noteInput) this.noteInput.value = '';
    if (this.deleteBtn) this.deleteBtn.style.display = 'none';
    this.setActiveColor(this.activeColor);
    this._positionPopover(selectionDetail.clientX, selectionDetail.clientY);
  }

  showForExisting(annId, clientX, clientY) {
    const found = this.annotations.find((a) => a.id === annId);
    if (!found) return;
    this.pendingSelection = { ...found };
    if (this.noteInput) this.noteInput.value = found.note || '';
    if (this.deleteBtn) this.deleteBtn.style.display = 'inline-flex';
    this.setActiveColor(found.color || 'zhusha');
    this._positionPopover(clientX, clientY);
  }

  _positionPopover(clientX, clientY) {
    if (!this.popover) return;
    this.popover.classList.add('active');
    if (this.backdrop) this.backdrop.classList.add('active');

    const isMobile = window.innerWidth <= 640;
    if (isMobile) {
      // 移动端：居中浮动在屏幕下半部或根据触摸点避让
      const popH = 210;
      this.popover.style.left = '50%';
      this.popover.style.transform = 'translateX(-50%)';

      if (clientY && clientY > window.innerHeight * 0.6) {
        // 如果用户选区偏下方，浮层放在屏幕上方
        this.popover.style.top = '72px';
        this.popover.style.bottom = 'auto';
      } else {
        // 默认贴近屏幕底部，给软键盘和手指留出最佳操作区
        this.popover.style.top = 'auto';
        this.popover.style.bottom = '24px';
      }
      return;
    }

    // 桌面端：精确定位在选区光标附近
    this.popover.style.transform = 'none';
    this.popover.style.bottom = 'auto';
    const popW = 310;
    const popH = 190;
    const left = Math.max(12, Math.min(window.innerWidth - popW - 12, (clientX || window.innerWidth / 2) - popW / 2));
    let top = (clientY || 200) + 12;
    if (top + popH > window.innerHeight - 16) {
      top = Math.max(16, (clientY || 200) - popH - 24);
    }
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  hidePopover() {
    if (this.popover) this.popover.classList.remove('active');
    if (this.backdrop) this.backdrop.classList.remove('active');
    if (this.view && typeof this.view.clearSelection === 'function') {
      this.view.clearSelection();
    }
    this.pendingSelection = null;
  }

  async saveCurrentAnnotation() {
    if (!this.pendingSelection) return;
    const payload = {
      ...this.pendingSelection,
      color: this.activeColor,
      note: this.noteInput ? this.noteInput.value.trim() : ''
    };

    const res = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      showToast('保存朱批失败');
      return;
    }
    this.hidePopover();
    await this.loadAnnotations();
    showToast('朱批已落库并实时同步至 Obsidian');
  }

  async deleteAnnotation(annId) {
    const res = await fetch(`/api/annotations/${encodeURIComponent(annId)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      showToast('删除批注失败');
      return;
    }
    this.hidePopover();
    await this.loadAnnotations();
    showToast('批注已删除并同步更新 Obsidian');
  }

  async fetchObsidianMarkdown() {
    const res = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/notes`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.markdown || '';
  }
}
