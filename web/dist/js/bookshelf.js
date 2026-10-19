// 宣纸书架与自定义分类双向管理前端逻辑（全服务端 SQLite 配置同步，零 localStorage）
import { SettingsStore, ThemeManager, showToast } from './theme.js';

const state = {
  categories: [],
  books: [],
  activeCategory: 'all',
  searchQuery: '',
  sortBy: 'recent',
  viewMode: 'grid' // grid | table
};

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoStr) {
  if (!isoStr) return '尚未开卷';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '尚未开卷';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

async function loadShelfData() {
  try {
    const params = new URLSearchParams({
      category_id: state.activeCategory,
      q: state.searchQuery,
      sort: state.sortBy
    });
    const [categories, books] = await Promise.all([
      fetchJSON('/api/categories'),
      fetchJSON(`/api/books?${params.toString()}`)
    ]);
    state.categories = categories;
    state.books = books;
    renderCategoryBar();
    renderBooksView();
    populateUploadCategories();
  } catch (err) {
    showToast(`加载书架失败: ${err.message}`);
  }
}

function renderCategoryBar() {
  const container = document.getElementById('category-pills');
  const actionsWrap = document.getElementById('active-cat-actions');
  if (!container) return;

  const pills = [
    { id: 'all', name: '全部藏书', count: null },
    { id: '__uncategorized__', name: '未分类', count: null },
    ...state.categories.map((c) => ({ id: c.id, name: c.name, count: c.book_count }))
  ];

  container.innerHTML = pills.map((p) => `
    <button class="cat-pill ${state.activeCategory === p.id ? 'active' : ''}" data-cat-id="${escapeHTML(p.id)}">
      <span>${escapeHTML(p.name)}</span>
      ${p.count !== null ? `<span class="cat-count">(${p.count})</span>` : ''}
    </button>
  `).join('');

  for (const btn of container.querySelectorAll('.cat-pill')) {
    btn.addEventListener('click', () => {
      state.activeCategory = btn.getAttribute('data-cat-id');
      loadShelfData();
    });
  }

  const activeCatObj = state.categories.find((c) => c.id === state.activeCategory);
  if (actionsWrap) {
    actionsWrap.style.display = activeCatObj ? 'flex' : 'none';
  }
}

function renderBooksView() {
  const container = document.getElementById('books-container');
  const countEl = document.getElementById('total-books-badge');
  if (countEl) countEl.textContent = `共 ${state.books.length} 册典籍`;
  if (!container) return;

  if (state.books.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p style="font-size:16px;margin:0 0 8px;">此分卷下暂无藏书</p>
        <p style="font-size:13px;margin:0;">可将电子书放入本地 <code>library/</code> 文件夹，或点击右上角「入阁藏书」直接上传 EPUB / AZW3 / MOBI / MD / TXT。</p>
      </div>
    `;
    return;
  }

  if (state.viewMode === 'table') {
    renderTableView(container);
  } else {
    renderGridView(container);
  }
}

function buildCategoryOptionsHTML(currentCatId) {
  const opts = [`<option value="" ${!currentCatId ? 'selected' : ''}>未分类</option>`];
  for (const c of state.categories) {
    const sel = c.id === currentCatId ? 'selected' : '';
    opts.push(`<option value="${escapeHTML(c.id)}" ${sel}>${escapeHTML(c.name)}</option>`);
  }
  return opts.join('');
}

function renderGridView(container) {
  container.innerHTML = `
    <div class="books-grid">
      ${state.books.map((b) => {
        const progressText = b.progress_percent > 0 ? `已读 ${b.progress_percent.toFixed(0)}%` : '未开卷';
        const coverSrc = b.cover_url || `/api/books/${encodeURIComponent(b.id)}/cover`;
        const readerUrl = `/reader.html?id=${encodeURIComponent(b.id)}`;
        return `
          <article class="book-card" data-book-id="${escapeHTML(b.id)}">
            <a class="book-cover-link" href="${readerUrl}" title="${escapeHTML(b.title)}">
              <img class="book-cover-img" src="${coverSrc}" alt="${escapeHTML(b.title)}" loading="lazy"/>
              <div class="book-badges-top">
                <span class="badge-format">${escapeHTML(b.file_type)}</span>
                <span class="badge-progress">${progressText}</span>
              </div>
            </a>
            <div class="book-body">
              <a class="book-title" href="${readerUrl}">${escapeHTML(b.title)}</a>
              <div class="book-meta">
                <span>${escapeHTML(b.author || '佚名')}</span>
                <span>${b.annotation_count > 0 ? `朱批 ${b.annotation_count}` : formatFileSize(b.file_size)}</span>
              </div>
              <div class="book-footer">
                <select class="book-cat-select" data-book-id="${escapeHTML(b.id)}" title="调整分卷归类">
                  ${buildCategoryOptionsHTML(b.category_id)}
                </select>
                <div class="book-footer-actions">
                  <a class="btn" style="flex:1;padding:2px 4px;font-size:11px;text-align:center;" href="${readerUrl}">开卷</a>
                  <button class="btn btn-danger js-delete-book" style="padding:2px 6px;font-size:11px;" data-book-id="${escapeHTML(b.id)}" data-book-title="${escapeHTML(b.title)}" title="移除藏书">删</button>
                </div>
              </div>
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;
  bindBookEvents(container);
}

function renderTableView(container) {
  container.innerHTML = `
    <div class="books-table-wrap">
      <table class="books-table">
        <thead>
          <tr>
            <th>书名</th>
            <th>著者</th>
            <th>所属分卷</th>
            <th>格式 / 大小</th>
            <th>研读进度</th>
            <th>朱批数</th>
            <th>上次开卷</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${state.books.map((b) => {
            const readerUrl = `/reader.html?id=${encodeURIComponent(b.id)}`;
            return `
              <tr>
                <td><a class="table-book-link" href="${readerUrl}">《${escapeHTML(b.title)}》</a></td>
                <td>${escapeHTML(b.author || '佚名')}</td>
                <td>
                  <select class="book-cat-select" data-book-id="${escapeHTML(b.id)}">
                    ${buildCategoryOptionsHTML(b.category_id)}
                  </select>
                </td>
                <td><span class="badge-format">${escapeHTML(b.file_type)}</span> · ${formatFileSize(b.file_size)}</td>
                <td>${b.progress_percent > 0 ? `${b.progress_percent.toFixed(1)}%` : '未开卷'}</td>
                <td>${b.annotation_count || 0} 条</td>
                <td>${formatDate(b.last_read_at)}</td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <a class="btn" style="padding:4px 10px;font-size:12px;" href="${readerUrl}">阅读</a>
                    <button class="btn btn-danger js-delete-book" style="padding:4px 8px;font-size:12px;" data-book-id="${escapeHTML(b.id)}" data-book-title="${escapeHTML(b.title)}">移除</button>
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
  bindBookEvents(container);
}

function bindBookEvents(container) {
  for (const sel of container.querySelectorAll('.book-cat-select')) {
    sel.addEventListener('change', async (e) => {
      const bookId = e.target.getAttribute('data-book-id');
      const targetCatId = e.target.value;
      try {
        await fetchJSON(`/api/books/${encodeURIComponent(bookId)}/category`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category_id: targetCatId })
        });
        showToast('已同步转移书籍分卷与本地目录');
        loadShelfData();
      } catch (err) {
        showToast(`调整分类失败: ${err.message}`);
        loadShelfData();
      }
    });
  }

  for (const btn of container.querySelectorAll('.js-delete-book')) {
    btn.addEventListener('click', async () => {
      const bookId = btn.getAttribute('data-book-id');
      const title = btn.getAttribute('data-book-title');
      if (!window.confirm(`确定要从书库移除《${title}》吗？`)) return;
      try {
        await fetchJSON(`/api/books/${encodeURIComponent(bookId)}`, { method: 'DELETE' });
        showToast(`《${title}》已移除`);
        loadShelfData();
      } catch (err) {
        showToast(`移除失败: ${err.message}`);
      }
    });
  }
}

function populateUploadCategories() {
  const sel = document.getElementById('upload-category-select');
  if (!sel) return;
  const currentCat = (state.activeCategory !== 'all' && state.activeCategory !== '__uncategorized__')
    ? state.activeCategory
    : '';
  sel.innerHTML = buildCategoryOptionsHTML(currentCat);
}

async function initShelfApp() {
  const settings = await SettingsStore.load();
  state.viewMode = settings.shelf_view || 'grid';
  ThemeManager.setTheme(settings.theme || 'rice-paper', false);

  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.value = ThemeManager.current;
    themeSelect.addEventListener('change', (e) => {
      ThemeManager.setTheme(e.target.value, true);
    });
  }

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    let timer = null;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.searchQuery = e.target.value.trim();
        loadShelfData();
      }, 220);
    });
  }

  const sortSelect = document.getElementById('sort-select');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      loadShelfData();
    });
  }

  const viewToggleBtn = document.getElementById('btn-toggle-view');
  const updateViewBtnLabel = () => {
    if (viewToggleBtn) {
      viewToggleBtn.textContent = state.viewMode === 'grid' ? '切换：水墨书目' : '切换：封套画廊';
    }
  };
  updateViewBtnLabel();
  if (viewToggleBtn) {
    viewToggleBtn.addEventListener('click', () => {
      state.viewMode = state.viewMode === 'grid' ? 'table' : 'grid';
      SettingsStore.save({ shelf_view: state.viewMode });
      updateViewBtnLabel();
      renderBooksView();
    });
  }

  const scanBtn = document.getElementById('btn-scan-library');
  if (scanBtn) {
    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      try {
        const res = await fetchJSON('/api/library/scan', { method: 'POST' });
        showToast(`${res.message}（检视 ${res.scanned_count} 册）`);
        await loadShelfData();
      } catch (err) {
        showToast(`扫描失败: ${err.message}`);
      } finally {
        scanBtn.disabled = false;
      }
    });
  }

  const newCatModal = document.getElementById('modal-category');
  const catInput = document.getElementById('input-category-name');
  const catModalTitle = document.getElementById('modal-category-title');
  let catModalMode = 'create';

  document.getElementById('btn-new-category')?.addEventListener('click', () => {
    catModalMode = 'create';
    catModalTitle.textContent = '新建藏书分卷';
    catInput.value = '';
    newCatModal.classList.add('active');
    catInput.focus();
  });

  document.getElementById('btn-rename-category')?.addEventListener('click', () => {
    const activeCat = state.categories.find((c) => c.id === state.activeCategory);
    if (!activeCat) return;
    catModalMode = 'rename';
    catModalTitle.textContent = `重命名分卷【${activeCat.name}】`;
    catInput.value = activeCat.name;
    newCatModal.classList.add('active');
    catInput.focus();
  });

  document.getElementById('btn-cancel-category')?.addEventListener('click', () => {
    newCatModal.classList.remove('active');
  });

  document.getElementById('btn-save-category')?.addEventListener('click', async () => {
    const name = catInput.value.trim();
    if (!name) {
      showToast('请输入分卷名称');
      return;
    }
    try {
      if (catModalMode === 'create') {
        const created = await fetchJSON('/api/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        state.activeCategory = created.id;
        showToast(`已创建分卷【${created.name}】及本地文件夹`);
      } else {
        await fetchJSON(`/api/categories/${encodeURIComponent(state.activeCategory)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        showToast('分卷已重命名并同步本地文件夹');
      }
      newCatModal.classList.remove('active');
      loadShelfData();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('btn-delete-category')?.addEventListener('click', async () => {
    const activeCat = state.categories.find((c) => c.id === state.activeCategory);
    if (!activeCat) return;
    if (!window.confirm(`确定要移除分卷【${activeCat.name}】吗？\n该分卷下的书籍将安全移回「未分类」根目录，绝不删除原文件。`)) {
      return;
    }
    try {
      await fetchJSON(`/api/categories/${encodeURIComponent(activeCat.id)}`, { method: 'DELETE' });
      state.activeCategory = 'all';
      showToast(`分卷【${activeCat.name}】已删除，藏书已归入未分类`);
      loadShelfData();
    } catch (err) {
      showToast(err.message);
    }
  });

  const uploadModal = document.getElementById('modal-upload');
  document.getElementById('btn-open-upload')?.addEventListener('click', () => {
    populateUploadCategories();
    uploadModal.classList.add('active');
  });
  document.getElementById('btn-cancel-upload')?.addEventListener('click', () => {
    uploadModal.classList.remove('active');
  });
  document.getElementById('btn-submit-upload')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('upload-file-input');
    const catSelect = document.getElementById('upload-category-select');
    if (!fileInput.files || fileInput.files.length === 0) {
      showToast('请先选择电子书文件');
      return;
    }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    fd.append('category_id', catSelect.value || '');
    const submitBtn = document.getElementById('btn-submit-upload');
    submitBtn.disabled = true;
    try {
      await fetchJSON('/api/books/upload', { method: 'POST', body: fd });
      uploadModal.classList.remove('active');
      fileInput.value = '';
      showToast('新书已成功入阁');
      loadShelfData();
    } catch (err) {
      showToast(`上传失败: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });

  loadShelfData();
}

document.addEventListener('DOMContentLoaded', initShelfApp);
