// AI 伴读模块：集成 QuikChat，支持特殊引用块（非大段明文复制）、多会话历史、工具轨迹开关与服务端 AI 配置
import quikchatMD from './vendor/quikchat-md.esm.min.js';
import { SettingsStore, ThemeManager, showToast } from './theme.js';

const QUOTE_HEADER_RE = /^<!--XXYXX_QUOTE:([^\n]+?)-->\n?/;

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

export class AIChatController {
  constructor({ bookId, getBookContext, onJumpToCFI }) {
    this.bookId = bookId;
    this.getBookContext = getBookContext; // () => ({ chapterIndex, chapterTitle })
    this.onJumpToCFI = onJumpToCFI;
    this.sessions = [];
    this.activeSessionId = '';
    this.pendingQuote = null;
    this.showToolCalls = false;
    this.isSending = false;
    this.chat = null;

    this._initQuikChat();
    this._bindControls();
  }

  _getQuikChatTheme() {
    const t = ThemeManager.current;
    if (t === 'dark-ink') return 'quikchat-theme-dark';
    if (t === 'e-ink') return 'quikchat-theme-light';
    if (t === 'modern-white') return 'quikchat-theme-light';
    return 'quikchat-theme-warm';
  }

  _initQuikChat() {
    const mountEl = document.getElementById('quikchat-mount');
    if (!mountEl) return;

    this.chat = new quikchatMD(
      mountEl,
      (chatInstance, messageText) => {
        this.handleUserSend(messageText);
      },
      {
        theme: this._getQuikChatTheme(),
        trackHistory: true,
        titleArea: { title: '书斋伴读', show: false, align: 'left' },
        messagesArea: { alternating: false },
        messageFormatter: (rawContent) => this._formatMessageHTML(rawContent)
      }
    );

    this.chat.inputAreaSetButtonText('问书');
    const tb = mountEl.querySelector('.quikchat-input-textbox');
    if (tb) {
      tb.setAttribute('placeholder', '输入问题与 AI 探讨本书（Shift+Enter 换行，附带引用时可直接发送）…');
    }

    // 委托点击聊天记录中的特殊引用块（支持展开/收起全文或跳回原文位置）
    mountEl.addEventListener('click', (e) => {
      const jumpBtn = e.target.closest('.js-quote-jump');
      if (jumpBtn) {
        e.preventDefault();
        e.stopPropagation();
        const cfi = jumpBtn.getAttribute('data-cfi');
        if (cfi && this.onJumpToCFI) {
          this.onJumpToCFI(cfi);
        }
        return;
      }
      const quoteBlock = e.target.closest('.ai-special-quote-block');
      if (quoteBlock) {
        quoteBlock.classList.toggle('expanded');
      }
    });

    window.addEventListener('theme-changed', () => {
      if (this.chat) {
        this.chat.changeTheme(this._getQuikChatTheme());
      }
    });
  }

  // 将带特殊引用块标记的消息格式化为折叠式古风引用卡片 + Markdown 正文
  _formatMessageHTML(rawContent) {
    let text = String(rawContent || '');
    let quoteHTML = '';

    const m = text.match(QUOTE_HEADER_RE);
    if (m) {
      text = text.slice(m[0].length);
      try {
        const q = JSON.parse(decodeURIComponent(m[1]));
        if (q && q.selected_text) {
          const chap = q.chapter_title || `第 ${(q.chapter_index || 0) + 1} 节`;
          const charLen = Array.from(q.selected_text).length;
          const jumpLink = q.cfi
            ? `<button type="button" class="ai-quote-jump-btn js-quote-jump" data-cfi="${escapeHTML(q.cfi)}">定位原文 ↗</button>`
            : '';
          quoteHTML = `
            <div class="ai-special-quote-block" title="点击展开或收起引用原文">
              <div class="ai-quote-header">
                <span class="ai-quote-badge">✦ 原文引用 · ${escapeHTML(chap)} (${charLen}字)</span>
                ${jumpLink}
              </div>
              <div class="ai-quote-body">“${escapeHTML(q.selected_text)}”</div>
            </div>
          `;
        }
      } catch (_) {}
    }

    const mdHTML = quikchatMD.quikdown ? quikchatMD.quikdown(text) : escapeHTML(text);
    return quoteHTML + `<div class="ai-md-body">${mdHTML}</div>`;
  }

