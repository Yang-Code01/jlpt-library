#!/usr/bin/env node
/* ============================================================
   真题模块数据加密工具（构建期，仅本地运行）
   ============================================================
   把 exam/data/N2/<卷>.js 明文加密成 exam/data/N2/enc/<卷>.js 密文。
   站点上只放密文，密码只用来解密钥。

   注意：题型索引 exam/data/N2/index-lite.js **不加密**，明文常驻。
   它只含「有哪些卷、哪些题型、各多少题」这层目录信息，没有任何题目正文，
   而题型专练的选题屏必须在输口令之前就能渲染出来，所以它不能加密。

   密钥结构（三层信封）：
     口令 --PBKDF2-SHA256(600k)--> KEK --AES-256-GCM 包裹--> DEK
     DEK --HKDF(info=卷名)--> 分卷密钥 --AES-256-GCM--> 数据

   口令从不直接接触数据。改密码只需重包裹 DEK（毫秒级），
   不用重新加密整库。

   密文布局：iv(12B) || ciphertext || tag(16B)，整体 base64。
   AAD = 卷名（如 "2011-07"），防止密文互换。
   压缩：DEFLATE raw（浏览器用 DecompressionStream("deflate-raw") 还原）。

   用法：
     node tools/encrypt-exam.mjs gen-key            生成盐 + DEK（写入本地密钥文件）
     node tools/encrypt-exam.mjs encrypt            加密全部卷（索引保持明文）
     node tools/encrypt-exam.mjs set-pass "<密码>"   把 DEK 用新口令包裹，写 meta.js
     node tools/encrypt-exam.mjs verify "<密码>"     用口令全量解密并与明文逐字节比对
     node tools/encrypt-exam.mjs status             查看当前状态
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "exam", "data", "N2");
const ENC = path.join(DATA, "enc");
const META = path.join(ENC, "meta.js");
const DEK_FILE = path.join(ROOT, ".scratch", "jlpt-exam", "enc-keys", "dek.b64");

const VERSION = 1;
const KDF = { hash: "sha256", iter: 600000, len: 32 };
const HKDF_SALT = Buffer.from("jlpt-exam-hkdf-v1", "utf8");
const INFO_PREFIX = "jlpt-exam-v1:";
const WRAP_AAD = Buffer.from("jlpt-exam-dek-v1", "utf8");
const IV_LEN = 12;
const TAG_LEN = 16;

/* ---------- 卷清单 ---------- */
function volumes() {
  return fs.readdirSync(DATA)
    .filter(f => /^\d{4}-\d{2}\.js$/.test(f))
    .map(f => f.replace(/\.js$/, ""))
    .sort();
}
function globalOf(name) {
  return "EXAM_ENC_" + name.replace(/-/g, "_").toUpperCase();
}
// 明文 .js 内容是 `window.XXX = {...};` —— 只取等号之后的 JSON 文本，保留原始字节，
// 这样 verify 可以做逐字节比对，不受重新序列化影响。
function readPlain(file) {
  const src = fs.readFileSync(path.join(DATA, file), "utf8");
  const i = src.indexOf("=");
  if (i < 0) throw new Error("明文格式异常（找不到 =）: " + file);
  let json = src.slice(i + 1).trim();
  if (json.endsWith(";")) json = json.slice(0, -1);
  JSON.parse(json); // 先确认是合法 JSON，避免把坏数据加密进去
  return Buffer.from(json, "utf8");
}

