/**
 * AIBTI 后端 · 阿里云函数计算 FC 版
 *
 * 数据存储：GitHub Issues（无需数据库/文件系统）
 * 运行时：Node.js 18
 * 触发器：HTTP 触发器
 *
 * 环境变量（在 FC 控制台配置）：
 *   GH_STATS_TOKEN  - GitHub token（issues:write 权限）
 *   ADMIN_PWD       - 管理员密码（可选，默认 aibti2025）
 */

'use strict';

const https  = require('https');
const crypto = require('crypto');

const GH_TOKEN  = process.env.GH_STATS_TOKEN || '';
const GH_REPO   = 'busilb/aibti';
const ADMIN_PWD = process.env.ADMIN_PWD || 'aibti2025';

const LEVEL_NAME = { L1:'蛮荒纪元', L2:'启蒙时代', L3:'工业革命', L4:'信息时代', L5:'奇点降临' };
const DIMS_MAP   = { PROMPT:'提示工程', TOOLS:'工具广度', SCENE:'场景洞察', TRUTH:'幻觉警觉', FLOW:'流程融合', FAITH:'AI 信仰' };

/* ── GitHub API 通用请求 ── */
function ghReq(path, method='GET', body=null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'aibti-fc'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ── 读取所有 stats Issues（聚合统计）── */
async function loadStats() {
  let page = 1, all = [];
  while (true) {
    const r = await ghReq(`/repos/${GH_REPO}/issues?labels=stats&state=open&per_page=100&page=${page}`);
    if (!Array.isArray(r.body) || r.body.length === 0) break;
    all = all.concat(r.body);
    if (r.body.length < 100) break;
    page++;
  }
  const byLevel = {}, byPersona = {}, byRole = {};
  all.forEach(issue => {
    const labels = issue.labels.map(l => l.name);
    const lv = labels.find(l => /^L[1-5]$/.test(l)) || '-';
    const role = labels.find(l => ['OPS','PD','DEV','BD'].includes(l)) || '-';
    const titleMatch = issue.title.match(/·\s*(.+)$/);
    const persona = titleMatch ? titleMatch[1].trim() : '?';
    byLevel[lv]     = (byLevel[lv] || 0) + 1;
    byPersona[persona] = (byPersona[persona] || 0) + 1;
    byRole[role]    = (byRole[role] || 0) + 1;
  });
  const ogCount = all.filter(i => i.title.includes('老虾农')).length;
  return {
    total: all.length,
    ogPct: all.length > 0 ? (ogCount / all.length * 100).toFixed(1) + '%' : '0%',
    byLevel, byPersona, byRole
  };
}

/* ── 创建 Issue 记录 ── */
async function createIssue(record) {
  const dimStr = Object.entries(DIMS_MAP)
    .map(([k, n]) => `${n}:${record.scores?.[k] || 0}`).join(' / ');
  const body = [
    `**等级**：${record.level} · ${LEVEL_NAME[record.level] || ''}`,
    `**人格**：${record.personaName}（${record.personaCode}）`,
    `**职能**：${record.role}`,
    `**六维**：${dimStr}`,
    `**时间**：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '', '_匿名提交_'
  ].join('\n');
  return ghReq(`/repos/${GH_REPO}/issues`, 'POST', {
    title: `[AIBTI] ${record.role} · ${record.level} · ${record.personaName}`,
    body,
    labels: [record.level, record.role, 'stats'].filter(Boolean)
  });
}

/* ── 最近 Ticker ── */
async function getTicker() {
  const r = await ghReq(`/repos/${GH_REPO}/issues?labels=stats&state=open&per_page=12&sort=created&direction=desc`);
  if (!Array.isArray(r.body)) return { lines: [] };
  return {
    lines: r.body.map(i => {
      const labels = i.labels.map(l => l.name);
      const lv   = labels.find(l => /^L[1-5]$/.test(l)) || '';
      const role = labels.find(l => ['OPS','PD','DEV','BD'].includes(l)) || '同学';
      const titleMatch = i.title.match(/·\s*(.+)$/);
      const persona = titleMatch ? titleMatch[1].trim() : '';
      return { level: lv, role, personaName: persona, ts: i.created_at };
    })
  };
}

/* ── 管理员 HTML ── */
async function adminHTML(stats) {
  const byLvRows = Object.entries(stats.byLevel)
    .sort((a,b) => a[0].localeCompare(b[0]))
    .map(([lv,n]) => `<tr><td>${lv}</td><td>${n}</td><td>${(n/stats.total*100).toFixed(1)}%</td></tr>`).join('');
  const byPersonaRows = Object.entries(stats.byPersona)
    .sort((a,b) => b[1]-a[1]).slice(0,10)
    .map(([p,n]) => `<tr><td>${p}</td><td>${n}</td><td>${(n/stats.total*100).toFixed(1)}%</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8">
<title>AIBTI 看板</title>
<style>body{font-family:-apple-system,PingFang SC,sans-serif;background:#0d0015;color:#f0f0f5;padding:20px}
h1{color:#d4a574}h2{color:#a78bfa;font-size:14px;margin:20px 0 8px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.card{background:#11131a;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:16px}
.card .n{font-size:32px;font-weight:800;color:#d4a574}.card .l{font-size:12px;color:#8a8e9a;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#11131a;border-radius:12px;overflow:hidden}
th{text-align:left;color:#8a8e9a;font-size:11px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.07)}
td{padding:8px 12px;color:#e4e4e7;border-bottom:1px solid rgba(0,0,0,.2)}
.sec{margin-bottom:20px}</style></head><body>
<h1>AIBTI · 后台看板</h1>
<div class="cards">
  <div class="card"><div class="n">${stats.total}</div><div class="l">总测评人次</div></div>
  <div class="card"><div class="n">${stats.ogPct}</div><div class="l">老虾农占比</div></div>
  <div class="card"><div class="n">${Object.keys(stats.byLevel).length}</div><div class="l">覆盖等级数</div></div>
</div>
<div class="sec"><h2>等级分布</h2>
<table><tr><th>等级</th><th>人数</th><th>占比</th></tr>${byLvRows}</table></div>
<div class="sec"><h2>人格分布 Top10</h2>
<table><tr><th>人格</th><th>人数</th><th>占比</th></tr>${byPersonaRows}</table></div>
<p style="color:#4d505a;font-size:12px">数据来源：GitHub Issues · busilb/aibti</p>
</body></html>`;
}

/* ── 读请求体 ── */
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

/* ── CORS 头 ── */
function setCORS(resp) {
  resp.setHeader('Access-Control-Allow-Origin', '*');
  resp.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  resp.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonResp(resp, data, status=200) {
  setCORS(resp);
  resp.setStatusCode(status);
  resp.setHeader('Content-Type', 'application/json; charset=utf-8');
  resp.send(JSON.stringify(data));
}

/* ══ FC HTTP 入口 ══ */
module.exports.handler = async function(req, resp, context) {
  const urlPath = (req.path || '/').split('?')[0];

  // 预检
  if (req.method === 'OPTIONS') {
    setCORS(resp); resp.setStatusCode(204); resp.send(''); return;
  }

  // POST /api/submit
  if (req.method === 'POST' && urlPath === '/api/submit') {
    const body = await readBody(req);
    const record = {
      role: String(body.role||'').slice(0,10),
      level: String(body.level||'').slice(0,5),
      personaCode: String(body.personaCode||'').slice(0,20),
      personaName: String(body.personaName||'').slice(0,20),
      scores: body.scores||{}
    };
    const issue = await createIssue(record);
    const total = (await loadStats()).total;
    return jsonResp(resp, { ok: true, total, issue: issue.body?.number });
  }

  // GET /api/stats
  if (req.method === 'GET' && urlPath === '/api/stats') {
    return jsonResp(resp, await loadStats());
  }

  // GET /api/ticker
  if (req.method === 'GET' && urlPath === '/api/ticker') {
    return jsonResp(resp, await getTicker());
  }

  // GET /admin
  if (req.method === 'GET' && urlPath === '/admin') {
    const qs = Object.fromEntries(new URLSearchParams(req.url?.split('?')[1]||''));
    if (qs.password !== ADMIN_PWD) {
      resp.setStatusCode(403); resp.send('无权限'); return;
    }
    const stats = await loadStats();
    resp.setStatusCode(200);
    resp.setHeader('Content-Type', 'text/html; charset=utf-8');
    resp.send(await adminHTML(stats)); return;
  }

  jsonResp(resp, { error: 'Not Found' }, 404);
};