  _encodeContentWithQuote(text, quote) {
    if (!quote || !quote.selected_text) return text;
    const encoded = encodeURIComponent(JSON.stringify({
      selected_text: quote.selected_text,
      chapter_title: quote.chapter_title || '',
      chapter_index: quote.chapter_index || 0,
      cfi: quote.cfi || ''
    }));
    return `<!--XXYXX_QUOTE:${encoded}-->\n${text}`;
  }

  _bindControls() {
    // 会话切换
    const sessionSelect = document.getElementById('ai-session-select');
    sessionSelect?.addEventListener('change', (e) => {
      this.switchSession(e.target.value);
    });

    // 新建对话
    document.getElementById('btn-ai-new-session')?.addEventListener('click', async () => {
      try {
        const res = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/ai/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: `伴读研习 #${this.sessions.length + 1}` })
        });
        if (res.ok) {
          const created = await res.json();
          await this.loadSessions(created.id);
          showToast('已开启新对话');
        }
      } catch (err) {
        showToast(`新建对话失败: ${err.message}`);
      }
    });

    // 删除当前对话
    document.getElementById('btn-ai-delete-session')?.addEventListener('click', async () => {
      if (!this.activeSessionId) return;
      if (!window.confirm('确定要删除当前对话历史吗？')) return;
      try {
        await fetch(`/api/ai/sessions/${encodeURIComponent(this.activeSessionId)}`, {
          method: 'DELETE'
        });
        this.activeSessionId = '';
        await this.loadSessions();
        showToast('当前对话已删除');
      } catch (err) {
        showToast(`删除失败: ${err.message}`);
      }
    });

    // 切换显示/隐藏 AI 工具调用轨迹
    const toolBtn = document.getElementById('btn-ai-toggle-tools');
    toolBtn?.addEventListener('click', () => {
      this.showToolCalls = !this.showToolCalls;
      toolBtn.classList.toggle('active', this.showToolCalls);
      if (this.chat) {
        this.chat.messageSetVisibleByTag('tool-call', this.showToolCalls);
      }
    });

    // 移除输入框上方挂载的特殊引用块
    document.getElementById('btn-ai-clear-quote')?.addEventListener('click', () => {
      this.clearAttachedQuote();
    });

    // 展开/折叠挂载的引用块预览
    document.getElementById('ai-attached-quote-text')?.addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('expanded');
    });

    // 打开/关闭 AI 配置模态弹窗
    const configModal = document.getElementById('modal-ai-config');
    document.getElementById('btn-ai-open-config')?.addEventListener('click', async () => {
      await this._populateAIConfigForm();
      configModal?.classList.add('active');
    });
    document.getElementById('btn-cancel-ai-config')?.addEventListener('click', () => {
      configModal?.classList.remove('active');
    });

    // 快速填入常用 API 地址预设
    for (const presetBtn of document.querySelectorAll('.js-ai-preset')) {
      presetBtn.addEventListener('click', () => {
        const url = presetBtn.getAttribute('data-url');
        const model = presetBtn.getAttribute('data-model');
        const urlInput = document.getElementById('ai-cfg-url');
        const modelInput = document.getElementById('ai-cfg-model');
        if (urlInput && url) urlInput.value = url;
        if (modelInput && model) modelInput.value = model;
      });
    }

    // 拉取远程可用模型列表
    const fetchModelsBtn = document.getElementById('btn-ai-fetch-models');
    fetchModelsBtn?.addEventListener('click', async () => {
      const apiURL = document.getElementById('ai-cfg-url')?.value.trim() || '';
      const apiKey = document.getElementById('ai-cfg-key')?.value.trim() || '';
      fetchModelsBtn.disabled = true;
      fetchModelsBtn.textContent = '拉取中…';
      try {
        const res = await fetch('/api/ai/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_url: apiURL, api_key: apiKey })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const models = data.models || [];
        const sel = document.getElementById('ai-cfg-model-select');
        if (sel && models.length > 0) {
          sel.style.display = 'block';
          sel.innerHTML = `<option value="">-- 从接口返回的 ${models.length} 个模型中选择 --</option>` +
            models.map((m) => `<option value="${escapeHTML(m)}">${escapeHTML(m)}</option>`).join('');
          sel.onchange = () => {
            if (sel.value) {
              document.getElementById('ai-cfg-model').value = sel.value;
            }
          };
          showToast(`成功拉取 ${models.length} 个可用模型`);
        } else {
          showToast('接口未返回模型列表，请直接手动输入模型名');
        }
      } catch (err) {
        showToast(`拉取模型失败: ${err.message}`);
      } finally {
        fetchModelsBtn.disabled = false;
        fetchModelsBtn.textContent = '拉取模型列表';
      }
    });

    // 保存 AI 配置到服务端 SQLite
    document.getElementById('btn-save-ai-config')?.addEventListener('click', async () => {
      const aiConfig = {
        api_url: document.getElementById('ai-cfg-url')?.value.trim() || 'https://api.openai.com/v1',
        api_key: document.getElementById('ai-cfg-key')?.value.trim() || '',
        model: document.getElementById('ai-cfg-model')?.value.trim() || 'gpt-4o-mini',
        default_context_length: Math.max(100, Math.min(8000, Number(document.getElementById('ai-cfg-ctx-len')?.value) || 1200)),
        system_prompt: document.getElementById('ai-cfg-prompt')?.value.trim() || ''
      };
      await SettingsStore.save({ ai_config: aiConfig });
      configModal?.classList.remove('active');
      showToast('AI 伴读配置已保存至服务端数据库');
    });
  }

  async _populateAIConfigForm() {
    const settings = await SettingsStore.load();
    const cfg = settings.ai_config || {};
    const urlEl = document.getElementById('ai-cfg-url');
    const keyEl = document.getElementById('ai-cfg-key');
    const modelEl = document.getElementById('ai-cfg-model');
    const ctxEl = document.getElementById('ai-cfg-ctx-len');
    const promptEl = document.getElementById('ai-cfg-prompt');
    if (urlEl) urlEl.value = cfg.api_url || 'https://api.openai.com/v1';
    if (keyEl) keyEl.value = cfg.api_key || '';
    if (modelEl) modelEl.value = cfg.model || 'gpt-4o-mini';
    if (ctxEl) ctxEl.value = cfg.default_context_length || 1200;
    if (promptEl) promptEl.value = cfg.system_prompt || '';
  }

  async loadSessions(preferSessionId = '') {
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/ai/sessions`);
      if (!res.ok) return;
      this.sessions = await res.json();
      const targetId = preferSessionId || this.activeSessionId || (this.sessions[0]?.id ?? '');
      this._renderSessionSelect(targetId);
      if (targetId) {
        await this.switchSession(targetId);
      }
    } catch (_) {}
  }

  _renderSessionSelect(selectedId) {
    const sel = document.getElementById('ai-session-select');
    if (!sel) return;
    sel.innerHTML = this.sessions.map((s) => `
      <option value="${escapeHTML(s.id)}" ${s.id === selectedId ? 'selected' : ''}>
        ${escapeHTML(s.title)}
      </option>
    `).join('');
  }

  async switchSession(sessionId) {
    this.activeSessionId = sessionId;
    const sel = document.getElementById('ai-session-select');
    if (sel && sel.value !== sessionId) sel.value = sessionId;

    if (!this.chat) return;
    this.chat.historyImport([]);

    try {
      const res = await fetch(`/api/ai/sessions/${encodeURIComponent(sessionId)}/messages`);
      if (!res.ok) return;
      const messages = await res.json();

      if (messages.length === 0) {
        this.chat.messageAddFull({
          content: '展卷有益。你可以直接向我提问书中内容，或在正文中选词点击 **「✦ 问 AI」** 附上原文引用块来深入探讨。',
          userString: '伴读先生',
          align: 'left',
          role: 'assistant'
        });
        return;
      }

      for (const m of messages) {
        if (m.role === 'user') {
          this.chat.messageAddFull({
            content: this._encodeContentWithQuote(m.content, m.quote),
            userString: '读者',
            align: 'right',
            role: 'user'
          });
        } else if (m.role === 'tool') {
          const toolInfo = `**调用工具**: \`${m.tool_name || 'tool'}\`\n**参数**: \`${m.tool_arguments || '{}'}\`\n**返回摘要**: \`${String(m.content || '').slice(0, 260)}…\``;
          this.chat.messageAddFull({
            content: toolInfo,
            userString: `🔧 工具 · ${m.tool_name || 'tool'}`,
            align: 'left',
            role: 'tool',
            visible: this.showToolCalls,
            tags: ['tool-call']
          });
        } else if (m.role === 'assistant') {
          this.chat.messageAddFull({
            content: m.content,
            userString: '伴读先生',
            align: 'left',
            role: 'assistant'
          });
        }
      }
    } catch (_) {}
  }

  // 挂载特殊引用块（不把大段文字塞进输入框，而以精致折叠引用块展示在输入框上方）
  attachQuote(quoteData) {
    if (!quoteData || !quoteData.selected_text) return;
    this.pendingQuote = {
      selected_text: quoteData.selected_text.trim(),
      chapter_title: quoteData.chapter_title || '',
      chapter_index: Number(quoteData.chapter_index) || 0,
      cfi: quoteData.cfi || '',
      surround_text: quoteData.surround_text || ''
    };

    const bar = document.getElementById('ai-attached-quote');
    const badge = document.getElementById('ai-attached-quote-badge');
    const textEl = document.getElementById('ai-attached-quote-text');
    if (bar && badge && textEl) {
      const chap = this.pendingQuote.chapter_title || `第 ${this.pendingQuote.chapter_index + 1} 节`;
      const charCount = Array.from(this.pendingQuote.selected_text).length;
      badge.textContent = `✦ 引用块 · ${chap} (${charCount}字)`;
      textEl.textContent = `“${this.pendingQuote.selected_text}”`;
      textEl.classList.remove('expanded');
      bar.style.display = 'block';
    }

    const tb = document.querySelector('#quikchat-mount .quikchat-input-textbox');
    if (tb) {
      tb.focus();
    }
  }

  clearAttachedQuote() {
    this.pendingQuote = null;
    const bar = document.getElementById('ai-attached-quote');
    if (bar) bar.style.display = 'none';
  }

  async handleUserSend(rawText) {
    if (this.isSending || !this.chat) return;
    let question = String(rawText || '').trim();
    if (!question && !this.pendingQuote) {
      return;
    }
    if (!question && this.pendingQuote) {
      question = '请结合上下文为我解读并赏析这段文字。';
    }

    const quoteToSend = this.pendingQuote ? { ...this.pendingQuote } : null;
    this.clearAttachedQuote();

    // 1. 在 QuikChat 界面追加用户消息（含特殊引用块）
    this.chat.messageAddFull({
      content: this._encodeContentWithQuote(question, quoteToSend),
      userString: '读者',
      align: 'right',
      role: 'user'
    });

    // 2. 显示思考动画并锁定输入栏
    this.isSending = true;
    this.chat.inputAreaSetEnabled(false);
    this.chat.inputAreaSetButtonText('研读中…');
    const typingId = this.chat.messageAddTypingIndicator('伴读先生', 'left');

    const bookCtx = this.getBookContext ? this.getBookContext() : { chapterIndex: 0 };

    try {
      const res = await fetch(`/api/books/${encodeURIComponent(this.bookId)}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.activeSessionId,
          message: question,
          quote: quoteToSend,
          current_chapter_index: bookCtx.chapterIndex || 0
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
      }

      // 移除 typing 占位以便按顺序插入工具调用与最终回复
      this.chat.messageRemove(typingId);

      if (Array.isArray(data.tool_messages)) {
        for (const tm of data.tool_messages) {
          const toolInfo = `**调用工具**: \`${tm.tool_name || 'tool'}\`\n**参数**: \`${tm.tool_arguments || '{}'}\`\n**返回摘要**: \`${String(tm.content || '').slice(0, 260)}…\``;
          this.chat.messageAddFull({
            content: toolInfo,
            userString: `🔧 工具 · ${tm.tool_name || 'tool'}`,
            align: 'left',
            role: 'tool',
            visible: this.showToolCalls,
            tags: ['tool-call']
          });
        }
      }

      const replyContent = data.assistant_message?.content || '（未返回内容）';
      this.chat.messageAddFull({
        content: replyContent,
        userString: '伴读先生',
        align: 'left',
        role: 'assistant'
      });

      if (data.session && data.session.id) {
        this.activeSessionId = data.session.id;
        const idx = this.sessions.findIndex((s) => s.id === data.session.id);
        if (idx >= 0) {
          this.sessions[idx] = data.session;
        } else {
          this.sessions.unshift(data.session);
        }
        this._renderSessionSelect(this.activeSessionId);
      }
    } catch (err) {
      this.chat.messageReplaceContent(
        typingId,
        `⚠️ **伴读请求未成功**：${err.message}\n\n请点击面板右上角 **「⚙ 设置」** 检查 API 地址、API Key 与模型名称是否正确。`
      );
    } finally {
      this.isSending = false;
      this.chat.inputAreaSetEnabled(true);
      this.chat.inputAreaSetButtonText('问书');
    }
  }
}
