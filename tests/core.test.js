/*
 * core.js 单元测试。运行方式：node tests/core.test.js
 * 全部通过时退出码为 0，任何失败退出码为 1。
 */
'use strict';

const assert = require('assert');
const Core = require('../core.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.error('  \u2717 ' + name + '\n      ' + e.message);
  }
}

console.log('core.js \u5355\u5143\u6d4b\u8bd5');

// ---------- splitParagraphs ----------

test('splitParagraphs: 按 \\r\\n 切分并丢弃空行', () => {
  assert.deepStrictEqual(Core.splitParagraphs('第一段\r\n\r\n第二段\n第三段 '), ['第一段', '第二段', '第三段']);
});

test('splitParagraphs: 空输入返回空数组', () => {
  assert.deepStrictEqual(Core.splitParagraphs(''), []);
  assert.deepStrictEqual(Core.splitParagraphs(null), []);
  assert.deepStrictEqual(Core.splitParagraphs('\n\n  \n'), []);
});

// ---------- tryDecode ----------

test('tryDecode: 正确解码 UTF-8', () => {
  const buf = Buffer.from('你好，世界。abc', 'utf8');
  const r = Core.tryDecode(new Uint8Array(buf));
  assert.strictEqual(r.text, '你好，世界。abc');
  assert.strictEqual(r.encoding, 'utf-8');
});

test('tryDecode: GBK 字节自动识别为 GBK（中文关键场景）', () => {
  // 「你好，世界。」的 GBK 编码字节
  const bytes = Uint8Array.from([0xC4, 0xE3, 0xBA, 0xC3, 0xA3, 0xAC, 0xCA, 0xC0, 0xBD, 0xE7, 0xA1, 0xA3]);
  const r = Core.tryDecode(bytes);
  assert.strictEqual(r.text, '你好，世界。');
  assert.strictEqual(r.encoding, 'gbk');
});

test('tryDecode: UTF-8 BOM 被剥除', () => {
  const body = Buffer.from('BOM 测试', 'utf8');
  const bytes = new Uint8Array(3 + body.length);
  bytes.set([0xef, 0xbb, 0xbf], 0);
  bytes.set(body, 3);
  const r = Core.tryDecode(bytes);
  assert.strictEqual(r.text, 'BOM 测试');
  assert.strictEqual(r.encoding, 'utf-8');
});

test('tryDecode: 非法字节不抛异常', () => {
  const r = Core.tryDecode(Uint8Array.from([0xff, 0xfe, 0x00, 0x01]));
  assert.strictEqual(typeof r.text, 'string');
});

// ---------- 进度换算 ----------

test('percentFromPage / pageFromPercent 往返一致', () => {
  for (let page = 0; page <= 10; page++) {
    assert.strictEqual(Core.pageFromPercent(Core.percentFromPage(page, 11), 11), page);
  }
});

test('进度换算: 越界值收敛到两端', () => {
  assert.strictEqual(Core.pageFromPercent(-1, 11), 0);
  assert.strictEqual(Core.pageFromPercent(1.5, 11), 10);
  assert.strictEqual(Core.percentFromPage(99, 10), 1);
  assert.strictEqual(Core.percentFromPage(-5, 10), 0);
});

test('进度换算: 单页书恒为 0', () => {
  assert.strictEqual(Core.percentFromPage(0, 1), 0);
  assert.strictEqual(Core.percentFromPage(3, 1), 0);
  assert.strictEqual(Core.pageFromPercent(0.8, 1), 0);
  assert.strictEqual(Core.percentFromPage(0.5, 0), 0);
});

// ---------- formatLastRead ----------

test('formatLastRead: 各时间档位', () => {
  const now = Date.now();
  assert.strictEqual(Core.formatLastRead(0), '未读过');
  assert.strictEqual(Core.formatLastRead(now - 30e3, now), '刚刚');
  assert.strictEqual(Core.formatLastRead(now - 5 * 60e3, now), '5 分钟前');
  assert.strictEqual(Core.formatLastRead(now - 3 * 3600e3, now), '3 小时前');
  assert.strictEqual(Core.formatLastRead(now - 4 * 86400e3, now), '4 天前');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(Core.formatLastRead(now - 40 * 86400e3, now)));
});

// ---------- coverFor ----------

test('coverFor: 同一 id 结果稳定且在调色板范围内', () => {
  const a = Core.coverFor('mock-1');
  const b = Core.coverFor('mock-1');
  assert.deepStrictEqual(a, b);
  assert.ok(Core.COVER_PALETTE.some((p) => p[0] === a[0] && p[1] === a[1]));
});

// ---------- makeMockBookText ----------

test('makeMockBookText: 同种子输出一致（刷新后内容不变）', () => {
  const a = Core.makeMockBookText({ seed: 11, paragraphs: 50 });
  const b = Core.makeMockBookText({ seed: 11, paragraphs: 50 });
  assert.strictEqual(a, b);
});

test('makeMockBookText: 不同种子输出不同', () => {
  const a = Core.makeMockBookText({ seed: 11, paragraphs: 50 });
  const b = Core.makeMockBookText({ seed: 12, paragraphs: 50 });
  assert.notStrictEqual(a, b);
});

test('makeMockBookText: 段落数量与请求一致，且能被 splitParagraphs 还原', () => {
  const text = Core.makeMockBookText({ seed: 99, paragraphs: 120 });
  const paras = Core.splitParagraphs(text);
  assert.strictEqual(paras.length, 120);
  paras.forEach((p) => assert.ok(p.length > 0));
});

// ---------- 汇总 ----------

console.log('\n\u7ed3\u679c: ' + passed + ' \u901a\u8fc7, ' + failed + ' \u5931\u8d25');
process.exit(failed > 0 ? 1 : 0);
