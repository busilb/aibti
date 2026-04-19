/**
 * AIBTI 测评后端
 * 技术栈：Node.js 原生 http（无需安装依赖）
 * 数据存储：本地 data.json
 *
 * 本地运行：
 *   node aibti-server.js
 *   访问 http://localhost:3000/admin 查看看板
 *
 * 前端配置：把 aibti-v8.html 里的 CONFIG.API_BASE 改为 'http://localhost:3000'
 *
 * 部署到阿里云 FC / 内网：
 *   - 阿里云 FC：把此文件打包成 zip，上传到函数计算，Handler 填 index.handler
 *   - 内网服务器：pm2 start aibti-server.js --name aibti
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'aibti-data.json');
const ADMIN_PWD = process.env.ADMIN_PWD || 'aibti2025';

// GitHub Issues 统计 token（从环境变量或本地文件读取，不写进代码）
const GH_TOKEN = process.env.GH_STATS_TOKEN ||
  (() => { try { return fs.readFileSync(path.join(process.env.HOME||'~', '.aibti_stats_token'), 'utf8').trim(); } catch(e) { return ''; } })();
const GH_REPO  = 'busilb/aibti';
const DIMS_MAP = { PROMPT:'提示工程', TOOLS:'工具广度', SCENE:'场景洞察', TRUTH:'幻觉警觉', FLOW:'流程融合', FAITH:'AI 信仰' };

/* ── IP → 城市查询（ip-api.com 免费，无需 key） ── */
function lookupCity(ip) {
  return new Promise(resolve => {
    const isPrivate = !ip || ip === '::1' || /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
    if (isPrivate) return resolve({ city: '内网', region: '局域网' });
    const cleanIp = ip.replace(/^::ffff:/, '');
    http.get(`http://ip-api.com/json/${cleanIp}?lang=zh-CN&fields=city,regionName,country,status`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.status === 'success') resolve({ city: j.city || '未知', region: j.regionName || j.country || '未知' });
          else resolve({ city: '未知', region: '未知' });
        } catch { resolve({ city: '未知', region: '未知' }); }
      });
    }).on('error', () => resolve({ city: '未知', region: '未知' }));
  });
}

/* ── GitHub Issues 创建 ── */
/* ── GitHub Issues 通用请求 ── */
function ghRequest(path, method = 'GET', payload = null) {
  const https = require('https');
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'aibti-server'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (payload) req.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    req.end();
  });
}

/* ── 从 GitHub Issues 拉取所有历史记录（最多 n 条） ── */
async function fetchIssueHistory(n = 100) {
  if (!GH_TOKEN) return [];
  const issues = await ghRequest(
    `/repos/${GH_REPO}/issues?labels=stats&state=open&per_page=${n}&sort=created&direction=desc`
  );
  if (!Array.isArray(issues)) return [];
  return issues.map(issue => {
    const body = issue.body || '';
    const get = key => { const m = body.match(new RegExp(`\\*\\*${key}\\*\\*[：:]([^\n]+)`)); return m ? m[1].trim() : ''; };
    const labels = (issue.labels || []).map(l => l.name);
    const lv     = labels.find(l => /^L[1-5]$/.test(l)) || '';
    const role   = labels.find(l => ['OPS','PD','DEV','BD'].includes(l)) || get('职能');
    const isTest = labels.includes('test'); // 打了 test 标签 = 测试数据
    const cityStr = get('城市');
    const [city, region] = cityStr.split('·').map(s => s?.trim() || '');
    const personaRaw = get('人格');
    const personaName = personaRaw.replace(/（.*）/, '').trim();
    const personaCode = (personaRaw.match(/（(.+?)）/) || [])[1] || '';
    const ts = issue.created_at || '';
    // 北京时间格式化
    const tsLocal = ts ? new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
    // tsIso：用于趋势图时间桶（保留 UTC ISO 原始格式）
    // 转成北京时间 ISO 字符串，取前 13 位得到 "2026-04-19T19"
    const tsIso = ts ? (() => {
      const d = new Date(ts);
      const cst = new Date(d.getTime() + 8 * 3600000);
      return cst.toISOString().replace('Z', '+08:00');
    })() : '';
    return { ts: tsLocal, tsIso, level: lv, personaName, personaCode, role, city: city||'', region: region||'', isTest };
  });
}

