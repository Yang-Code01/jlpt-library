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

/* ---------------------------------------------------------------------------
   写文件时保留目标文件自身行尾（ADR-0004）：
   新文件用 LF，已存在的 CRLF 文件继续 CRLF，绝不写混合行尾。
   dry=true 只比较不落盘 —— check 必须走这条路，否则「只校验」的承诺就破了。
   返回 true 表示「内容有变化」（dry 模式下即「会写」）。
   --------------------------------------------------------------------------- */
import fs from 'node:fs';
import path from 'node:path';

export function writePreservingEol(file, content, { dry = false } = {}) {
  const exists = fs.existsSync(file);
  const cur = exists ? fs.readFileSync(file, 'utf8') : null;
  const next = toEol(content, exists ? pickEol(cur) : '\n');
  if (exists && cur === next) return false;
  if (dry) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}
