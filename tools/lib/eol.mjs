/*
 * 行尾（EOL）工具：仓库一律 LF（.gitattributes 钉死，见 docs/adr/0004），
 * 但工作区可能被 core.autocrlf 检成 CRLF。生成器与比较逻辑都必须先归一化，
 * 否则会造出「内容不一致」的假失败 —— 这个坑历史上反复踩，所以只此一份实现。
 *
 *   norm(s)         → 全部 CRLF 折成 LF（比较用）
 *   pickEol(s)      → 保留文件自身行尾（写回用：'index.html' 是 CRLF，别写混合行尾）
 *   toEol(s, eol)   → 把 LF 文本转成指定行尾
 */

export const norm = (s) => String(s).replace(/\r\n/g, '\n');

export const pickEol = (s) => (String(s).includes('\r\n') ? '\r\n' : '\n');

export const toEol = (s, eol = '\n') => (eol === '\n' ? norm(s) : norm(s).replace(/\n/g, eol));
