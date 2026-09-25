/*
 * app.js — Demo 应用层：书库、阅读器界面与交互。
 * 无后端：书库与进度保存在 localStorage；演示书籍内容由 core.js 确定性生成。
 */
(function () {
  'use strict';

  var Core = window.Core;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 常量 ----------

  var LS_LIB = 'xifeng.demo.library.v1';      // 书籍元信息（不含正文）
  var LS_TEXT_PREFIX = 'xifeng.demo.text.';   // 导入书籍的正文，按 id 单独存
  var LS_SEEDED = 'xifeng.demo.seeded.v1';    // 是否已注入演示书籍（删除后不重复生成）

  var COLUMN_GAP = 48;          // 多列布局列间距，翻页步长 = 列宽 + 间距
  var FONT_MIN = 14, FONT_MAX = 30, FONT_STEP = 2, FONT_DEFAULT = 18;
  var LINE_STEPS = [1.5, 1.75, 2.0, 2.25];

  // 内置演示书：seed 固定，保证每次刷新内容一致，进度才可复现
  var MOCK_BOOKS = [
    { id: 'mock-xingyun',   title: '星陨大陆',     tag: '玄幻', seed: 11, paragraphs: 900 },
    { id: 'mock-beicheng',  title: '北城旧事',     tag: '都市', seed: 23, paragraphs: 640 },
    { id: 'mock-yinhe',     title: '银河边缘手记', tag: '科幻', seed: 37, paragraphs: 1100 }
  ];

  // ---------- 状态 ----------

  var library = [];        // [{ id, type:'mock'|'file', title, tag, percent, fontSize, lineSpacing, lastReadAt, addedAt }]
  var texts = new Map();   // id -> 正文全文（导入的书在内存中保底一份）
  var current = null;      // { entry, pageIndex, totalPages, viewW }

  var saveTimer = null;    // 进度保存防抖

  // ---------- localStorage ----------

  function loadLibrary() {
    try {
      var raw = localStorage.getItem(LS_LIB);
      if (raw) { library = JSON.parse(raw); return; }
    } catch (e) { library = []; }

    if (!localStorage.getItem(LS_SEEDED)) {
      var now = Date.now();
      library = [
        { id: 'mock-xingyun',  type: 'mock', title: '星陨大陆',     tag: '玄幻', percent: 0.34, fontSize: FONT_DEFAULT, lineSpacing: 1.75, lastReadAt: now - 2 * 3600e3, addedAt: now - 5 * 86400e3 },
        { id: 'mock-beicheng', type: 'mock', title: '北城旧事',     tag: '都市', percent: 0,    fontSize: FONT_DEFAULT, lineSpacing: 1.75, lastReadAt: 0,                addedAt: now - 2 * 86400e3 },
        { id: 'mock-yinhe',    type: 'mock', title: '银河边缘手记', tag: '科幻', percent: 0.08, fontSize: FONT_DEFAULT, lineSpacing: 1.75, lastReadAt: now - 3 * 86400e3, addedAt: now - 86400e3 }
      ];
      try { localStorage.setItem(LS_SEEDED, '1'); } catch (e) { /* 忽略 */ }
      saveLibrary();
    }
  }

  function saveLibrary() {
    try { localStorage.setItem(LS_LIB, JSON.stringify(library)); }
    catch (e) { console.warn('书库保存失败', e); }
  }

  function persistText(id, text) {
    try { localStorage.setItem(LS_TEXT_PREFIX + id, text); return true; }
    catch (e) { return false; } // 超出演示存储配额（约 5MB），本次会话内仍可读
  }

  function getText(entry) {
    if (texts.has(entry.id)) return texts.get(entry.id);
    if (entry.type === 'mock') {
      var mock = MOCK_BOOKS.filter(function (b) { return b.id === entry.id; })[0];
      var text = Core.makeMockBookText({ seed: mock.seed, paragraphs: mock.paragraphs });
      texts.set(entry.id, text);
      return text;
    }
    try {
      var stored = localStorage.getItem(LS_TEXT_PREFIX + entry.id);
      if (stored != null) { texts.set(entry.id, stored); return stored; }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  // ---------- 小工具 ----------

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2200);
  }

  // ---------- 书库渲染 ----------

  function renderLibrary() {
    var grid = $('bookGrid');
    grid.innerHTML = '';
    $('emptyState').classList.toggle('hidden', library.length > 0);

    library.forEach(function (entry) {
      var colors = Core.coverFor(entry.id);
      var percent = Math.round((entry.percent || 0) * 100);

      var card = document.createElement('div');
      card.className = 'book-card';
      card.innerHTML =
        '<div class="book-cover" style="background:linear-gradient(135deg,' + colors[0] + ',' + colors[1] + ')">' +
          (entry.tag ? '<span class="cover-tag">' + entry.tag + '</span>' : '') +
          '<span class="cover-title">' + escapeHtml(entry.title) + '</span>' +
        '</div>' +
        '<div class="book-meta">' +
          '<div class="book-title" title="' + escapeHtml(entry.title) + '">' + escapeHtml(entry.title) + '</div>' +
          '<div class="book-sub">' +
            (percent > 0 ? '已读 ' + percent + '% · ' : '未读 · ') +
            Core.formatLastRead(entry.lastReadAt) +
          '</div>' +
        '</div>' +
        '<div class="book-progress"><div class="fill" style="width:' + percent + '%"></div></div>' +
        '<button class="book-delete" title="删除这本书">✕</button>';

      card.addEventListener('click', function () { openBook(entry.id); });
      card.querySelector('.book-delete').addEventListener('click', function (e) {
        e.stopPropagation();
        deleteBook(entry.id);
      });
      grid.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function deleteBook(id) {
    var entry = library.filter(function (b) { return b.id === id; })[0];
    if (!entry) return;
    if (!window.confirm('确定要删除《' + entry.title + '》吗？')) return;
    library = library.filter(function (b) { return b.id !== id; });
    texts.delete(id);
    try { localStorage.removeItem(LS_TEXT_PREFIX + id); } catch (e) { /* 忽略 */ }
    saveLibrary();
    renderLibrary();
    toast('已删除《' + entry.title + '》');
  }

  // ---------- 导入 ----------

  function importFile(file) {
    if (!/\.txt$/i.test(file.name)) { toast('Demo 阶段仅支持 TXT 文件'); return; }
    file.arrayBuffer().then(function (buf) {
      var r = Core.tryDecode(buf);
      var id = 'file-' + Date.now();
      var kept = persistText(id, r.text);
      texts.set(id, r.text);
      library.unshift({
        id: id, type: 'file', title: file.name.replace(/\.txt$/i, ''),
        tag: '', percent: 0, fontSize: FONT_DEFAULT, lineSpacing: 1.75,
        lastReadAt: 0, addedAt: Date.now()
      });
      saveLibrary();
      renderLibrary();
      toast('已导入《' + file.name.replace(/\.txt$/i, '') + '》· ' + r.encoding.toUpperCase() + ' 编码' +
        (kept ? ' 自动识别' : '（文件较大，仅本次会话保留）'));
    });
  }

  // ---------- 阅读器 ----------

  function openBook(id) {
    var entry = library.filter(function (b) { return b.id === id; })[0];
    if (!entry) return;
    var text = getText(entry);
    if (text == null) { toast('正文未能保留，请重新导入该书'); return; }

    current = { entry: entry, pageIndex: 0, totalPages: 1, viewW: 0 };

    $('libraryView').classList.add('hidden');
    $('readerView').classList.remove('hidden');
    $('readerView').classList.remove('chrome-hidden');
    $('readerTitle').textContent = entry.title;

    applyFont(entry.fontSize, entry.lineSpacing);

    var content = $('pageContent');
    var frag = document.createDocumentFragment();
    Core.splitParagraphs(text).forEach(function (p) {
      var el = document.createElement('p');
      el.textContent = p;
      frag.appendChild(el);
    });
    content.innerHTML = '';
    content.appendChild(frag);

    // 回到顶部，同步完成多列布局并按保存的进度定位。
    // 不用 rAF：后台标签页中 rAF 会被暂停，导致打开书后正文空白。
    content.style.transform = 'translateX(0)';
    entry.lastReadAt = Date.now();
    saveLibrary();

    relayout(entry.percent || 0);
  }

  function relayout(keepPercent) {
    if (!current) return;
    var vp = $('pageViewport');
    var content = $('pageContent');
    var viewW = vp.clientWidth;
    if (viewW <= 0) return;
    current.viewW = viewW;
    content.style.columnWidth = viewW + 'px';
    content.style.columnGap = COLUMN_GAP + 'px';

    var total = Math.max(1, Math.round((content.scrollWidth + COLUMN_GAP) / (viewW + COLUMN_GAP)));
    current.totalPages = total;
    current.pageIndex = Core.pageFromPercent(
      keepPercent != null ? keepPercent : Core.percentFromPage(current.pageIndex, total), total);
    applyTransform();
    updateBar();
  }

  function applyTransform() {
    $('pageContent').style.transform = 'translateX(' + (-current.pageIndex * (current.viewW + COLUMN_GAP)) + 'px)';
  }

  function updateBar() {
    var percent = Core.percentFromPage(current.pageIndex, current.totalPages);
    $('pageInfo').textContent =
      '第 ' + (current.pageIndex + 1) + ' / ' + current.totalPages + ' 页 · ' + Math.round(percent * 100) + '%';
    $('progressSlider').value = Math.round(percent * 1000);
  }

  /** 翻页的统一入口：dir 为 -1 / 1，或 0~1 的目标进度。 */
  function goPage(dirOrPercent) {
    if (!current) return;
    var target = typeof dirOrPercent === 'number' && dirOrPercent >= 0 && dirOrPercent <= 1
      ? Core.pageFromPercent(dirOrPercent, current.totalPages)
      : current.pageIndex + dirOrPercent;
    current.pageIndex = Math.min(Math.max(target, 0), current.totalPages - 1);
    applyTransform();
    updateBar();
    scheduleSaveProgress();
  }

  function scheduleSaveProgress() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgressNow, 400);
  }

  function saveProgressNow() {
    if (!current) return;
    current.entry.percent = Core.percentFromPage(current.pageIndex, current.totalPages);
    current.entry.lastReadAt = Date.now();
    saveLibrary();
  }

  function backToLibrary() {
    saveProgressNow();
    clearTimeout(saveTimer);
    current = null;
    $('readerView').classList.add('hidden');
    $('libraryView').classList.remove('hidden');
    renderLibrary();
  }

  // ---------- 阅读设置 ----------

  function applyFont(fontSize, lineSpacing) {
    var content = $('pageContent');
    content.style.fontSize = fontSize + 'px';
    content.style.setProperty('--lh', lineSpacing);
    $('btnLineSpacing').textContent = '行距 ' + lineSpacing;
  }

  function changeFont(delta) {
    if (!current) return;
    var e = current.entry;
    e.fontSize = Math.min(Math.max(e.fontSize + delta * FONT_STEP, FONT_MIN), FONT_MAX);
    applyFont(e.fontSize, e.lineSpacing);
    relayout(Core.percentFromPage(current.pageIndex, current.totalPages));
    toast('字号 ' + e.fontSize);
    saveLibrary();
  }

  function cycleLineSpacing() {
    if (!current) return;
    var e = current.entry;
    var i = LINE_STEPS.indexOf(e.lineSpacing);
    e.lineSpacing = LINE_STEPS[(i + 1) % LINE_STEPS.length];
    applyFont(e.fontSize, e.lineSpacing);
    relayout(Core.percentFromPage(current.pageIndex, current.totalPages));
    toast('行距 ' + e.lineSpacing);
    saveLibrary();
  }

  // ---------- 事件绑定 ----------

  function bindEvents() {
    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      if (e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });

    $('btnBack').addEventListener('click', backToLibrary);
    $('btnFontMinus').addEventListener('click', function () { changeFont(-1); });
    $('btnFontPlus').addEventListener('click', function () { changeFont(1); });
    $('btnLineSpacing').addEventListener('click', cycleLineSpacing);

    $('tapPrev').addEventListener('click', function () { goPage(-1); });
    $('tapNext').addEventListener('click', function () { goPage(1); });
    $('tapCenter').addEventListener('click', function () {
      $('readerView').classList.toggle('chrome-hidden');
    });

    // 键盘：←/→、PageUp/PageDown 翻页，Esc 返回书库
    document.addEventListener('keydown', function (e) {
      if (!current) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { goPage(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goPage(-1); }
      else if (e.key === 'Escape') { backToLibrary(); }
    });

    // 触屏左右滑动翻页
    var touchX = null;
    $('pageViewport').addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    $('pageViewport').addEventListener('touchend', function (e) {
      if (touchX == null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 40) goPage(dx < 0 ? 1 : -1);
    }, { passive: true });

    // 进度条拖动跳转：拖动期间关闭过渡动画，松手才保存
    var slider = $('progressSlider');
    slider.addEventListener('pointerdown', function () { $('pageContent').classList.add('dragging'); });
    slider.addEventListener('input', function () { goPage(slider.value / 1000); });
    slider.addEventListener('change', function () {
      $('pageContent').classList.remove('dragging');
      saveProgressNow();
    });

    // 书库拖拽导入
    var libView = $('libraryView'), dropHint = $('dropHint');
    ['dragover', 'dragenter'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        if (current || !e.dataTransfer) return;
        e.preventDefault();
        dropHint.classList.remove('hidden');
      });
    });
    document.addEventListener('dragleave', function (e) {
      if (e.relatedTarget === null) dropHint.classList.add('hidden');
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      dropHint.classList.add('hidden');
      if (!current && e.dataTransfer && e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
    });
    void libView;

    // 工具栏显隐、字号行距变化都会改变正文区高度，结束后需重新分页
    $('pageViewport').addEventListener('transitionend', function (e) {
      if (e.target === $('pageViewport') && current) {
        relayout(Core.percentFromPage(current.pageIndex, current.totalPages));
      }
    });
    window.addEventListener('resize', function () {
      if (current) relayout(Core.percentFromPage(current.pageIndex, current.totalPages));
    });
  }

  // ---------- 启动 ----------

  loadLibrary();
  renderLibrary();
  bindEvents();
})();
