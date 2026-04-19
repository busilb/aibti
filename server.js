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

/* ── GitHub Issues 创建 ── */
async function createGHIssue(record) {
  if (!GH_TOKEN) return null;
  const https = require('https');
  const dimStr = Object.entries(DIMS_MAP)
    .map(([k, n]) => `${n}:${record.scores[k] || 0}`).join(' / ');
  const body = [
    `**等级**：${record.level}`,
    `**人格**：${record.personaName}（${record.personaCode}）`,
    `**职能**：${record.role}`,
    `**六维**：${dimStr}`,
    `**时间**：${new Date(record.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '', '_匿名提交_'
  ].join('\n');
  const payload = JSON.stringify({
    title: `[AIBTI] ${record.role} · ${record.level} · ${record.personaName}`,
    body,
    labels: [record.level, record.role, 'stats'].filter(Boolean)
  });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GH_REPO}/issues`,
      method: 'POST',
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'aibti-server'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
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
  if (total === 0) return { total: 0, ogPct: '0%', byLevel: {}, byPersona: {}, byBU: {}, byRole: {} };

  const byLevel = {}, byPersona = {}, byBU = {}, byRole = {};
  let ogCount = 0;

  results.forEach(r => {
    byLevel[r.level]      = (byLevel[r.level] || 0) + 1;
    byPersona[r.personaCode] = (byPersona[r.personaCode] || 0) + 1;
    byBU[r.bu]            = (byBU[r.bu] || 0) + 1;
    byRole[r.role]        = (byRole[r.role] || 0) + 1;
    if (r.personaCode === 'OG-FARMER') ogCount++;
  });

  return {
    total,
    ogPct: total > 0 ? (ogCount / total * 100).toFixed(1) + '%' : '0%',
    byLevel, byPersona, byBU, byRole
  };
}

/* ── Ticker 最近 N 条 ── */
function getTickerLines(results, n = 10) {
  return results
    .slice(-n)
    .reverse()
    .map(r => ({
      bu: r.bu, role: r.role, level: r.level,
      personaName: r.personaName, ts: r.ts
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

/* ── 管理员 HTML 看板 ── */
function adminHTML(stats, results) {
  // 最近 48 小时每小时趋势（基于提交记录的 ts 字段）
  const now = Date.now();
  const hourBuckets = {};
  for (let i = 47; i >= 0; i--) {
    const d = new Date(now - i * 3600000);
    const key = d.toISOString().slice(0, 13); // "2026-04-19T10"
    const label = `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;
    hourBuckets[key] = { label, count: 0 };
  }
  results.forEach(r => {
    const key = (r.ts || '').slice(0, 13);
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

  // 最近 20 条记录表格
  const recentRows = results.slice(-20).reverse()
    .map(r => {
      const ts = r.ts ? new Date(r.ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}).replace(/\//g,'-') : '';
      return `<tr><td>${ts}</td><td>${r.role||'-'}</td><td>${r.level||'-'}</td><td>${r.personaName||'-'}</td></tr>`;
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
  <h2>每小时测评趋势（近 48 小时）</h2>
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

<div class="sec">
  <h2>最近 20 条记录</h2>
  <table>
    <tr><th>时间（北京）</th><th>职能</th><th>等级</th><th>人格</th></tr>
    ${recentRows}
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
    const data = loadData();
    const record = {
      id:   crypto.randomBytes(8).toString('hex'),
      ts:   new Date().toISOString(),
      bu:   String(body.bu   || '').slice(0, 30),
      dept: String(body.dept || '').slice(0, 30),
      role: String(body.role || '').slice(0, 10),
      level:       String(body.level       || '').slice(0, 5),
      personaCode: String(body.personaCode || '').slice(0, 20),
      personaName: String(body.personaName || '').slice(0, 20),
      scores: body.scores || {}
    };
    data.results.push(record);
    saveData(data);
    const stats = calcStats(data.results);
    // 异步创建 GitHub Issue（不阻塞响应）
    createGHIssue(record).then(issue => {
      if (issue && issue.number) console.log(`[GH Issue] #${issue.number} ${record.level} ${record.personaName}`);
    });
    return json(res, { ok: true, total: stats.total });
  }

  // GET /api/stats - 聚合统计（供首页 proof 用）
  if (req.method === 'GET' && path_ === '/api/stats') {
    const data = loadData();
    return json(res, calcStats(data.results));
  }

  // GET /api/ticker - 最近动态（供首页滚动用）
  if (req.method === 'GET' && path_ === '/api/ticker') {
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

  // GET /admin - 管理员看板（需要密码）
  if (req.method === 'GET' && path_ === '/admin') {
    if (!adminCheck(req, res)) return;
    const data = loadData();
    // 导出 JSON
    if (u.searchParams.get('export')) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="aibti-export.json"',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify(data.results, null, 2));
    }
    const stats = calcStats(data.results);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(adminHTML(stats, data.results));
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
