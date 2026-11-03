# dsh-status-monitor

**DeepSeek API 服务状态实时悬浮窗** —— 一个 DeepSeek Harness (DSH) 插件。

在 DSH 工作区右上角显示一个可拖拽、可收起的小悬浮窗，实时显示 DeepSeek 各服务的运行状态（数据来自 [status.deepseek.com](https://status.deepseek.com/)，每 60 秒自动刷新）。设置 → 「服务状态」里有完整详情页。

![预览](docs/screenshot.png)

## 功能

- **实时悬浮窗**：常驻显示 7 个服务组件的状态（API 服务、对话服务、搜索服务等），绿/黄/橙/红圆点一目了然
- **可拖拽**：按住标题栏拖到任意位置；双击收起成小圆点，再双击展开；位置自动记忆
- **自动刷新**：每 60 秒拉取一次，也可手动点「刷新」；数据过期会标注
- **状态详情页**：设置 → 「服务状态」，含每个组件的状态文字与最近更新时间
- **零依赖**：不引入任何 npm 包，只用 Node 内置模块与宿主提供的服务

## 安装

要求：DeepSeek Harness Desktop `0.2.1-rc.2`（其他 0.2.x 版本未验证，欢迎反馈）。

### 方式一：手动安装（推荐，零网络依赖）

1. 打开仓库页 <https://github.com/fbi178/ds-status-monitor> → 绿色 **Code** → **Download ZIP** → 解压
   （打不开 GitHub 用镜像：<https://ghproxy.net/https://github.com/fbi178/ds-status-monitor/archive/refs/heads/main.zip>）
2. 复制到 DSH 插件目录（**必须是真实目录，不能是快捷方式/链接**）：

   ```powershell
   $target = "$env:USERPROFILE\.dsh\profiles\desktop
ode_modules\dsh-status-monitor"
   Copy-Item -Recurse -Force <解压出的目录> $target
   ```

3. 编辑 `~\.dsh\profiles\desktop\package.json`，加两处：

   ```jsonc
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",      // 原有，保留
           "@deepseek-ai/dsh-web-app",   // 原有，保留
           "dsh-status-monitor"          // ← 新增
         ]
       }
     },
     "dependencies": {
       "dsh-status-monitor": "file:./node_modules/dsh-status-monitor"  // ← 新增
     }
   }
   ```

   > **三个名字必须完全一致**：目录名、`bundles` 条目、`dependencies` 键，都是 `dsh-status-monitor`。不一致时插件被**静默跳过**（无报错、无悬浮窗）。

4. 重启 DeepSeek Harness。

### 方式二：git 拉取（需要 git 在 PATH 且能连 GitHub）

```powershell
git clone https://github.com/fbi178/ds-status-monitor.git "$env:USERPROFILE\.dsh\profiles\desktop
ode_modules\dsh-status-monitor"
```

然后同方式一的第 3、4 步。

### 方式三：DSH 插件命令（不推荐，依赖 pnpm + git + GitHub 直连三样齐全）

```powershell
dsh plugin --profile desktop add https://github.com/fbi178/ds-status-monitor
```

> **这条报 `[ERR_PNPM_GIT_RESOLVE_FAILED]` / `'git' 不是内部或外部命令`？**
> 前者是国内连不上 GitHub（换方式一，或给命令行挂代理）；后者是机器没装 git（装 [Git for Windows](https://git-scm.com/download/win) 或直接用方式一）。插件本体不含任何构建步骤，手动复制即可，无需 pnpm。

## 多 profile 注意

`dsh web`（浏览器 3080 端口那套）用的是 **`web` profile**，与桌面端的 `desktop` profile 是**两套独立的插件目录**。要在两端都用，就把第 1–3 步对 `~/.dsh/profiles/web/` 再做一遍。

### 可选配置

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`（bundle patch 会自动应用，无需手动 insert），想改默认行为时在 profile patch 里覆盖：

```yaml
- id: dsh-status-monitor
  config:
    statusUrl: https://status.deepseek.com/   # 状态页地址
    refreshMs: 60000                           # 刷新间隔（最小 15000）
```

## 卸载

1. 从 profile `package.json` 的 `bundles` 与 `dependencies` 里删掉 `dsh-status-monitor`
2. 删除 `~/.dsh/profiles/desktop/node_modules/dsh-status-monitor` 目录
3. 重启 DSH

## 工作原理

```
Host 半（lib/index.js）
  每 60s GET https://status.deepseek.com/
  → 解析页面内嵌 RSC flight 数据（flashcat status page）
  → 判定每个组件「进行中」的状态窗口（历史事件不算故障）
  → 缓存快照
  → 经 ctx.webServer.register 挂 /status-monitor/api/state

Client 半（lib/client.js）
  设置 → 服务状态（settings.section 槽位）
  悬浮窗（shell.overlay 槽位，AppFrame overlayLayer 渲染）
  → fetch 同源 JSON API（loopback + x-status-monitor 头双重校验）
  → 每 60s 轮询刷新
```

**实时判定逻辑**：页面上的每条状态记录都是带 `start_at_seconds` / `end_at_seconds` 的「状态窗口」。只有**尚未结束**（`end_at == 0` 或结束时间在未来）的窗口才算当前故障；全部窗口已结束即 `operational`。这与官方页面顶部的「All Systems Operational」判定一致。

## 安全

- API 只接受 loopback 请求 + 自定义 `x-status-monitor: 1` 头（CSRF 门）
- 插件只读公开状态页，不接触任何账号凭据，不发任何写请求

## 隐私

不收集任何数据；唯一的网络请求是对 `status.deepseek.com` 的公开页面 GET。

## 许可

MIT
