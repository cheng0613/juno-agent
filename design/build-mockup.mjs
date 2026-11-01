/**
 * 生成「Cindy 风格」的界面预览（自包含单文件 HTML）。
 *
 * 用途：改代码前先看效果，省得来回试。
 * tokens 直接从 apps/desktop/src/styles/tokens.css 读，保证预览和真实界面同源。
 */
import fs from 'node:fs';

const tokens = fs.readFileSync('apps/desktop/src/styles/tokens.css', 'utf8');
const start = tokens.indexOf(':root {');
const end = tokens.indexOf('}', start);
const lightVars = tokens.slice(start + 7, end);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Juno · Cindy 风格预览</title>
<style>
:root {
${lightVars}
  --sidebar-w: 268px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--surface);
  display: flex;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

/* ---------- 侧栏 ---------- */
.sidebar {
  width: var(--sidebar-w);
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  padding: 0 8px 8px;
}
/* 顶部工具行：46px，与 Cindy 一致（它注释里写明红绿灯心 y=23 同轴） */
.chrome {
  height: 46px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 6px;
  flex: 0 0 auto;
}
.icon-btn {
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  border: 0; background: transparent; border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}
.icon-btn:hover { background: var(--surface-hover); }

/* 导航行：Cindy 的核心视觉——整行深色胶囊表示选中 */
.nav { display: flex; flex-direction: column; gap: 1px; }
.nav-row {
  height: 34px;
  display: flex; align-items: center; gap: 10px;
  padding: 0 10px;
  border-radius: 8px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
}
.nav-row:hover { background: var(--surface-hover); }
.nav-row.active {
  background: var(--accent-cta-bg);
  color: var(--text-primary-inv);
}
.nav-row .count {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-tertiary);
}
.nav-row.active .count { color: rgb(255 255 255 / 0.6); }
.nav-row svg { flex: 0 0 auto; opacity: .8; }

/* 会话区 */
.section {
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 0 10px 6px;
  display: flex; align-items: center; justify-content: space-between;
}
.sessions { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 1px; }
.session {
  height: 32px; display: flex; align-items: center; gap: 8px;
  padding: 0 10px; border-radius: 8px; cursor: pointer;
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.session:hover { background: var(--surface-hover); }
.session.active { background: var(--surface-chip); color: var(--text-primary); font-weight: 500; }
.session .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--switch-track-on); flex: 0 0 auto; }

/* 底部用户卡：Cindy 是圆角卡片，不是一行文字 */
.usercard {
  margin-top: 8px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 8px 10px;
  display: flex; align-items: center; gap: 9px;
  cursor: pointer;
  background: var(--surface-elevated-soft);
}
.usercard:hover { background: var(--surface-hover-soft); }
.avatar {
  width: 26px; height: 26px; border-radius: 7px;
  background: var(--accent-cta-bg); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; flex: 0 0 auto;
}
.usercard .name { font-size: 13px; font-weight: 500; line-height: 1.25; }
.usercard .sub { font-size: 11px; color: var(--text-tertiary); line-height: 1.3; }

/* ---------- 主区 ---------- */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--surface); }
.content-head {
  height: 46px; display: flex; align-items: center;
  padding: 0 16px; font-size: 13px; color: var(--text-secondary);
  flex: 0 0 auto;
}
.scroll { flex: 1; overflow: auto; padding: 0 24px; }
/* 内容居中 + 最大宽度：Cindy 的留白节奏 */
.inner { max-width: 720px; margin: 0 auto; padding: 48px 0 24px; }

.hero { text-align: center; margin-bottom: 34px; }
.hero h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 10px; }
.hero p { font-size: 14px; color: var(--text-secondary); }

/* 卡片：白底、圆角、几乎无边框 */
.card {
  background: var(--surface-elevated);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 10px;
  display: flex; align-items: flex-start; gap: 12px;
}
.card .ico {
  width: 30px; height: 30px; border-radius: 8px;
  background: var(--surface-chip);
  display: flex; align-items: center; justify-content: center;
  flex: 0 0 auto; color: var(--text-secondary);
}
.card .t { font-size: 14px; font-weight: 500; }
.card .d { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }

