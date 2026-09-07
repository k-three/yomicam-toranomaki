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
// 要望フォーム（Googleフォーム等）のURL。マスタの requestFormUrl に入っていれば送信ボタンを出す
const rawReqUrl = (masters.state && masters.state.requestFormUrl) || '';
const reqUrl = /^https:\/\//.test(rawReqUrl)
  ? rawReqUrl.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  : '';
if (rawReqUrl && !reqUrl) console.warn('WARN: requestFormUrl は https:// で始まる必要があります。ボタンは出力しません:', rawReqUrl);
const DOWS = ['日','月','火','水','木','金','土'];
const jd = ds => { const d = new Date(ds + 'T12:00:00'); return `${d.getMonth()+1}/${d.getDate()}（${DOWS[d.getDay()]}）`; };
const dstr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// dates に auto を渡すと「直近＋この先」の営業日と、登録済みの長期休暇・休所日を自動で拾う
const PAST_BD = 5;      // 過去の営業日
const AHEAD_BD = 30;    // この先の営業日（約6週間）
const TERM_AHEAD_DAYS = 200; // これより先に始まる長期休暇・休所は含めない
function autoDates() {
  const now = new Date(Date.now() + 9 * 3600 * 1000); // 日本時間
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  const wd = d => { const w = d.getUTCDay(); return w !== 0 && w !== 6; };
  const set = new Set();
  // 過去（今日を含む直近の営業日から遡る）
  let d = new Date(base), n = 0;
  while (!wd(d)) d.setUTCDate(d.getUTCDate() + 1);   // 土日なら次の月曜を基準に
  const anchor = new Date(d);
  while (n < PAST_BD) { if (wd(d)) { set.add(dstr(d)); n++; } d.setUTCDate(d.getUTCDate() - 1); }
  // この先
  d = new Date(anchor); n = 0;
  while (n < AHEAD_BD) { d.setUTCDate(d.getUTCDate() + 1); if (wd(d)) { set.add(dstr(d)); n++; } }
  // 予定が入っている先の日（メンバーの休み・臨時出勤・保護者連絡など）も見られるように
  const limitD = new Date(anchor); limitD.setUTCDate(limitD.getUTCDate() + TERM_AHEAD_DAYS);
  const inRange = ds => { const c = new Date(ds + 'T12:00:00Z'); return wd(c) && c >= anchor && c <= limitD; };
  for (const ds of Object.keys((days.state && days.state.days) || {})) if (inRange(ds)) set.add(ds);
  for (const n2 of (days.state && days.state.parentNotes) || []) if (n2.date && inRange(n2.date)) set.add(n2.date);
  // 長期休暇・休所の期間（先の予定でも見られるように）
  const limit = new Date(anchor); limit.setUTCDate(limit.getUTCDate() + TERM_AHEAD_DAYS);
  for (const t of (masters.state && masters.state.terms) || []) {
    if (!t.from || !t.to) continue;
    let c = new Date(t.from + 'T12:00:00Z'); const end = new Date(t.to + 'T12:00:00Z');
    let guard = 0;
    while (c <= end && guard++ < 400) {
      if (wd(c) && c >= anchor && c <= limit) set.add(dstr(c));
      c.setUTCDate(c.getUTCDate() + 1);
    }
  }
  return [...set].sort();
}
const dates = (datesCsv === 'auto') ? autoDates() : datesCsv.split(',').filter(Boolean);
if (!dates.length) { console.error('対象の日付がありません'); process.exit(1); }

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
// 日別以外のタブ（こども・下校時刻・メンバー・移動時間・アルゴリズム）も読むだけの形で載せる
const refs = await p.evaluate(() => buildRefSnapshot());
await b.close();

const months = [...new Set(sections.map(s => s.ds.slice(0, 7)))].sort();
const monthLabel = m => `${Number(m.slice(5, 7))}月`;
const defMonth = months.includes(defaultDate.slice(0, 7)) ? defaultDate.slice(0, 7) : months[0];
const monthNav = months.map(m =>
  `<button class="mbtn${m === defMonth ? ' on' : ''}" data-m="${m}">${monthLabel(m)}</button>`).join('');
const nav = sections.map(s =>
  `<button class="daybtn" data-d="${s.ds}" data-m="${s.ds.slice(0, 7)}"${s.ds.slice(0, 7) === defMonth ? '' : ' hidden'}>${jd(s.ds)}</button>`).join('');
const secHtml = sections.map(s =>
  `<section class="dsec" id="d${s.ds}" hidden>${s.body}</section>`).join('\n');
