/*
 * core.js — 纯逻辑层：文本解码、进度换算、演示数据生成等。
 * 不依赖 DOM，浏览器通过 <script> 引入（挂到 window.Core），
 * Node 单元测试通过 require('../core.js') 引入。
 */
(function (global) {
  'use strict';

  // ---------- 文本处理 ----------

  /** 将整本 TXT 拆分为段落数组：按换行切分、去除首尾空白、丢弃空行。 */
  function splitParagraphs(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    return text
      .split(/\r\n|\r|\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  /**
   * 按字节特征解码 TXT：先严格按 UTF-8 尝试，失败回退 GBK（GB18030 向下兼容），
   * 仍失败时用非严格 UTF-8 兜底，保证不抛异常。
   * @returns {{ text: string, encoding: string }}
   */
  function tryDecode(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
    } catch (e) { /* 不是合法 UTF-8，继续尝试 GBK */ }
    try {
      return { text: new TextDecoder('gbk').decode(bytes), encoding: 'gbk' };
    } catch (e) { /* 环境不支持 GBK 或字节非法，走兜底 */ }
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  }

  // ---------- 进度换算 ----------

  /** 页码 → 进度比例（0~1）。totalPages <= 1 时恒为 0。 */
  function percentFromPage(pageIndex, totalPages) {
    if (!totalPages || totalPages <= 1) return 0;
    var i = Math.min(Math.max(pageIndex, 0), totalPages - 1);
    return i / (totalPages - 1);
  }

  /** 进度比例（0~1，越界自动收敛）→ 页码。totalPages <= 1 时恒为 0。 */
  function pageFromPercent(percent, totalPages) {
    if (!totalPages || totalPages <= 1) return 0;
    var p = Math.min(Math.max(percent, 0), 1);
    return Math.round(p * (totalPages - 1));
  }

  // ---------- 时间显示 ----------

  /** 把最后阅读时间格式化为「刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期」。 */
  function formatLastRead(ts, now) {
    now = typeof now === 'number' ? now : Date.now();
    if (!ts) return '未读过';
    var diff = now - ts;
    var MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
    if (diff < MIN) return '刚刚';
    if (diff < HOUR) return Math.floor(diff / MIN) + ' 分钟前';
    if (diff < DAY) return Math.floor(diff / HOUR) + ' 小时前';
    if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' 天前';
    var d = new Date(ts);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  // ---------- 封面配色 ----------

  var COVER_PALETTE = [
    ['#667eea', '#764ba2'],
    ['#f5576c', '#f093fb'],
    ['#4facfe', '#00b4d8'],
    ['#fa709a', '#fee140'],
    ['#30cfd0', '#330867'],
    ['#f7971e', '#ffd200'],
    ['#8e2de2', '#4a00e0'],
    ['#11998e', '#38ef7d']
  ];

  /** 按书籍 id 稳定地选一组封面渐变色。 */
  function coverFor(id) {
    var h = 0, s = String(id);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return COVER_PALETTE[h % COVER_PALETTE.length];
  }

  // ---------- 演示数据生成（确定性随机，刷新后内容保持一致） ----------

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var SUBJECTS = ['他', '她', '少年', '老人', '风', '灯火', '细雨', '马蹄声', '记忆', '旅人'];
  var NOUNS = ['长街', '山谷', '渡口', '旧信', '石阶', '篝火', '星图', '城门', '行囊', '灯笼', '河道', '废墟'];
  var VERBS = ['掠过', '落在', '望向', '想起', '走过', '抵达', '掩住', '点亮', '惊动', '追赶'];
  var ADJS = ['冰凉的', '温热的', '遥远的', '明亮的', '沉默的', '破损的', '熟悉的', '褪色的', '轻盈的'];
  var ENDS = ['。', '。', '。', '，像一句迟到的回答。', '，无人应答。', '，又缓缓熄灭了。', '——他停住了脚步。'];

  function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

  function makeSentence(rand) {
    var t = Math.floor(rand() * 4);
    if (t === 0) return pick(rand, SUBJECTS) + pick(rand, VERBS) + '了' + pick(rand, ADJS) + pick(rand, NOUNS) + pick(rand, ENDS);
    if (t === 1) return pick(rand, SUBJECTS) + '沿着' + pick(rand, NOUNS) + pick(rand, VERBS) + '，' + pick(rand, ADJS) + '气息' + pick(rand, ENDS);
    if (t === 2) return pick(rand, ADJS) + '夜色里，' + pick(rand, NOUNS) + '忽然被' + pick(rand, VERBS) + pick(rand, ENDS);
    return '「' + pick(rand, SUBJECTS) + pick(rand, VERBS) + '了' + pick(rand, NOUNS) + '。」' + pick(rand, ENDS);
  }

  function makeParagraph(rand) {
    var n = 2 + Math.floor(rand() * 4);
    var out = '';
    for (var i = 0; i < n; i++) out += makeSentence(rand);
    return out;
  }

  /**
   * 生成一本演示用假书。
   * @param {{ seed: number, paragraphs: number }} opts
   * @returns {string} 以换行分段、可直接交给 splitParagraphs 的全文
   */
  function makeMockBookText(opts) {
    var rand = mulberry32(opts.seed >>> 0);
    var count = Math.max(1, opts.paragraphs | 0);
    var paras = new Array(count);
    for (var i = 0; i < count; i++) paras[i] = makeParagraph(rand);
    return paras.join('\n');
  }

  var api = {
    splitParagraphs: splitParagraphs,
    tryDecode: tryDecode,
    percentFromPage: percentFromPage,
    pageFromPercent: pageFromPercent,
    formatLastRead: formatLastRead,
    coverFor: coverFor,
    COVER_PALETTE: COVER_PALETTE,
    makeMockBookText: makeMockBookText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.Core = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