/* ---------- 密钥派生 ---------- */
function deriveKek(passphrase, salt) {
  return crypto.pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, KDF.iter, KDF.len, KDF.hash);
}
function wrapDek(kek, dek) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(WRAP_AAD);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return { iv: iv.toString("base64"), ct: Buffer.concat([ct, c.getAuthTag()]).toString("base64") };
}
function unwrapDek(kek, wrap) {
  const iv = Buffer.from(wrap.iv, "base64");
  const buf = Buffer.from(wrap.ct, "base64");
  const ct = buf.subarray(0, buf.length - TAG_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const d = crypto.createDecipheriv("aes-256-gcm", kek, iv);
  d.setAAD(WRAP_AAD);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function volumeKey(dek, name) {
  return Buffer.from(crypto.hkdfSync("sha256", dek, HKDF_SALT, INFO_PREFIX + name, 32));
}

/* ---------- 加解密 ---------- */
function encryptPayload(dek, name, plain) {
  const deflated = zlib.deflateRawSync(plain, { level: 9 });
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv("aes-256-gcm", volumeKey(dek, name), iv);
  c.setAAD(Buffer.from(name, "utf8"));
  const ct = Buffer.concat([c.update(deflated), c.final()]);
  return { b64: Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64"), compressed: deflated.length };
}
function decryptPayload(dek, name, b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const d = crypto.createDecipheriv("aes-256-gcm", volumeKey(dek, name), iv);
  d.setAAD(Buffer.from(name, "utf8"));
  d.setAuthTag(tag);
  return zlib.inflateRawSync(Buffer.concat([d.update(ct), d.final()]));
}

/* ---------- 本地密钥文件（不进仓库） ---------- */
function saveDek(dek) {
  fs.mkdirSync(path.dirname(DEK_FILE), { recursive: true });
  fs.writeFileSync(DEK_FILE, dek.toString("base64") + "\n");
}
function loadDek() {
  if (!fs.existsSync(DEK_FILE)) {
    throw new Error("找不到本地密钥文件，请先运行 gen-key：\n  " + DEK_FILE);
  }
  return Buffer.from(fs.readFileSync(DEK_FILE, "utf8").trim(), "base64");
}
function readMeta() {
  if (!fs.existsSync(META)) return null;
  const src = fs.readFileSync(META, "utf8");
  const i = src.indexOf("=");
  let json = src.slice(i + 1).trim();
  if (json.endsWith(";")) json = json.slice(0, -1);
  return JSON.parse(json);
}
function writeMeta(meta) {
  fs.mkdirSync(ENC, { recursive: true });
  fs.writeFileSync(META, "window.EXAM_ENC_META = " + JSON.stringify(meta) + ";\n");
}

/* ---------- 子命令 ---------- */
function cmdGenKey() {
  const salt = crypto.randomBytes(16);
  const dek = crypto.randomBytes(32);
  saveDek(dek);
  const meta = readMeta() || {};
  meta.v = VERSION;
  meta.kdf = "PBKDF2-SHA256";
  meta.hash = KDF.hash;
  meta.iter = KDF.iter;
  meta.salt = salt.toString("base64");
  meta.wrap = meta.wrap || null;       // 留待 set-pass 填充
  writeMeta(meta);
  console.log("已生成新的盐与 DEK。");
  console.log("  盐已写入      " + path.relative(ROOT, META));
  console.log("  DEK 本地保存  " + path.relative(ROOT, DEK_FILE));
  console.log("\nDEK 是整库的总钥匙，务必留好本地副本；它已被 .scratch/ 忽略，不会进仓库。");
  console.log("下一步：encrypt 加密数据，然后 set-pass 设置口令。");
}

function cmdEncrypt() {
  const dek = loadDek();
  fs.mkdirSync(ENC, { recursive: true });
  const names = volumes();
  let plainTotal = 0, outTotal = 0;
  const rows = [];
  for (const name of names) {
    const plain = readPlain(name + ".js");
    const { b64, compressed } = encryptPayload(dek, name, plain);
    const out = "window." + globalOf(name) + " = " + JSON.stringify(b64) + ";\n";
    fs.writeFileSync(path.join(ENC, name + ".js"), out);
    plainTotal += plain.length;
    outTotal += Buffer.byteLength(out);
    rows.push({ name, plain: plain.length, compressed, out: Buffer.byteLength(out) });
  }
  console.log("已加密 " + names.length + " 个文件 → " + path.relative(ROOT, ENC));
  console.log("");
  console.log("  卷名          明文      压缩后     密文文件");
  for (const r of rows) {
    console.log("  " + r.name.padEnd(12) + String(r.plain).padStart(8) +
      String(r.compressed).padStart(10) + String(r.out).padStart(12));
  }
  console.log("");
  console.log("  明文合计 " + (plainTotal / 1048576).toFixed(2) + " MB" +
    "　密文合计 " + (outTotal / 1048576).toFixed(2) + " MB" +
    "　（" + (outTotal / plainTotal).toFixed(2) + " 倍）");
}

function cmdSetPass(passphrase) {
  if (!passphrase) throw new Error("请提供口令：node tools/encrypt-exam.mjs set-pass \"你的口令\"");
  const dek = loadDek();
  const meta = readMeta() || {};
  if (!meta.salt) throw new Error("meta.js 里没有盐，请先运行 gen-key");
  const kek = deriveKek(passphrase, Buffer.from(meta.salt, "base64"));
  meta.v = VERSION;
  meta.kdf = "PBKDF2-SHA256";
  meta.hash = KDF.hash;
  meta.iter = KDF.iter;
  meta.wrap = wrapDek(kek, dek);
  writeMeta(meta);
  console.log("已用新口令包裹 DEK（数据未重新加密，秒级完成）。");
  console.log("  口令长度 " + [...passphrase].length + " 个字符");
  console.log("  写入     " + path.relative(ROOT, META));
}

function cmdVerify(passphrase) {
  if (!passphrase) throw new Error("请提供口令：node tools/encrypt-exam.mjs verify \"你的口令\"");
  const meta = readMeta();
  if (!meta || !meta.wrap) throw new Error("meta.js 还没有口令包裹信息，请先运行 set-pass");
  const kek = deriveKek(passphrase, Buffer.from(meta.salt, "base64"));
  let dek;
  try {
    dek = unwrapDek(kek, meta.wrap);
  } catch (e) {
    console.log("口令错误（DEK 解包失败，认证标签不匹配）。");
    process.exitCode = 1;
    return;
  }
  const names = volumes();
  let ok = 0;
  const bad = [];
  for (const name of names) {
    const plain = readPlain(name + ".js");
    const src = fs.readFileSync(path.join(ENC, name + ".js"), "utf8");
    const i = src.indexOf("=");
    let b64 = src.slice(i + 1).trim();
    if (b64.endsWith(";")) b64 = b64.slice(0, -1);
    b64 = JSON.parse(b64);
    let got;
    try {
      got = decryptPayload(dek, name, b64);
    } catch (e) {
      bad.push(name + "（解密失败）");
      continue;
    }
    if (got.equals(plain)) ok++;
    else bad.push(name + "（内容不一致）");
  }
  console.log("口令正确，DEK 解包成功。");
  console.log("  逐字节一致 " + ok + " / " + names.length);
  if (bad.length) {
    console.log("  不一致：" + bad.join("、"));
    process.exitCode = 1;
  } else {
    console.log("\n全部通过：密文可以用这个口令完整还原成明文。");
  }
}

function cmdStatus() {
  const meta = readMeta();
  const vs = volumes();
  console.log("明文卷   " + vs.length + " 卷");
  console.log("密文目录 " + (fs.existsSync(ENC) ? fs.readdirSync(ENC).length + " 个文件" : "（不存在）"));
  console.log("本地 DEK " + (fs.existsSync(DEK_FILE) ? "有" : "无"));
  console.log("");
  if (!meta) { console.log("meta.js：尚未生成"); return; }
  console.log("KDF      " + meta.kdf + " / " + (meta.iter || "?").toLocaleString("en-US") + " 次");
  console.log("口令包裹 " + (meta.wrap ? "已设置" : "未设置"));
}

/* ---------- 入口 ---------- */
const [cmd, arg] = process.argv.slice(2);
try {
  switch (cmd) {
    case "gen-key": cmdGenKey(); break;
    case "encrypt": cmdEncrypt(); break;
    case "set-pass": cmdSetPass(arg); break;
    case "verify": cmdVerify(arg); break;
    case "status": cmdStatus(); break;
    default:
      console.log("用法：");
      console.log("  node tools/encrypt-exam.mjs gen-key            生成盐 + DEK");
      console.log("  node tools/encrypt-exam.mjs encrypt            加密全部卷（索引明文不动）");
      console.log("  node tools/encrypt-exam.mjs set-pass \"<口令>\"   用口令包裹 DEK");
      console.log("  node tools/encrypt-exam.mjs verify \"<口令>\"    全量往返校验");
      console.log("  node tools/encrypt-exam.mjs status             查看状态");
  }
} catch (e) {
  console.error("错误：" + e.message);
  process.exitCode = 1;
}
