// 配布用「日別アーカイブ」ページ生成スクリプト
// 使い方: node gen-archive.mjs <app.html> <masters.json> <days.json> <out.html> <dates(カンマ区切りYYYY-MM-DD)> <defaultDate> [password] [saltHex]
// password と saltHex を渡すと、ページ全体を AES-256-GCM で暗号化した「パスワード付きページ」を out.html に書き出す
// （平文はディスクに残らない）。省略時は従来どおり平文ページを書き出す。
// 要: playwright-core（ブラウザは /opt/pw-browsers/chromium）
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';
// playwright-core は実行ディレクトリの node_modules から解決（npm install playwright-core しておく）
const require = createRequire(process.cwd() + '/');
const { chromium } = require('playwright-core');

const [appHtml, mastersPath, daysPath, outPath, datesCsv, defaultDate, password, saltHex] = process.argv.slice(2);
if (!defaultDate) { console.error('args: app.html masters.json days.json out.html dates defaultDate [password] [saltHex]'); process.exit(1); }
if (password && !/^[0-9a-f]{32}$/.test(saltHex || '')) { console.error('saltHex must be 32 hex chars when password is given'); process.exit(1); }
const masters = JSON.parse(fs.readFileSync(mastersPath, 'utf8'));
const days = JSON.parse(fs.readFileSync(daysPath, 'utf8'));
const state = { ...(masters.state || {}), ...(days.state || {}) };
const dates = datesCsv.split(',').filter(Boolean);
const DOWS = ['日','月','火','水','木','金','土'];
const jd = ds => { const d = new Date(ds + 'T12:00:00'); return `${d.getMonth()+1}/${d.getDate()}（${DOWS[d.getDay()]}）`; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(st => { try { localStorage.setItem('toranomaki-v1', JSON.stringify(st)); } catch (e) {} }, state);
const p = await ctx.newPage();
p.on('pageerror', e => console.error('PAGEERROR:', e.message));
await p.goto('file://' + fs.realpathSync(appHtml));
await p.waitForTimeout(400);

const sections = [];
let style = '';
for (const ds of dates) {
  await p.fill('#dateInput', ds);
  await p.dispatchEvent('#dateInput', 'change');
  await p.waitForTimeout(350);
  const body = await p.evaluate(() => buildSnapshotParts());
  if (!style) style = await p.evaluate(() => [...document.querySelectorAll('style')].map(el => el.textContent).join('\n'));
  sections.push({ ds, body });
}
await b.close();

const nav = sections.map(s =>
  `<button class="daybtn" data-d="${s.ds}">${jd(s.ds)}</button>`).join('');
const secHtml = sections.map(s =>
  `<section class="dsec" id="d${s.ds}" hidden>${s.body}</section>`).join('\n');
const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>よみたん虎の巻 配布版</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap" media="print" onload="this.media='all'">
<style>${style}
.daynav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.daybtn{border:1px solid var(--line);background:var(--surface);border-radius:99px;padding:5px 14px;cursor:pointer;font-weight:700;font-family:"Zen Maru Gothic";font-variant-numeric:tabular-nums}
.daybtn.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.snapnote{color:var(--muted);font-size:11.5px;text-align:center;margin:20px 0}
.ev{cursor:default}</style></head>
<body><div class="wrap">
<header class="app"><div class="brand"><div class="mark">🚐</div>
<div><h1>よみたん送迎虎の巻</h1><small>読谷放課後キャンパス 運行計画（閲覧用）</small></div></div></header>
<nav class="daynav" id="dayNav">${nav}</nav>
${secHtml}
<p class="snapnote">閲覧専用／${now} 更新。最新の変更は運行管理担当からの連絡を確認してください。</p>
</div>
<script>
(function(){
  var def=${JSON.stringify('d' + defaultDate)};
  function show(id){
    var found=false;
    document.querySelectorAll('.dsec').forEach(function(s){var on=s.id===id;s.hidden=!on;if(on)found=true});
    document.querySelectorAll('.daybtn').forEach(function(b){b.classList.toggle('on','d'+b.dataset.d===id)});
    return found;
  }
  var want=(location.hash||'').replace('#','');
  if(!want||!show(want)) show(def);
  document.getElementById('dayNav').addEventListener('click',function(e){
    var b=e.target.closest('.daybtn'); if(!b)return;
    location.hash='d'+b.dataset.d; show('d'+b.dataset.d);
  });
  window.addEventListener('hashchange',function(){var w=(location.hash||'').replace('#','');if(w)show(w)});
})();
</script></body></html>`;
let out = html;
if (password) {
  const ITER = 300000;
  const key = crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), ITER, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const ci = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([ci.update(html, 'utf8'), ci.final(), ci.getAuthTag()]);
  const data = Buffer.concat([iv, ct]).toString('base64');
  out = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>よみたん虎の巻 配布版</title>
<style>
:root{color-scheme:light dark;--bg:#F6F4ED;--surface:#FFF;--ink:#22302E;--muted:#68766F;--line:#DFDBCC;--accent:#0E7C7B;--alert:#C1442E}
@media (prefers-color-scheme:dark){:root{--bg:#101D1B;--surface:#182926;--ink:#E6EFEA;--muted:#93A49C;--line:#2B3F3A;--accent:#3AA79F;--alert:#E0705B}}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px 26px;max-width:340px;width:calc(100% - 48px);text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.mark{font-size:34px}
h1{font-size:18px;margin:8px 0 4px}
p{color:var(--muted);font-size:13px;margin:4px 0 16px}
input{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:16px;background:var(--bg);color:var(--ink)}
button{width:100%;margin-top:10px;border:none;border-radius:10px;padding:10px;font-size:15px;font-weight:700;background:var(--accent);color:#fff;cursor:pointer}
#err{color:var(--alert);font-weight:700;font-size:13px;margin-top:10px}
#busy{color:var(--muted);font-size:13px;margin-top:10px}
[hidden]{display:none!important}
</style></head><body>
<div class="card"><div class="mark">🚐🔒</div><h1>よみたん送迎虎の巻</h1>
<p>メンバー共有のパスワードを入力してください</p>
<form id="f"><input id="pw" type="password" autocomplete="current-password" placeholder="パスワード" autofocus>
<button type="submit">開く</button></form>
<div id="busy" hidden>確認中…</div><div id="err" hidden>パスワードが違います</div></div>
<script>
var SALT=${JSON.stringify(saltHex)},ITER=${ITER},DATA=${JSON.stringify(data)};
function hex2buf(h){var a=new Uint8Array(h.length/2);for(var i=0;i<a.length;i++)a[i]=parseInt(h.substr(i*2,2),16);return a}
function b642buf(b){var s=atob(b),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a}
async function open2(rawKey){
  var key=await crypto.subtle.importKey('raw',rawKey,'AES-GCM',false,['decrypt']);
  var raw=b642buf(DATA);
  var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:raw.slice(0,12)},key,raw.slice(12));
  var html=new TextDecoder().decode(pt);
  document.open();document.write(html);document.close();
}
async function derive(pw){
  var km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  var bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:hex2buf(SALT),iterations:ITER,hash:'SHA-256'},km,256);
  return new Uint8Array(bits);
}
(async function(){
  try{var kh=localStorage.getItem('tora-key');if(kh){await open2(hex2buf(kh))}}
  catch(e){try{localStorage.removeItem('tora-key')}catch(_){}}
})();
document.getElementById('f').addEventListener('submit',async function(ev){
  ev.preventDefault();
  var err=document.getElementById('err'),busy=document.getElementById('busy');
  err.hidden=true;busy.hidden=false;
  try{
    var raw=await derive(document.getElementById('pw').value.trim());
    try{localStorage.setItem('tora-key',Array.from(raw).map(function(b){return b.toString(16).padStart(2,'0')}).join(''))}catch(_){}
    await open2(raw);
  }catch(e){busy.hidden=true;err.hidden=false;try{localStorage.removeItem('tora-key')}catch(_){}}
});
</script></body></html>`;
}
fs.writeFileSync(outPath, out);
console.log('wrote', outPath, (out.length/1024).toFixed(1)+'KB', password?'(encrypted)':'(plain)', 'days:', dates.join(' '), 'default:', defaultDate);
