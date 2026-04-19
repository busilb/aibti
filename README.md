# AIBTI · 你是哪种 AI 打工人

> 阿里内部 AI 能力测评 · 5 个等级 · 15 个人格 · 18 题 · 4 岗位定制

## 快速开始

```bash
# 本地运行后端
node server.js

# 访问前端
open index.html   # 或配置 API_BASE 后联调

# 管理员看板
open http://localhost:3000/admin
## 部署

- **前端**：`index.html` 上传到 1d.alibaba-inc.com 或任意静态托管
- **后端**：`server.js` 部署到内网服务器 / 阿里云 FC

修改 `index.html` 里的 `CONFIG.API_BASE` 指向你的后端地址。

## 接口

| 接口 | 说明 |
|------|------|
| `POST /api/submit` | 提交测评结果 |
| `GET /api/stats` | 汇总统计 |
| `GET /api/ticker` | 实时动态 |
| `GET /admin?password=XXX` | 管理员看板 |
