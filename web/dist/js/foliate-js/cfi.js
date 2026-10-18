// Foliate-core CFI (Canonical Fragment Identifier) 与前后文双重锚点引擎
export const CFIEngine = {
  // 从当前选区 Range 生成标准 epubcfi(...) 及前后文 16 字锚点
  fromRange(range, sectionIndex = 0) {
    if (!range) return null;
    const selectedText = range.toString().trim();
    if (!selectedText) return null;

    const spineStep = (sectionIndex + 1) * 2;
    const startPath = this._nodeToPath(range.startContainer, range.startOffset);
    const endPath = this._nodeToPath(range.endContainer, range.endOffset);
    const cfi = `epubcfi(/6/${spineStep}![${startPath},${endPath}])`;

    const context = this._extractContext(range);
    return {
      cfi,
      selectedText,
      prefixText: context.prefix,
      suffixText: context.suffix
    };
  },

  _nodeToPath(node, offset) {
    const steps = [];
    let cur = node;
    let charOffset = null;

    if (cur.nodeType === Node.TEXT_NODE) {
      charOffset = offset;
      const parent = cur.parentNode;
      if (parent) {
        let textIdx = 1;
        for (const sib of parent.childNodes) {
          if (sib === cur) break;
          textIdx += 1;
        }
        steps.unshift(`${textIdx}:${charOffset}`);
        cur = parent;
      }
    }

    while (cur && cur.nodeName.toLowerCase() !== 'body' && cur.parentElement) {
      const parent = cur.parentElement;
      const children = Array.from(parent.children);
      const elemIdx = (children.indexOf(cur) + 1) * 2;
      steps.unshift(String(elemIdx));
      cur = parent;
    }
    return '/4/' + steps.join('/');
  },

  _extractContext(range) {
    try {
      const block = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      const fullText = block ? block.textContent : '';
      const sel = range.toString();
      const idx = fullText.indexOf(sel);
      if (idx >= 0) {
        return {
          prefix: fullText.slice(Math.max(0, idx - 16), idx),
          suffix: fullText.slice(idx + sel.length, idx + sel.length + 16)
        };
      }
    } catch (_) {}
    return { prefix: '', suffix: '' };
  },

  // 从 CFI 中解析出章节序号 sectionIndex 与页内比例
  parseSectionIndex(cfi) {
    if (!cfi || typeof cfi !== 'string') return 0;
    const m = cfi.match(/\/6\/(\d+)/);
    if (m) {
      const spineStep = parseInt(m[1], 10);
      return Math.max(0, Math.floor(spineStep / 2) - 1);
    }
    return 0;
  }
};
