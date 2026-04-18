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
const ADMIN_PWD = process.env.ADMIN_PWD || 'aibti2025'; // 改成你自己的密码

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
  const byLevelRows = Object.entries(stats.byLevel)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([lv, cnt]) => `<tr><td>${lv}</td><td>${cnt}</td><td>${(cnt/stats.total*100).toFixed(1)}%</td></tr>`)
    .join('');

  const byBURows = Object.entries(stats.byBU)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([bu, cnt]) => `<tr><td>${bu}</td><td>${cnt}</td></tr>`)
    .join('');

  const byPersonaRows = Object.entries(stats.byPersona)
    .sort((a, b) => b[1] - a[1])
    .map(([code, cnt]) => `<tr><td>${code}</td><td>${cnt}</td><td>${(cnt/stats.total*100).toFixed(1)}%</td></tr>`)
    .join('');

  const recentRows = results.slice(-20).reverse()
    .map(r => `<tr><td>${r.ts?.slice(0,16)||''}</td><td>${r.bu}</td><td>${r.dept}</td><td>${r.role}</td><td>${r.level}</td><td>${r.personaName}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><title>AIBTI 后台看板</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0a0a0f;color:#f0f0f5;margin:0;padding:20px}
h1{font-size:22px;color:#d4a574;margin-bottom:4px}
.sub{font-size:12px;color:#71717a;margin-bottom:24px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
.card{background:#11131a;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px}
.card .num{font-size:32px;font-weight:800;color:#d4a574}
.card .label{font-size:12px;color:#8a8e9a;margin-top:4px}
table{width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px}
th{text-align:left;color:#8a8e9a;font-size:11px;letter-spacing:.1em;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.07)}
td{padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.04);color:#e4e4e7}
tr:hover td{background:rgba(255,255,255,.03)}
h2{font-size:14px;color:#d4a574;margin:24px 0 8px;letter-spacing:.05em}
.sec{background:#11131a;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;margin-bottom:16px;overflow-x:auto}
a{color:#d4a574}
</style>
</head>
<body>
<h1>AIBTI 后台看板</h1>
<div class="sub">刷新页面获取最新数据 · <a href="?password=${ADMIN_PWD}&export=1">导出 JSON</a></div>

<div class="cards">
  <div class="card"><div class="num">${stats.total}</div><div class="label">总测评人次</div></div>
  <div class="card"><div class="num">${stats.ogPct}</div><div class="label">老虾农占比</div></div>
  <div class="card"><div class="num">${Object.keys(stats.byBU).length}</div><div class="label">已覆盖 BU 数</div></div>
</div>

<div class="sec">
  <h2>等级分布</h2>
  <table><tr><th>等级</th><th>人数</th><th>占比</th></tr>${byLevelRows}</table>
</div>

<div class="sec">
  <h2>人格分布（TOP 15）</h2>
  <table><tr><th>人格</th><th>人数</th><th>占比</th></tr>${byPersonaRows}</table>
</div>

<div class="sec">
  <h2>BU 分布（TOP 15）</h2>
  <table><tr><th>BU</th><th>人数</th></tr>${byBURows}</table>
</div>

<div class="sec">
  <h2>最近 20 条记录</h2>
  <table><tr><th>时间</th><th>BU</th><th>部门</th><th>职能</th><th>等级</th><th>人格</th></tr>${recentRows}</table>
</div>
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
