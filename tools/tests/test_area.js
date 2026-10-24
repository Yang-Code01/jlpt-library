/* 门户壳的契约测试（ADR-0010 之后）
   跑法：node tools/tests/test_area.js

   旧版测的是「区 / 语言」两级状态机（.wb-tabs + data-lang）。ADR-0010 把语言轴并进
   分组小标题、把区切换搬进左栏，所以这里改成断言新壳的静态契约 + 状态机关键字：
   任一被删掉，门户就会退回「入口要滚才点到」的老样子，而这些断言会先红。
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}
const count = (re) => (html.match(re) || []).length;

/* 1. 左栏：4 个区按钮 + 11 个模块入口，且「语言学习」是可折叠分组 */
eq(count(/data-area-btn="/g), 4, '左栏有 4 个区按钮');
ok(/<details class="rail-group" open>/.test(html), '语言学习是可折叠分组（默认展开）');
eq(count(/class="rail-item"/g), 11, '左栏 11 个模块入口');
ok(/class="rail-area is-on" data-area-btn="study"/.test(html), '语言学习是默认高亮项');
ok(!/data-lang=/.test(html), 'data-lang 轴已移除（ADR-0010）');
ok(!/class="lang-tabs"/.test(html), '语言切换按钮已移除');

/* 2. 四个区面板仍在，深链合同（#survey / #tools / #snooker）不受影响 */
for (const a of ['study', 'survey', 'tools', 'snooker']) {
  ok(html.includes(`data-area-pane="${a}"`), `区面板存在：${a}`);
}
ok(/html\[data-area="study"\] \.wb-pane:not\(\[data-area-pane="study"\]\)/.test(html),
  '区显隐仍靠 <html data-area> 的 :not() 规则');

/* 3. 顶栏：标题 + 7 个类型标签 + 搜索框（外观） */
ok(/<h1 class="topbar-title">/.test(html), '顶栏有区名标题');
eq(count(/class="tab[^"]*" data-tag="/g), 7, '类型筛选 7 个标签');
ok(/class="tab is-on" data-tag="全部"/.test(html), '默认「全部」');
ok(/data-rail-toggle/.test(html), '窄屏有抽屉开关');

/* 4. 卡片：12 张，右栏有进度胶囊或规模徽章，进度分母由 data-units 指认 */
eq(count(/<article class="card"/g), 12, '语言学习区 12 张卡');
eq(count(/data-units="/g), 4, '4 张卡挂了 data-units（ja / jp-reading / en-vocab / en-reading）');
ok(/data-units="ja"/.test(html) && /data-units="en-vocab"/.test(html) && /data-units="en-reading"/.test(html),
  'data-units 三个桶齐备');
eq(count(/class="prog-pill"/g), 4, '4 个进度胶囊');
ok(html.includes('assets/portal.js'), '接入 assets/portal.js');
ok(html.includes('assets/units.js'), '接入 assets/units.js（生成的分母清单）');

/* 5. 英语侧清单还在门户里（折叠），107 不变量不受影响 */
ok(/<details class="fold" id="fold-vocab">/.test(html), '词表单元清单折叠块存在');
ok(/<details class="fold" id="fold-reading">/.test(html), '阅读篇目清单折叠块存在');
eq(count(/data-en-key=/g), 107, 'data-en-key 仍是 107 项（en-accept 门禁）');

/* 6. 状态机关键字：区切换写 localStorage，标题跟着换 */
ok(/jlpt-area/.test(html), '区状态仍落 localStorage 的 jlpt-area');
ok(/TITLES\s*=\s*\{\s*study:\s*'语言学习'/.test(html), '区 → 标题映射存在');
ok(/textContent\s*=\s*TITLES\[a\]/.test(html), '切区会同步顶栏标题');

/* 7. 老结构确实已经退休（防止半改留残骸） */
ok(!/class="portal-nav"/.test(html), '旧的 .portal-nav 已移除');
ok(!/class="wb-tabs"/.test(html), '旧的 .wb-tabs 已移除');
ok(!/class="path-row"/.test(html), '旧的编号入口行 .path-row 已移除');

console.log(`\n${fails.length ? '✗ FAIL' : '✓ 全部通过'} (${pass} 项)`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