/* ── 从 GitHub Issues 聚合统计（跨重启持久） ── */
async function calcStatsFromGH() {
  const records = await fetchIssueHistory(100);
  const total = records.length;
  if (total === 0) return { total: 0, ogPct: '0%', byLevel: {}, byPersona: {}, byRole: {}, byCity: {} };
  const byLevel = {}, byPersona = {}, byRole = {}, byCity = {};
  let ogCount = 0;
  records.forEach(r => {
    if (r.level)       byLevel[r.level]     = (byLevel[r.level] || 0) + 1;
    if (r.personaCode) byPersona[r.personaCode] = (byPersona[r.personaCode] || 0) + 1;
    if (r.role)        byRole[r.role]        = (byRole[r.role] || 0) + 1;
    const city = r.city || '未知';
    if (city !== '未知' && city !== '') byCity[city] = (byCity[city] || 0) + 1;
    if (r.personaCode === 'OG-FARMER') ogCount++;
  });
  return { total, ogPct: (ogCount/total*100).toFixed(1)+'%', byLevel, byPersona, byRole, byCity };
}

async function createGHIssue(record) {
  if (!GH_TOKEN) return null;
  const dimStr = Object.entries(DIMS_MAP)
    .map(([k, n]) => `${n}:${record.scores[k] || 0}`).join(' / ');
  const cityStr = record.city ? `${record.city}·${record.region||''}` : '未知';
  const body = [
    `**等级**：${record.level}`,
    `**人格**：${record.personaName}（${record.personaCode}）`,
    `**职能**：${record.role}`,
    `**城市**：${cityStr}`,
    `**六维**：${dimStr}`,
    `**时间**：${new Date(record.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '', '_匿名提交_'
  ].join('\n');
  // source='web' = 真实用户；无 source 或其他值 = 测试
  const isReal = record.source === 'web';
  const labels = [record.level, record.role, 'stats', isReal ? null : 'test'].filter(Boolean);
  return ghRequest(`/repos/${GH_REPO}/issues`, 'POST', {
    title: `[AIBTI] ${record.role} · ${record.level} · ${record.personaName}`,
    body,
    labels
  });
}

/* ── 数据读写 ── */
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { return { results: [] }; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/* ── 聚合统计 ── */
function calcStats(results) {
  const total = results.length;
  if (total === 0) return { total: 0, ogPct: '0%', byLevel: {}, byPersona: {}, byBU: {}, byRole: {}, byCity: {} };

  const byLevel = {}, byPersona = {}, byBU = {}, byRole = {}, byCity = {};
  let ogCount = 0;

  results.forEach(r => {
    byLevel[r.level]         = (byLevel[r.level] || 0) + 1;
    byPersona[r.personaCode] = (byPersona[r.personaCode] || 0) + 1;
    byBU[r.bu]               = (byBU[r.bu] || 0) + 1;
    byRole[r.role]           = (byRole[r.role] || 0) + 1;
    const city = r.city || '未知';
    byCity[city]             = (byCity[city] || 0) + 1;
    if (r.personaCode === 'OG-FARMER') ogCount++;
  });

  return {
    total,
    ogPct: total > 0 ? (ogCount / total * 100).toFixed(1) + '%' : '0%',
    byLevel, byPersona, byBU, byRole, byCity
  };
}

/* ── Ticker 最近 N 条 ── */
function getTickerLines(results, n = 10) {
  return results
    .slice(-n)
    .reverse()
    .map(r => ({
      bu: r.bu, role: r.role, level: r.level,
      personaName: r.personaName, ts: r.ts,
      city: r.city || '', region: r.region || ''
    }));
}

/* ── HTTP 工具 ── */
function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',   // CORS：允许 1d.alibaba-inc.com 访问
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { resolve({}); }
    });
  });
}
function adminCheck(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('password') !== ADMIN_PWD) {
    json(res, { error: '无权限，密码错误' }, 403);
    return false;
  }
  return true;
}

/* ── 管理员 SPA（纯前端，自动 30s 刷新） ── */
function adminSPA(pwd) {
  const API = `/api`;
  return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIBTI 数据看板</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#08090c;color:#f0f0f5;padding:16px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:8px}
h1{font-size:22px;font-weight:800;background:linear-gradient(135deg,#a855f7,#ec4899,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.meta{font-size:12px;color:#52525b;display:flex;align-items:center;gap:12px}
.meta a{color:#a855f7;text-decoration:none}
.refresh-btn{background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);color:#a855f7;padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit}
.refresh-btn:hover{background:rgba(168,85,247,.25)}
.countdown{color:#52525b;font-size:11px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
@media(max-width:600px){.cards{grid-template-columns:repeat(2,1fr)}}
.card{background:#11131a;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:14px}
.card .num{font-size:34px;font-weight:900;color:#d4a574;line-height:1}
.card .lbl{font-size:11px;color:#8a8e9a;margin-top:5px;letter-spacing:.05em}
.sec{background:#11131a;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;margin-bottom:12px}
.sec h2{font-size:11px;letter-spacing:.2em;color:#8a8e9a;font-weight:700;text-transform:uppercase;margin-bottom:14px}
.chart-wrap{position:relative;height:220px}
.pie-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:700px){.pie-row{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#6b7280;font-size:11px;padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.06)}
td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.03);color:#d4d4d8}
tr:hover td{background:rgba(255,255,255,.02)}
.badge{display:inline-block;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700;color:#fff}
.L1{background:#6b7280}.L2{background:#3b82f6}.L3{background:#10b981}.L4{background:#8b5cf6}.L5{background:#f59e0b}
.b-real{font-size:10px;background:rgba(16,185,129,.2);color:#34d399;padding:1px 6px;border-radius:99px}
.b-test{font-size:10px;background:rgba(107,114,128,.2);color:#9ca3af;padding:1px 6px;border-radius:99px}
.loading{text-align:center;padding:40px;color:#52525b}
.error{color:#ef4444;text-align:center;padding:20px}
</style>
</head><body>
<div class="header">
  <h1>AIBTI 数据看板</h1>
  <div class="meta">
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#d4d4d8">
      <input type="checkbox" id="hideTest" onchange="applyFilter()" style="width:14px;height:14px;accent-color:#a855f7">
      仅看真实数据
    </label>
    <span id="lastUpdate">加载中...</span>
    <a href="?password=${pwd}&export=1">导出 JSON</a>
    <button class="refresh-btn" onclick="loadData()">立即刷新</button>
    <span class="countdown" id="countdown"></span>
  </div>
</div>

<div class="cards">
  <div class="card"><div class="num" id="cTotal">-</div><div class="lbl">总测评人次</div></div>
  <div class="card"><div class="num" id="cReal">-</div><div class="lbl">真实用户</div></div>
  <div class="card"><div class="num" id="cOg">-</div><div class="lbl">老虾农占比</div></div>
</div>

<div class="sec">
  <h2>每小时趋势（上线至今 · 2026/04/19 起）</h2>
  <div class="chart-wrap"><canvas id="trendChart"></canvas></div>
</div>

<div class="pie-row">
  <div class="sec"><h2>段位分布</h2><div class="chart-wrap" style="height:200px"><canvas id="lvChart"></canvas></div></div>
  <div class="sec"><h2>人格分布 Top10</h2><div class="chart-wrap" style="height:200px"><canvas id="pChart"></canvas></div></div>
</div>

<div id="citySection" style="display:none">
  <div class="sec"><h2>城市分布</h2><div class="chart-wrap" id="cityWrap" style="height:120px"><canvas id="cityChart"></canvas></div></div>
</div>

<div class="sec">
  <h2 id="historyTitle">提交人明细（加载中...）</h2>
  <table id="historyTable">
    <tr><th>时间（北京）</th><th>职能</th><th>等级</th><th>人格</th><th>城市·省份</th><th>类型</th></tr>
    <tr><td colspan="6" class="loading">加载中...</td></tr>
  </table>
</div>

<script>
const PWD = '${pwd}';
const API = '';
const C = {text:'rgba(255,255,255,.7)',grid:'rgba(255,255,255,.06)',tick:'rgba(255,255,255,.5)'};
let charts = {};
let timer, countdownVal = 30;
let allRecords = [], allStats = {};

function applyFilter() {
  const hideTest = document.getElementById('hideTest').checked;
  const filtered = hideTest ? allRecords.filter(r => !r.isTest) : allRecords;
  renderHistory(filtered);
  renderCharts(buildFilteredStats(filtered), filtered);
}

function buildFilteredStats(records) {
  const byLevel={}, byPersona={}, byRole={}, byCity={};
  let ogCount=0;
  records.forEach(r => {
    if(r.level)       byLevel[r.level]     = (byLevel[r.level]||0)+1;
    if(r.personaCode) byPersona[r.personaCode] = (byPersona[r.personaCode]||0)+1;
    if(r.role)        byRole[r.role]        = (byRole[r.role]||0)+1;
    const city = r.city||'';
    if(city && city!=='未知') byCity[city] = (byCity[city]||0)+1;
    if(r.personaCode==='OG-FARMER') ogCount++;
  });
  const total = records.length;
  return { total, ogPct: total>0?(ogCount/total*100).toFixed(1)+'%':'0%', byLevel, byPersona, byRole, byCity };
}

function destroyChart(id){ if(charts[id]){ charts[id].destroy(); delete charts[id]; } }

async function loadData() {
  clearInterval(timer);
  countdownVal = 30;
  try {
    const [statsRes, histRes] = await Promise.all([
      fetch(API + '/api/stats').then(r=>r.json()),
      fetch(API + '/api/history?password=' + PWD).then(r=>r.json())
    ]);
    allRecords = histRes.records || [];
    allStats   = statsRes;
    const hideTest = document.getElementById('hideTest').checked;
    const filtered = hideTest ? allRecords.filter(r => !r.isTest) : allRecords;
    renderStats(buildFilteredStats(filtered));
    renderHistory(filtered);
    renderCharts(buildFilteredStats(filtered), filtered);
    document.getElementById('lastUpdate').textContent = '更新时间：' + new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  } catch(e) {
    document.getElementById('lastUpdate').innerHTML = '<span class="error">加载失败，请刷新</span>';
  }
  startCountdown();
}

function renderStats(d) {
  document.getElementById('cTotal').textContent = d.total || 0;
  document.getElementById('cOg').textContent = d.ogPct || '0%';
}

function renderHistory(records) {
  const real = records.filter(r => !r.isTest).length;
  document.getElementById('cReal').textContent = real;
  document.getElementById('historyTitle').textContent = '提交人明细（最近 ' + records.length + ' 条）';
  const rows = records.map(r => {
    const lv = r.level ? '<span class="badge ' + r.level + '">' + r.level + '</span>' : '-';
    const loc = r.city ? r.city + (r.region ? ' · ' + r.region : '') : '-';
    const src = r.isTest ? '<span class="b-test">测试</span>' : '<span class="b-real">真实</span>';
    return '<tr><td>' + (r.ts||'-') + '</td><td>' + (r.role||'-') + '</td><td>' + lv + '</td><td>' + (r.personaName||'-') + '</td><td>' + loc + '</td><td>' + src + '</td></tr>';
  }).join('');
  document.getElementById('historyTable').innerHTML =
    '<tr><th>时间（北京）</th><th>职能</th><th>等级</th><th>人格</th><th>城市·省份</th><th>类型</th></tr>' +
    (rows || '<tr><td colspan="6" class="loading">暂无数据</td></tr>');
}

function renderCharts(stats, records) {
  // 趋势图（北京时间，从上线到现在）
  const LAUNCH = new Date('2026-04-18T16:00:00Z');
  const now = Date.now();
  const totalH = Math.ceil((now - LAUNCH.getTime()) / 3600000) + 1;
  const buckets = {};
  for(let i = totalH-1; i >= 0; i--) {
    const cst = new Date(now - i*3600000 + 8*3600000);
    const key = cst.toISOString().slice(0,13);
    const lbl = (cst.getUTCMonth()+1+'').padStart(2,'0') + '/' + (cst.getUTCDate()+'').padStart(2,'0') + ' ' + (cst.getUTCHours()+'').padStart(2,'0') + ':00';
    buckets[key] = {lbl, count:0};
  }
  records.forEach(r => {
    const key = (r.tsIso||'').slice(0,13);
    if(buckets[key]) buckets[key].count++;
  });
  const tLabels = Object.values(buckets).map(b=>b.lbl);
  const tData   = Object.values(buckets).map(b=>b.count);
  destroyChart('trend');
  charts.trend = new Chart(document.getElementById('trendChart'), {
    type:'bar',
    data:{ labels:tLabels, datasets:[{label:'测评次数',data:tData,backgroundColor:'rgba(168,85,247,.6)',borderColor:'#a855f7',borderWidth:1,borderRadius:4}] },
    options:{ responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{ x:{ticks:{color:C.tick,maxTicksLimit:12,font:{size:10}},grid:{color:C.grid}}, y:{ticks:{color:C.tick,stepSize:1},grid:{color:C.grid},beginAtZero:true} } }
  });

  // 段位饼
  const LV = ['L1','L2','L3','L4','L5'];
  const LC = ['#6b7280','#3b82f6','#10b981','#8b5cf6','#f59e0b'];
  const LN = ['L1 蛮荒','L2 启蒙','L3 工业','L4 信息','L5 奇点'];
  destroyChart('lv');
  charts.lv = new Chart(document.getElementById('lvChart'), {
    type:'doughnut',
    data:{ labels:LN, datasets:[{data:LV.map(l=>stats.byLevel[l]||0),backgroundColor:LC,borderWidth:0}] },
    options:{ responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:C.text,padding:10,font:{size:11}}}} }
  });

  // 人格饼
  const PE = Object.entries(stats.byPersona||{}).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const PC = ['#a855f7','#ec4899','#06b6d4','#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#f97316','#14b8a6'];
  destroyChart('p');
  charts.p = new Chart(document.getElementById('pChart'), {
    type:'doughnut',
    data:{ labels:PE.map(([k])=>k), datasets:[{data:PE.map(([,v])=>v),backgroundColor:PC.slice(0,PE.length),borderWidth:0}] },
    options:{ responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:C.text,padding:8,font:{size:11},boxWidth:12}}} }
  });

  // 城市条形
  const CE = Object.entries(stats.byCity||{}).filter(([c])=>c&&c!=='未知').sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(CE.length > 0) {
    document.getElementById('citySection').style.display = 'block';
    document.getElementById('cityWrap').style.height = Math.max(100, CE.length*36) + 'px';
    destroyChart('city');
    charts.city = new Chart(document.getElementById('cityChart'), {
      type:'bar',
      data:{ labels:CE.map(([c])=>c), datasets:[{data:CE.map(([,v])=>v),backgroundColor:'rgba(6,182,212,.6)',borderColor:'#06b6d4',borderWidth:1,borderRadius:4}] },
      options:{ indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
        scales:{ x:{ticks:{color:C.tick,stepSize:1},grid:{color:C.grid},beginAtZero:true}, y:{ticks:{color:C.text,font:{size:13}},grid:{display:false}} } }
    });
  }
}

function startCountdown() {
  countdownVal = 30;
  timer = setInterval(() => {
    countdownVal--;
    document.getElementById('countdown').textContent = countdownVal + 's 后刷新';
    if(countdownVal <= 0) loadData();
  }, 1000);
}

loadData();
</script>
</body></html>`;
}

/* ── 管理员 HTML 看板 ── */
function adminHTML(stats, results) {
  // 趋势图：从上线时间 2026-04-19 00:00 北京时间起，到当前每小时
  const LAUNCH_CST = new Date('2026-04-18T16:00:00Z'); // 4月19日00:00北京 = UTC+8
  const now = Date.now();
  const totalHours = Math.ceil((now - LAUNCH_CST.getTime()) / 3600000) + 1;
  const hourBuckets = {};
  for (let i = totalHours - 1; i >= 0; i--) {
    const utc = new Date(now - i * 3600000);
    const cst = new Date(utc.getTime() + 8 * 3600000); // +8 北京时间
    const key = cst.toISOString().slice(0, 13);
    const label = `${String(cst.getUTCMonth()+1).padStart(2,'0')}/${String(cst.getUTCDate()).padStart(2,'0')} ${String(cst.getUTCHours()).padStart(2,'0')}:00`;
    hourBuckets[key] = { label, count: 0 };
  }
  results.forEach(r => {
    // 用 tsIso（北京时间 ISO 格式）做时间桶，格式 "2026-04-19T19"
    const key = (r.tsIso || r.ts || '').slice(0, 13);
    if (hourBuckets[key]) hourBuckets[key].count++;
  });
  const trendLabels = JSON.stringify(Object.values(hourBuckets).map(b => b.label));
  const trendData   = JSON.stringify(Object.values(hourBuckets).map(b => b.count));

  // 等级饼图
  const lvOrder = ['L1','L2','L3','L4','L5'];
  const lvColors = ['#6b7280','#3b82f6','#10b981','#8b5cf6','#f59e0b'];
  const lvLabels = JSON.stringify(lvOrder.map(l => l + ' ' + ({L1:'蛮荒',L2:'启蒙',L3:'工业',L4:'信息',L5:'奇点'}[l]||'')));
  const lvData   = JSON.stringify(lvOrder.map(l => stats.byLevel[l] || 0));
  const lvColors_= JSON.stringify(lvColors);

  // 人格饼图（取前 10）
  const personaEntries = Object.entries(stats.byPersona).sort((a,b) => b[1]-a[1]).slice(0, 10);
  const pColors = ['#a855f7','#ec4899','#06b6d4','#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#f97316','#14b8a6'];
  const pLabels = JSON.stringify(personaEntries.map(([k]) => k));
  const pData   = JSON.stringify(personaEntries.map(([,v]) => v));
  const pColors_= JSON.stringify(pColors.slice(0, personaEntries.length));

  // 城市分布（水平条形图，Top 10）
  const cityEntries = Object.entries(stats.byCity || {})
    .filter(([c]) => c !== '未知' && c !== '')
    .sort((a,b) => b[1]-a[1]).slice(0, 10);
  const cityLabels = JSON.stringify(cityEntries.map(([c]) => c));
  const cityData   = JSON.stringify(cityEntries.map(([,v]) => v));
  const hasCityData = cityEntries.length > 0;

  // 全量历史记录（最多 100 条，来自 GitHub Issues）
  const recentRows = results
    .map(r => {
      const ts = r.ts || '-';
      const loc = r.city ? `${r.city}${r.region ? ' · '+r.region : ''}` : '-';
      const lvBadge = r.level ? `<span class="badge ${r.level}">${r.level}</span>` : '-';
      const srcBadge = r.isTest
        ? `<span style="font-size:10px;background:rgba(107,114,128,.25);color:#9ca3af;padding:1px 6px;border-radius:99px;">测试</span>`
        : `<span style="font-size:10px;background:rgba(16,185,129,.2);color:#34d399;padding:1px 6px;border-radius:99px;">真实</span>`;
      return `<tr><td>${ts}</td><td>${r.role||'-'}</td><td>${lvBadge}</td><td>${r.personaName||'-'}</td><td>${loc}</td><td>${srcBadge}</td></tr>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIBTI 数据看板</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#08090c;color:#f0f0f5;padding:20px;min-height:100vh}
.header{margin-bottom:24px}
h1{font-size:22px;font-weight:800;background:linear-gradient(135deg,#a855f7,#ec4899,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sub{font-size:12px;color:#52525b;margin-top:4px}
.sub a{color:#a855f7;text-decoration:none}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
@media(max-width:600px){.cards{grid-template-columns:repeat(2,1fr)}}
.card{background:#11131a;border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:16px}
.card .num{font-size:36px;font-weight:900;color:#d4a574;line-height:1}
.card .lbl{font-size:11px;color:#8a8e9a;margin-top:6px;letter-spacing:.05em}
.sec{background:#11131a;border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:18px;margin-bottom:14px}
.sec h2{font-size:12px;letter-spacing:.2em;color:#8a8e9a;font-weight:700;text-transform:uppercase;margin-bottom:16px}
.charts-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
@media(max-width:700px){.charts-row{grid-template-columns:1fr}}
.chart-wrap{position:relative;height:260px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#6b7280;font-size:11px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.06)}
td{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.03);color:#d4d4d8}
tr:hover td{background:rgba(255,255,255,.03)}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;color:#fff}
.L1{background:#6b7280}.L2{background:#3b82f6}.L3{background:#10b981}.L4{background:#8b5cf6}.L5{background:#f59e0b}
</style>
</head>
<body>
<div class="header">
  <h1>AIBTI 数据看板</h1>
  <p class="sub">实时刷新 · <a href="?password=${ADMIN_PWD}&export=1">导出 JSON</a> · 数据来源：GitHub Issues</p>
</div>

<div class="cards">
  <div class="card"><div class="num">${stats.total}</div><div class="lbl">总测评人次</div></div>
  <div class="card"><div class="num">${stats.ogPct}</div><div class="lbl">老虾农占比</div></div>
  <div class="card"><div class="num">${Object.keys(stats.byRole||{}).length}</div><div class="lbl">覆盖职能数</div></div>
</div>

<div class="sec">
  <h2>每小时测评趋势（上线至今 · 2026/04/19 00:00 起）</h2>
  <div class="chart-wrap"><canvas id="trendChart"></canvas></div>
</div>

<div class="charts-row">
  <div class="sec">
    <h2>段位分布</h2>
    <div class="chart-wrap"><canvas id="lvChart"></canvas></div>
  </div>
  <div class="sec">
    <h2>人格分布 Top 10</h2>
    <div class="chart-wrap"><canvas id="pChart"></canvas></div>
  </div>
</div>

${hasCityData ? `
<div class="sec">
  <h2>城市分布（基于提交 IP）</h2>
  <p style="font-size:11px;color:#52525b;margin-bottom:12px">注：内网用户 IP 可能集中显示为公司所在城市</p>
  <div class="chart-wrap" style="height:${Math.max(120, cityEntries.length * 36)}px"><canvas id="cityChart"></canvas></div>
</div>` : ''}

<div class="sec">
  <h2>提交人明细（全量历史，最多 100 条 · 来源 GitHub Issues）</h2>
  <table>
    <tr><th>时间（北京）</th><th>职能</th><th>等级</th><th>人格</th><th>城市 · 省份</th><th>类型</th></tr>
    ${recentRows || '<tr><td colspan="5" style="text-align:center;color:#52525b;padding:20px">暂无数据</td></tr>'}
  </table>
</div>

<script>
const C = { text:'rgba(255,255,255,.7)', grid:'rgba(255,255,255,.06)', tick:'rgba(255,255,255,.5)' };

// 趋势柱状图
new Chart(document.getElementById('trendChart'), {
  type: 'bar',
  data: {
    labels: ${trendLabels},
    datasets: [{
      label: '测评次数',
      data: ${trendData},
      backgroundColor: 'rgba(168,85,247,.6)',
      borderColor: '#a855f7',
      borderWidth: 1,
      borderRadius: 4
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: C.tick, maxTicksLimit: 12, font: { size: 10 } },
        grid: { color: C.grid }
      },
      y: {
        ticks: { color: C.tick, stepSize: 1 },
        grid: { color: C.grid },
        beginAtZero: true
      }
    }
  }
});

// 等级饼图
new Chart(document.getElementById('lvChart'), {
  type: 'doughnut',
  data: {
    labels: ${lvLabels},
    datasets: [{ data: ${lvData}, backgroundColor: ${lvColors_}, borderWidth: 0 }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { color: C.text, padding: 12, font: { size: 12 } } }
    }
  }
});

// 城市水平条形图
if (document.getElementById('cityChart')) {
  new Chart(document.getElementById('cityChart'), {
    type: 'bar',
    data: {
      labels: ${cityLabels},
      datasets: [{
        label: '人数',
        data: ${cityData},
        backgroundColor: 'rgba(6,182,212,.65)',
        borderColor: '#06b6d4',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: C.tick, stepSize: 1 }, grid: { color: C.grid }, beginAtZero: true },
        y: { ticks: { color: C.text, font: { size: 13 } }, grid: { display: false } }
      }
    }
  });
}

// 人格饼图
new Chart(document.getElementById('pChart'), {
  type: 'doughnut',
  data: {
    labels: ${pLabels},
    datasets: [{ data: ${pData}, backgroundColor: ${pColors_}, borderWidth: 0 }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { color: C.text, padding: 8, font: { size: 11 }, boxWidth: 12 } }
    }
  }
});
</script>
</body>
</html>`;
}

/* ── 路由 ── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const path_ = u.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // POST /api/submit - 接收测评结果
  if (req.method === 'POST' && path_ === '/api/submit') {
    const body = await readBody(req);
    // 提取客户端真实 IP（FC 经过负载均衡，从 x-forwarded-for 取第一个）
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.headers['x-real-ip']
      || req.socket?.remoteAddress || '';
    // 异步查城市（不阻塞主流程，查完后追加更新）
    const cityInfo = await lookupCity(clientIp);
    const data = loadData();
    const record = {
      id:   crypto.randomBytes(8).toString('hex'),
      ts:   new Date().toISOString(),
      ip:   clientIp.replace(/^::ffff:/, '').slice(0, 45), // 脱敏：只存 IP，不存完整
      city:   cityInfo.city,
      region: cityInfo.region,
      bu:   String(body.bu   || '').slice(0, 30),
      dept: String(body.dept || '').slice(0, 30),
      role: String(body.role || '').slice(0, 10),
      level:       String(body.level       || '').slice(0, 5),
      personaCode: String(body.personaCode || '').slice(0, 20),
      personaName: String(body.personaName || '').slice(0, 20),
      scores: body.scores || {},
      source: body.source === 'web' ? 'web' : 'test' // web=真实用户，test=调试
    };
    data.results.push(record);
    saveData(data);
    const stats = calcStats(data.results);
    createGHIssue(record).then(issue => {
      if (issue && issue.number) console.log(`[GH Issue] #${issue.number} ${record.level} ${record.personaName} @${cityInfo.city}`);
    });
    return json(res, { ok: true, total: stats.total });
  }

  // GET /api/stats - 聚合统计（优先从 GitHub Issues，跨重启持久）
  if (req.method === 'GET' && path_ === '/api/stats') {
    const ghStats = await calcStatsFromGH();
    if (ghStats.total > 0) return json(res, ghStats);
    // GH 无数据时降级本地
    const data = loadData();
    return json(res, calcStats(data.results));
  }

  // GET /api/ticker - 最近动态
  if (req.method === 'GET' && path_ === '/api/ticker') {
    const history = await fetchIssueHistory(12);
    if (history.length > 0) return json(res, { lines: history.map(r => ({ ...r, bu:'' })) });
    const data = loadData();
    return json(res, { lines: getTickerLines(data.results, 12) });
  }

  // GET /api/dept/:deptName - 部门对线数据
  if (req.method === 'GET' && path_.startsWith('/api/dept/')) {
    const deptName = decodeURIComponent(path_.replace('/api/dept/', ''));
    const data = loadData();
    const deptResults = data.results.filter(r => r.dept === deptName);
    const byLevel = {};
    deptResults.forEach(r => { byLevel[r.level] = (byLevel[r.level]||0)+1; });
    return json(res, { dept: deptName, total: deptResults.length, byLevel });
  }

  // GET /api/history - 历史记录（供前端 SPA 拉取，需密码）
  if (req.method === 'GET' && path_ === '/api/history') {
    if (!adminCheck(req, res)) return;
    const history = await fetchIssueHistory(100);
    return json(res, { records: history });
  }

  // GET /admin - 管理员看板 SPA（纯前端，自动 30s 刷新）
  if (req.method === 'GET' && path_ === '/admin') {
    if (!adminCheck(req, res)) return;
    // 导出 JSON
    if (u.searchParams.get('export')) {
      const history = await fetchIssueHistory(100);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="aibti-export.json"',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify(history, null, 2));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(adminSPA(u.searchParams.get('password')));
  }

  // 静态文件服务（前端 index.html + image/ 目录）
  const staticMap = { '.png':'image/png', '.jpg':'image/jpeg', '.html':'text/html; charset=utf-8',
    '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };

  let filePath;
  if (path_ === '/' || path_ === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else if (path_.startsWith('/image/')) {
    filePath = path.join(__dirname, path_);
  } else {
    filePath = null;
  }

  if (filePath && fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const mime = staticMap[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    return fs.createReadStream(filePath).pipe(res);
  }

  // 404
  json(res, { error: 'Not Found' }, 404);
});

server.listen(PORT, () => {
  console.log(`\n✅ AIBTI 后端已启动`);
  console.log(`   API:   http://localhost:${PORT}/api/stats`);
  console.log(`   看板: http://localhost:${PORT}/admin?password=${ADMIN_PWD}`);
  console.log(`\n   数据文件: aibti-data.json`);
  console.log(`   前端配置: 把 aibti-v8.html 里 CONFIG.API_BASE 改为 'http://localhost:${PORT}'\n`);
});
