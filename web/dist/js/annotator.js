// 四色文人印彩划线批注与 AI 问书联动模块（全服务端 SQLite 存储）
import { showToast } from './theme.js';

export class AnnotatorController {
  constructor({ bookId, view, onAnnotationsChanged, onAskAI }) {
    this.bookId = bookId;
    this.view = view;
    this.onAnnotationsChanged = onAnnotationsChanged;
    this.onAskAI = onAskAI;
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

    // 划线弹窗中的「✦ 问 AI」按钮：将当前选区作为特殊引用块挂入 AI 伴读面板
    document.getElementById('btn-ask-ai-annotation')?.addEventListener('click', () => {
      if (!this.pendingSelection) return;
      const quotePayload = {
        selected_text: this.pendingSelection.selected_text,
        chapter_title: this.pendingSelection.chapter_title || '',
        chapter_index: this.pendingSelection.chapter_index || 0,
        cfi: this.pendingSelection.cfi || '',
        surround_text: this.pendingSelection.surround_text || ''
      };
      this.hidePopover();
      if (this.onAskAI) {
        this.onAskAI(quotePayload);
      }
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
      surround_text: selectionDetail.surroundText || '',
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
      this.popover.style.left = '50%';
      this.popover.style.transform = 'translateX(-50%)';

      if (clientY && clientY > window.innerHeight * 0.6) {
        this.popover.style.top = '72px';
        this.popover.style.bottom = 'auto';
      } else {
        this.popover.style.top = 'auto';
        this.popover.style.bottom = '24px';
      }
      return;
    }

    this.popover.style.transform = 'none';
    this.popover.style.bottom = 'auto';
    const popW = 330;
    const popH = 195;
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
    showToast('朱批已保存至数据库');
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
    showToast('批注已删除');
  }
}