const topNav = `<button class="topbtn on" data-t="plan">📋 日別の虎の巻</button>`
  + refs.map(r => `<button class="topbtn" data-t="${r.id}">${r.label}</button>`).join('');
const refHtml = refs.map(r => `<section class="rsec" id="r-${r.id}" hidden>${r.html}</section>`).join('\n');
const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>よみキャン運営虎の巻（閲覧用）</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap" media="print" onload="this.media='all'">
<style>${style}
.topnav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;border-bottom:1px solid var(--line);padding-bottom:10px}
.topbtn{border:1px solid transparent;background:none;color:var(--muted);border-radius:99px;padding:6px 14px;cursor:pointer;font-weight:700;font-family:"Zen Maru Gothic";font-size:14px}
.topbtn:hover{color:var(--ink)}
.topbtn.on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft)}
.rsec .grid td,.rsec .grid th{white-space:normal}
.monthnav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.mbtn{border:1px solid var(--line);background:none;color:var(--muted);border-radius:8px;padding:3px 12px;cursor:pointer;font-weight:700;font-family:"Zen Maru Gothic";font-size:13px}
.mbtn.on{background:var(--surface2);color:var(--ink);border-color:var(--muted)}
.daynav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.daybtn{border:1px solid var(--line);background:var(--surface);border-radius:99px;padding:5px 14px;cursor:pointer;font-weight:700;font-family:"Zen Maru Gothic";font-variant-numeric:tabular-nums}
.daybtn.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.snapnote{color:var(--muted);font-size:11.5px;text-align:center;margin:20px 0}
.ev{cursor:default}
.reqbtn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);background:var(--surface);color:var(--muted);text-decoration:none;font-weight:700;font-size:12px;border-radius:99px;padding:4px 12px;white-space:nowrap;line-height:1.5}
.reqbtn:hover{border-color:var(--accent);color:var(--accent)}
@media print{.reqbtn{display:none!important}}</style></head>
<body><div class="wrap">
<header class="app"><div class="brand"><div class="mark">🚐</div>
<div><h1>よみキャン運営虎の巻（閲覧用）</h1></div></div>
<div class="spacer"></div>
${reqUrl ? `<a class="reqbtn" href="${reqUrl}" target="_blank" rel="noopener noreferrer" title="気づいたこと・改善してほしいことを運行管理担当へ">📮 要望を送る</a>` : ''}</header>
<nav class="topnav" id="topNav">${topNav}</nav>
<div id="planWrap">
<nav class="monthnav" id="monthNav">${monthNav}</nav>
<nav class="daynav" id="dayNav">${nav}</nav>
${secHtml}
</div>
${refHtml}
<p class="snapnote">閲覧専用／${now} 更新。変更は管理用ページ（当日調整）で行います。気づいたことは「📮 要望を送る」からどうぞ。</p>
</div>
<script>
(function(){
  var def=${JSON.stringify('d' + defaultDate)};
  function showMonth(m){
    document.querySelectorAll('.mbtn').forEach(function(b){b.classList.toggle('on',b.dataset.m===m)});
    document.querySelectorAll('.daybtn').forEach(function(b){b.hidden=(b.dataset.m!==m)});
  }
  function show(id){
    var found=false;
    document.querySelectorAll('.dsec').forEach(function(s){var on=s.id===id;s.hidden=!on;if(on)found=true});
    document.querySelectorAll('.daybtn').forEach(function(b){b.classList.toggle('on','d'+b.dataset.d===id)});
    if(found)showMonth(id.slice(1,8));
    return found;
  }
  function showTop(t){
    var isPlan=(t==='plan');
    if(!isPlan&&!document.getElementById('r-'+t)){t='plan';isPlan=true}
    document.querySelectorAll('.topbtn').forEach(function(b){b.classList.toggle('on',b.dataset.t===t)});
    document.getElementById('planWrap').hidden=!isPlan;
    document.querySelectorAll('.rsec').forEach(function(s){s.hidden=(s.id!=='r-'+t)});
    return t;
  }
  function route(){
    var w=(location.hash||'').replace('#','');
    if(w.indexOf('t-')===0){ showTop(w.slice(2)); if(!document.querySelector('.dsec:not([hidden])'))show(def); }
    else { showTop('plan'); if(!w||!show(w)) show(def); }
  }
  route();
  document.getElementById('dayNav').addEventListener('click',function(e){
    var b=e.target.closest('.daybtn'); if(!b)return;
    location.hash='d'+b.dataset.d;
  });
  document.getElementById('monthNav').addEventListener('click',function(e){
    var b=e.target.closest('.mbtn'); if(!b)return;
    showMonth(b.dataset.m);
  });
  document.getElementById('topNav').addEventListener('click',function(e){
    var b=e.target.closest('.topbtn'); if(!b)return;
    if(b.dataset.t==='plan'){
      var cur=document.querySelector('.dsec:not([hidden])');
      location.hash=cur?cur.id:def;
    } else location.hash='t-'+b.dataset.t;
    route();
  });
  window.addEventListener('hashchange',route);
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
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>よみキャン運営虎の巻（閲覧用）</title>
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
<div class="card"><div class="mark">🚐🔒</div><h1>よみキャン運営虎の巻（閲覧用）</h1>
<p>メンバー共有のパスワードを入力してください</p>
<form id="f"><input id="pw" type="password" autocomplete="current-password" placeholder="パスワード" autofocus>
<button type="submit">開く</button></form>
<div id="busy" hidden>確認中…</div><div id="err" hidden>パスワードが違います</div></div>
<script>
var SALT=${JSON.stringify(saltHex)},ITER=${ITER},DATA=${JSON.stringify(data)};
function hex2buf(h){var a=new Uint8Array(h.length/2);for(var i=0;i<a.length;i++)a[i]=parseInt(h.substr(i*2,2),16);return a}
function b642buf(b){var s=atob(b),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a}
function render(html){
  // document.write は「読み込み中」に呼ぶと既存DOMを消さずに追記されてしまい、
  // ロック画面が残ったまま本文が下に出る。DOMを明示的に差し替える。
  var doc=new DOMParser().parseFromString(html,'text/html');
  if(doc.title)document.title=doc.title;
  document.head.innerHTML=doc.head.innerHTML;
  var l=document.head.querySelector('link[rel="stylesheet"]');
  if(l)l.media='all';
  document.body.innerHTML=doc.body.innerHTML;
  // innerHTML で入れた <script> は実行されないので作り直して実行する
  var olds=document.body.querySelectorAll('script');
  for(var i=0;i<olds.length;i++){
    var s=document.createElement('script');
    if(olds[i].src)s.src=olds[i].src;else s.textContent=olds[i].textContent;
    olds[i].parentNode.replaceChild(s,olds[i]);
  }
}
async function open2(rawKey){
  var key=await crypto.subtle.importKey('raw',rawKey,'AES-GCM',false,['decrypt']);
  var raw=b642buf(DATA);
  var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:raw.slice(0,12)},key,raw.slice(12));
  render(new TextDecoder().decode(pt));
}
async function derive(pw){
  var km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  var bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:hex2buf(SALT),iterations:ITER,hash:'SHA-256'},km,256);
  return new Uint8Array(bits);
}
function ready(fn){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fn);else fn();
}
ready(function(){
  (async function(){
    try{
      var raw=localStorage.getItem('tora-key');if(!raw)return;
      var o; try{o=JSON.parse(raw)}catch(_){o={k:raw,t:0}}
      // 14日を過ぎたら鍵を捨てて、もう一度パスワードを聞く
      if(!o.k||!o.t||Date.now()-o.t>14*24*60*60*1000){localStorage.removeItem('tora-key');return}
      await open2(hex2buf(o.k));
    }catch(e){try{localStorage.removeItem('tora-key')}catch(_){}}
  })();
});
document.getElementById('f').addEventListener('submit',async function(ev){
  ev.preventDefault();
  var err=document.getElementById('err'),busy=document.getElementById('busy');
  err.hidden=true;busy.hidden=false;
  try{
    // 全角数字・全角英字でも通るように正規化（日本語IME対策）
    var pwv=document.getElementById('pw').value.trim();
    try{pwv=pwv.normalize('NFKC')}catch(_){}
    var raw=await derive(pwv);
    try{localStorage.setItem('tora-key',JSON.stringify({k:Array.from(raw).map(function(b){return b.toString(16).padStart(2,'0')}).join(''),t:Date.now()}))}catch(_){}
    await open2(raw);
  }catch(e){busy.hidden=true;err.hidden=false;try{localStorage.removeItem('tora-key')}catch(_){}}
});
</script></body></html>`;
}
fs.writeFileSync(outPath, out);
console.log('wrote', outPath, (out.length/1024).toFixed(1)+'KB', password?'(encrypted)':'(plain)', 'days:', dates.join(' '), 'default:', defaultDate);