/* 输入区 */
.composer-wrap { flex: 0 0 auto; padding: 0 24px 16px; }
.composer {
  max-width: 720px; margin: 0 auto;
  background: var(--surface-elevated);
  border: 1px solid var(--border-default);
  border-radius: 14px;
  padding: 12px 14px 10px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.03);
}
.composer .ph { color: var(--text-tertiary); font-size: 14px; margin-bottom: 12px; }
.composer .bar { display: flex; align-items: center; gap: 14px; font-size: 12.5px; color: var(--text-secondary); }
.composer .bar span:hover { color: var(--text-primary); cursor: pointer; }
.composer .send {
  margin-left: auto; width: 27px; height: 27px; border-radius: 50%;
  background: var(--accent-cta-bg); color: #fff; border: 0;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}

/* ---------- 右侧协同面板 ---------- */
.orca {
  width: 330px; flex: 0 0 auto;
  border-left: 1px solid var(--border-default);
  display: flex; flex-direction: column;
  background: var(--surface-elevated-soft);
}
.orca-head {
  height: 46px; display: flex; align-items: center;
  padding: 0 12px; gap: 8px; flex: 0 0 auto;
}
.orca-head .title { font-size: 13px; font-weight: 600; }
.orca-head .n {
  font-size: 11px; background: var(--surface-chip); border-radius: 99px;
  padding: 1px 6px; color: var(--text-secondary);
}
.orca-head .btn {
  margin-left: auto; font-size: 12px; padding: 3px 9px; border-radius: 6px;
  background: var(--surface-chip); border: 0; cursor: pointer; color: var(--text-primary);
}
.pills { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 12px 10px; flex: 0 0 auto; }
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; padding: 3px 9px; border-radius: 99px;
  background: var(--surface-chip); color: var(--text-secondary); cursor: pointer;
}
.pill.active { background: var(--accent-cta-bg); color: #fff; }
.pill .d { width: 5px; height: 5px; border-radius: 50%; background: #2e8b57; }
.pill.done .d { background: var(--text-tertiary); }

.orca-meta {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; font-size: 11.5px; color: var(--text-secondary);
  border-top: 1px solid var(--border-default);
  border-bottom: 1px solid var(--border-default);
}
.tag {
  font-size: 11px; padding: 1px 7px; border-radius: 5px;
  background: color-mix(in srgb, #2e7d4f 12%, transparent); color: #2e7d4f;
}
.orca-body { flex: 1; overflow: auto; padding: 14px 12px; }
.msg-user {
  margin-left: auto; max-width: 85%;
  background: var(--accent-cta-bg); color: #fff;
  padding: 8px 12px; border-radius: 12px 12px 3px 12px;
  font-size: 13px; line-height: 1.5; margin-bottom: 10px; width: fit-content;
}
.msg-ai { font-size: 13px; line-height: 1.6; color: var(--text-primary); }
.orca-input {
  flex: 0 0 auto; margin: 0 12px 12px;
  border: 1px solid var(--border-default); border-radius: 10px;
  padding: 8px 10px; font-size: 12.5px; color: var(--text-tertiary);
  background: var(--surface);
}
</style>
</head>
<body>

<aside class="sidebar">
  <div class="chrome">
    <button class="icon-btn" title="折叠侧栏">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 2.5v11"/>
      </svg>
    </button>
    <button class="icon-btn" title="菜单">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>
      </svg>
    </button>
  </div>

  <nav class="nav">
    <div class="nav-row">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <circle cx="8" cy="8" r="6.2"/><path d="M8 5.2v5.6M5.2 8h5.6"/>
      </svg>
      新建
    </div>
    <div class="nav-row">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/>
      </svg>
      自动化
    </div>
    <div class="nav-row active">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="4" y="4" width="8" height="8" rx="1.6"/><path d="M6 1.6v2.4M10 1.6v2.4M6 12v2.4M10 12v2.4M1.6 6H4M1.6 10H4M12 6h2.4M12 10h2.4"/>
      </svg>
      会话
    </div>
    <div class="nav-row">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="2" y="3.2" width="12" height="9.6" rx="2"/><path d="M2 6.8h12"/>
      </svg>
      伙伴<span class="count">3</span>
    </div>
    <div class="nav-row">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4l3 3"/>
      </svg>
      搜索
    </div>
  </nav>

  <div class="section">最近 <span>···</span></div>
  <div class="sessions">
    <div class="session active"><span class="dot"></span>ORCA 面板调试</div>
    <div class="session">数据库迁移修复</div>
    <div class="session">登录页重构</div>
    <div class="session">图标生成</div>
    <div class="session">Session 冲突排查</div>
    <div class="session">API 层设计评审</div>
    <div class="session">性能基准测试</div>
  </div>

  <div class="usercard">
    <div class="avatar">J</div>
    <div style="min-width:0">
      <div class="name">Juno</div>
      <div class="sub">v0.1.0 · 本地</div>
    </div>
  </div>
</aside>

<main class="main">
  <div class="content-head">ORCA 面板调试</div>
  <div class="scroll">
    <div class="inner">
      <div class="hero">
        <h1>有什么可以帮你？</h1>
        <p>它可以在你的工作目录里读写文件、执行命令。</p>
      </div>

      <div class="card">
        <div class="ico">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M3 8.5l3 3 7-7"/>
          </svg>
        </div>
        <div>
          <div class="t">修复数据库迁移断档</div>
          <div class="d">migrate() 的 current 没在循环内推进，一次应用多条时会误报</div>
        </div>
      </div>

      <div class="card">
        <div class="ico">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5.5 6.5h5M5.5 9.5h3"/>
          </svg>
        </div>
        <div>
          <div class="t">复刻 Cindy 的界面</div>
          <div class="d">参考侧栏导航行、卡片留白与底部用户卡</div>
        </div>
      </div>
    </div>
  </div>

  <div class="composer-wrap">
    <div class="composer">
      <div class="ph">问点什么…（Enter 发送，Shift+Enter 换行）</div>
      <div class="bar">
        <span>每次询问</span><span>计划</span><span>分支</span><span>目录</span><span>导出</span><span>压缩</span>
        <button class="send">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M8 12.5V3.5M4 7l4-3.5L12 7"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</main>

<aside class="orca">
  <div class="orca-head">
    <span class="title">协同</span><span class="n">3</span>
    <button class="btn">+ Worker</button>
  </div>
  <div class="pills">
    <span class="pill"><span class="d"></span>developer</span>
    <span class="pill"><span class="d"></span>developer-2</span>
    <span class="pill active done"><span class="d"></span>developer-3</span>
  </div>
  <div class="orca-meta">
    <span>developer-3</span><span>● 完成</span>
    <span class="tag">独立工作区</span>
    <span style="margin-left:auto">移出</span>
  </div>
  <div class="orca-body">
    <div class="msg-user">数一下 1 加到 100 是多少，直接给数字</div>
    <div class="msg-ai">5050</div>
  </div>
  <div class="orca-input">给 developer-3 派活…（Enter 发送）</div>
</aside>

</body>
</html>`;

fs.writeFileSync('design/juno-cindy-style.html', html);
console.log('已生成 design/juno-cindy-style.html', (html.length / 1024).toFixed(0) + 'KB');
