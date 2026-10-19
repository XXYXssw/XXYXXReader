// 全局服务端设置存储与主题管理器（全量持久化在服务端 SQLite，零 localStorage）
export const SettingsStore = {
  data: {
    theme: 'rice-paper',
    shelf_view: 'grid',
    reader_settings: {
      flipMode: 'instant_tap',
      fontSize: 19,
      fontFamily: 'serif',
      lineHeight: 1.8,
      margin: 6,
      marginUnit: 'percent',
      indent: true,
      justify: true
    },
    custom_keys: {
      next: [],
      prev: []
    },
    ai_config: {
      api_url: 'https://api.openai.com/v1',
      api_key: '',
      model: 'gpt-4o-mini',
      system_prompt: '',
      default_context_length: 1200
    }
  },
  _loaded: false,
  _loadingPromise: null,

  async load() {
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = (async () => {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const remote = await res.json();
          this.data = { ...this.data, ...remote };
          this._loaded = true;
        }
      } catch (_) {}
      return this.data;
    })();
    const out = await this._loadingPromise;
    this._loadingPromise = null;
    return out;
  },

  async save(partial) {
    Object.assign(this.data, partial);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial)
      });
      if (res.ok) {
        const updated = await res.json();
        this.data = { ...this.data, ...updated };
      }
    } catch (_) {}
    return this.data;
  }
};

export const ThemeManager = {
  current: 'rice-paper',
  themes: {
    'rice-paper': {
      name: '宣纸墨香',
      bg: '#e6e1d8',
      fg: '#2c2824',
      muted: '#6b6358',
      accent: '#8b6f5c',
      quoteBg: 'rgba(139, 111, 92, 0.08)',
      isEink: false
    },
    'e-ink': {
      name: '墨水屏纯黑白',
      bg: '#ffffff',
      fg: '#000000',
      muted: '#222222',
      accent: '#000000',
      quoteBg: '#f5f5f5',
      isEink: true
    },
    'modern-white': {
      name: '现代素白',
      bg: '#f8f9fa',
      fg: '#1a1a1a',
      muted: '#5c636a',
      accent: '#3b5bdb',
      quoteBg: 'rgba(0, 0, 0, 0.04)',
      isEink: false
    },
    'dark-ink': {
      name: '水墨暗夜',
      bg: '#1c1a17',
      fg: '#c8c3ba',
      muted: '#8f887d',
      accent: '#b58d74',
      quoteBg: 'rgba(200, 195, 186, 0.06)',
      isEink: false
    }
  },

  setTheme(name, persist = true) {
    if (!this.themes[name]) name = 'rice-paper';
    document.documentElement.setAttribute('data-theme', name);
    this.current = name;
    if (persist) {
      SettingsStore.save({ theme: name });
    }
    window.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { theme: name, palette: this.themes[name] }
    }));
  },

  getPalette() {
    return this.themes[this.current] || this.themes['rice-paper'];
  },

  async init() {
    const settings = await SettingsStore.load();
    const saved = settings.theme || 'rice-paper';
    this.setTheme(saved, false);
  }
};

export function showToast(message, duration = 2400) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const item = document.createElement('div');
  item.className = 'toast-msg';
  item.textContent = message;
  container.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, duration);
}
