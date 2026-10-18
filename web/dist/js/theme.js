// 全局主题管理器与通用 UI 工具
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

  setTheme(name) {
    if (!this.themes[name]) name = 'rice-paper';
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem('xxyxx_theme', name);
    this.current = name;
    window.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { theme: name, palette: this.themes[name] }
    }));
  },

  getPalette() {
    return this.themes[this.current] || this.themes['rice-paper'];
  },

  init() {
    const saved = localStorage.getItem('xxyxx_theme') || 'rice-paper';
    this.setTheme(saved);
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
