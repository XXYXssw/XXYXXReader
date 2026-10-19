// AI 伴读模块：集成 QuikChat，支持特殊引用块（非大段明文复制）、多会话历史
// 工具调用默认以可折叠块展示（无需任何开关按钮），AI 配置仅支持 OpenAI 兼容协议
import quikchatMD from './vendor/quikchat-md.esm.min.js';
import { SettingsStore, ThemeManager, showToast } from './theme.js';

const QUOTE_HEADER_RE = /^<!--XXYXX_QUOTE:([^\n]+?)-->\n?/;
// 工具调用消息的折叠块标记前缀，用于把多行 tool 信息折叠为一块
const TOOL_BLOCK_RE = /^<!--XXYXX_TOOL:([^\n]+?)-->\n?/;

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
      tb.setAttribute('placeholder', '');
      tb.removeAttribute('placeholder');
    }

    // 委托点击：工具折叠块展开/收起、引用块展开、引用定位跳转
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
      const toolHead = e.target.closest('.ai-tool-block-head');
      if (toolHead) {
        e.preventDefault();
        e.stopPropagation();
        toolHead.closest('.ai-tool-block')?.classList.toggle('expanded');
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

    // 工具调用折叠块（默认收起，点击头部展开）
    const tm = text.match(TOOL_BLOCK_RE);
    if (tm) {
      text = text.slice(tm[0].length);
      try {
        const info = JSON.parse(decodeURIComponent(tm[1]));
        quoteHTML += this._renderToolBlock(info);
      } catch (_) {}
    }

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
          quoteHTML += `
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

  // 工具调用折叠块：头部一行摘要，点击展开参数与返回内容
  _renderToolBlock({ name = 'tool', args = '{}', summary = '' } = {}) {
    const safeName = escapeHTML(name);
    return `
      <div class="ai-tool-block">
        <div class="ai-tool-block-head">
          <span class="ai-tool-block-title">⚙ 工具调用 · <code>${safeName}</code></span>
          <span class="ai-tool-block-toggle">展开 ▾</span>
        </div>
        <div class="ai-tool-block-body">
          <div class="ai-tool-block-row"><span class="ai-tool-block-label">参数</span><code>${escapeHTML(args)}</code></div>
          <div class="ai-tool-block-row"><span class="ai-tool-block-label">返回</span><div class="ai-tool-block-out">${escapeHTML(summary)}</div></div>
        </div>
      </div>
    `;
  }

  // 把一条工具调用消息编码为可折叠块（存入会话历史时仍保留原始工具名/参数）
  _encodeToolMessage(toolName, toolArgs, content) {
    const summary = String(content || '');
    const encoded = encodeURIComponent(JSON.stringify({
      name: toolName || 'tool',
      args: toolArgs || '{}',
      summary: summary.length > 1200 ? summary.slice(0, 1200) + '…' : summary
    }));
    return `<!--XXYXX_TOOL:${encoded}-->`;
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

    // 保存 AI 配置到服务端 SQLite（仅 OpenAI 兼容协议）
    document.getElementById('btn-save-ai-config')?.addEventListener('click', async () => {
      const aiConfig = {
        api_url: document.getElementById('ai-cfg-url')?.value.trim() || 'https://api.openai.com/v1',
        api_key: document.getElementById('ai-cfg-key')?.value.trim() || '',
        model: document.getElementById('ai-cfg-model')?.value.trim() || 'gpt-4o-mini',
        system_prompt: document.getElementById('ai-cfg-prompt')?.value.trim() || ''
      };
      await SettingsStore.save({ ai_config: aiConfig });
      configModal?.classList.remove('active');
      showToast('AI 伴读配置已保存');
    });
  }

  async _populateAIConfigForm() {
    const settings = await SettingsStore.load();
    const cfg = settings.ai_config || {};
    const urlEl = document.getElementById('ai-cfg-url');
    const keyEl = document.getElementById('ai-cfg-key');
    const modelEl = document.getElementById('ai-cfg-model');
    const promptEl = document.getElementById('ai-cfg-prompt');
    if (urlEl) urlEl.value = cfg.api_url || 'https://api.openai.com/v1';
    if (keyEl) keyEl.value = cfg.api_key || '';
    if (modelEl) modelEl.value = cfg.model || 'gpt-4o-mini';
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
          this.chat.messageAddFull({
            content: this._encodeToolMessage(m.tool_name, m.tool_arguments, m.content),
            userString: `⚙ ${m.tool_name || 'tool'}`,
            align: 'left',
            role: 'tool'
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
          this.chat.messageAddFull({
            content: this._encodeToolMessage(tm.tool_name, tm.tool_arguments, tm.content),
            userString: `⚙ ${tm.tool_name || 'tool'}`,
            align: 'left',
            role: 'tool'
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
