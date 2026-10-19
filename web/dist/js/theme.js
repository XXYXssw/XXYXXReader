// 本地用户偏好存储（localStorage，按设备独立保存）与服务端 AI 配置存储
//
// 设计原则：
//   - LocalPrefs：排版/翻页/字号/主题/书架视图/物理键等“用户偏好”全部存在浏览器本地，
//     天然按设备隔离（手机、平板、墨水屏各存一份，互不干扰）。
//   - SettingsStore：仅用于 AI 配置（api_url / api_key / model / system_prompt），
//     这些是密钥类全局配置，放服务端 SQLite 一份即可。

const PREFS_KEY = 'xxyxx_reader_prefs_v1';
// 旧版（服务端同步之前）曾使用的三个独立本地键，首次加载时一次性迁移进来
const LEGACY_KEYS = {
  reader_settings: 'xxyxx_reader_settings',
  shelf_view: 'xxyxx_shelf_view',
  theme: 'xxyxx_theme'
};

export const LocalPrefs = {
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
    // AI 伴读面板的文字大小（仅本设备生效，纯 localStorage）
    ai_font_size: 14
  },

  load() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        this.data = {
          ...this.data,
          ...saved,
          reader_settings: { ...this.data.reader_settings, ...(saved.reader_settings || {}) },
          custom_keys: { ...this.data.custom_keys, ...(saved.custom_keys || {}) }
        };
      } else {
        this._migrateLegacy();
      }
      this.data.ai_font_size = this._clampAIFontSize(this.data.ai_font_size);
      // 无论是否发生迁移，旧版遗留键一律清除
      for (const k of Object.values(LEGACY_KEYS)) {
        localStorage.removeItem(k);
      }
    } catch (_) {}
    return this.data;
  },

  // 从旧版分散的 localStorage 键迁移一次，迁移后立即落盘并删除旧键
  _migrateLegacy() {
    try {
      let migrated = false;
      const legacyRS = localStorage.getItem(LEGACY_KEYS.reader_settings);
      if (legacyRS) {
        const parsed = JSON.parse(legacyRS);
        if (parsed && typeof parsed === 'object') {
          this.data.reader_settings = { ...this.data.reader_settings, ...parsed };
          migrated = true;
        }
      }
      const legacyView = localStorage.getItem(LEGACY_KEYS.shelf_view);
      if (legacyView === 'grid' || legacyView === 'table') {
        this.data.shelf_view = legacyView;
        migrated = true;
      }
      const legacyTheme = localStorage.getItem(LEGACY_KEYS.theme);
      if (legacyTheme) {
        this.data.theme = legacyTheme.replace(/^"|"$/g, '');
        migrated = true;
      }
      if (migrated) {
        localStorage.setItem(PREFS_KEY, JSON.stringify(this.data));
      }
    } catch (_) {}
  },

  _clampAIFontSize(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 14;
    return Math.max(11, Math.min(24, Math.round(n)));
  },

  getAIFontSize() {
    return this._clampAIFontSize(this.data.ai_font_size);
  },

  setAIFontSize(size) {
    const v = this._clampAIFontSize(size);
    this.save({ ai_font_size: v });
    return v;
  },

  save(partial) {
    Object.assign(this.data, partial);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.data));
    } catch (_) {}
    return this.data;
  }
};

// 仅用于 AI 配置（服务端 SQLite），不再承载任何排版偏好
export const SettingsStore = {
  data: {
    ai_config: {
      api_url: 'https://api.openai.com/v1',
      api_key: '',
      model: 'gpt-4o-mini',
      system_prompt: ''
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
          this.data = { ai_config: { ...this.data.ai_config, ...(remote.ai_config || {}) } };
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
        this.data = { ai_config: { ...this.data.ai_config, ...(updated.ai_config || {}) } };
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
      LocalPrefs.save({ theme: name });
    }
    window.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { theme: name, palette: this.themes[name] }
    }));
  },

  getPalette() {
    return this.themes[this.current] || this.themes['rice-paper'];
  },

  init() {
    const prefs = LocalPrefs.load();
    this.setTheme(prefs.theme || 'rice-paper', false);
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
