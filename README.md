# NSRadar — NodeSeek RSS 监控机器人

监控 NodeSeek 论坛 RSS 订阅，通过关键词筛选后推送到 Telegram。支持多用户、正则匹配、排除词、暂停/恢复等管理功能。

## ✨ 特性

- **多源监控**：支持同时订阅多个 RSS 源（NodeSeek 默认已配）
- **灵活匹配**：普通关键词、正则表达式、排除词三种模式
- **板块选择**：每个关键词可独立选择监控板块（交互式多选/全选）
- **命中统计**：`/list` 显示每个关键词的累计命中次数
- **多用户管理**：每个用户独立关键词列表，互不干扰
- **首次防刷屏**：首次运行只记录历史不推送，避免一次性轰炸
- **自动容错**：用户屏蔽机器人时自动暂停推送；抓取失败仅记录不中断
- **零原生依赖**：使用 Node.js 内置 SQLite（`node:sqlite`），无需编译
- **优雅关闭**：支持 SIGINT/SIGTERM 信号，安全退出

## 🛠 技术栈

- **Node.js** ≥ 22.13.0（使用内置 `node:sqlite`）
- **[grammy](https://grammy.dev/)** — Telegram Bot 框架
- **[rss-parser](https://github.com/rbren/rss-parser)** — RSS/Atom 解析
- **SQLite** — 持久化存储（用户、关键词、已见帖子、推送记录）

## 🚀 快速开始

### 1. 安装依赖

```bash
git clone https://github.com/harenaNow/NSRadar.git
cd NSRadar
npm install
```

### 2. 配置

复制配置模板并编辑：

```bash
cp .env.example .env
nano .env   # 或 vim / vi / 任意编辑器
```

**必填项**：

```env
# Telegram Bot Token（向 @BotFather 申请）
BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11

# 管理员 Telegram 用户 ID（向 @userinfobot 获取，可多个逗号分隔）
ADMIN_IDS=123456789
```

**可选项**（默认值已配置，按需修改）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ALLOW_PUBLIC` | `false` | 是否允许非管理员使用（`true` 开放注册） |
| `RSS_FEEDS` | `https://www.nodeseek.com/rss.xml` | RSS 源（多个逗号分隔） |
| `CHECK_INTERVAL_SEC` | `60` | 检查间隔（秒，最小 15） |
| `DB_PATH` | `./data/nsradar.db` | SQLite 数据库路径 |
| `USER_AGENT` | 浏览器 UA | 抓取 RSS 时的 User-Agent |
| `RSS_COOKIE` | 空 | NodeSeek Cookie（反爬/需登录内容时填） |
| `MAX_AGE_HOURS` | `0` | 仅推送最近 N 小时内的帖子（0 不限制） |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |

### 3. 运行

```bash
# 自检模式：抓取 RSS 并模拟匹配，不启动 Bot（验证配置）
npm run check

# 启动机器人（长期运行）
npm start

# 开发模式（--watch 热重载）
npm run dev
```

## 📱 Bot 命令

### 通用命令

| 命令 | 说明 |
|---|---|
| `/start` `/help` | 查看帮助 |
| `/add <关键词>` | 添加关键词（后选板块） |
| `/del <关键词>` | 删除关键词 |
| `/list` | 查看关键词（含板块与命中次数） |
| `/boards` | 查看全部可用板块 |
| `/pause` | 暂停推送 |
| `/resume` | 恢复推送 |
| `/status` | 查看运行状态 |
| `/test` | 发送测试消息 |

### 管理员命令

| 命令 | 说明 |
|---|---|
| `/check` | 立即触发一次 RSS 检查 |
| `/users` | 查看用户列表 |
| `/stats` | 查看统计信息 |
| `/broadcast <消息>` | 向所有用户广播消息 |

## 🔑 关键词语法

支持三种匹配模式，可混合使用：

### 普通关键词（子串匹配，不区分大小写）

```
/add VPS
/add 甲骨文
```

### 正则表达式（以 `re:` 开头，不区分大小写）

```
/add re:\d{4}
/add re:vps|服务器
```

### 排除词（以 `-` 开头）

```
/add -广告
/add -re:推广|测试
```

**匹配规则**：
1. 若任一排除词命中 → **不推送**
2. 若有包含词 → 返回命中的包含词列表
3. 若仅有排除词（无包含词）且未被排除 → **全部推送**（排除模式）
4. 否则 → 不推送

**示例**：
- 关键词：`VPS`, `-广告` → 包含 "VPS" 但不含 "广告" 的帖子
- 关键词：`-广告`, `-re:推广` → 除含 "广告" 或 "推广" 外全部推送

## 📋 板块选择

添加关键词后，Bot 会弹出**交互式板块选择菜单**，可多选或全选监控板块。

### 已知板块

| slug | 名称 |
|---|---|
| `daily` | 日常 |
| `tech` | 技术 |
| `info` | 情报 |
| `review` | 测评 |
| `trade` | 交易 |
| `carpool` | 拼车 |
| `dev` | 开发 |
| `photo-share` | 晒图 |
| `expose` | 曝光 |

> 板块列表会从 RSS 自动发现并补充，使用 `/boards` 查看实时列表。

### 板块匹配规则

- 关键词选择「全选」（默认）→ 所有板块的帖子均参与匹配
- 关键词选择特定板块 → 仅该板块的帖子参与匹配
- 排除词同理：仅在选定板块内排除

### 命中次数

`/list` 中每个关键词显示累计命中次数（排除模式显示 `—`不计数）。

```text
📋 你的关键词（3）
1. VPS | 📋 技术/交易 | 🎯 命中 12
2. 甲骨文 | 📋 全部 | 🎯 命中 3
3. -广告 | 📋 全部 | 🎯 命中 —
```

## 🛡 部署建议

### 使用 PM2（推荐）

```bash
# 安装 pm2
npm install -g pm2

# 启动
pm2 start "npm start" --name nsradar

# 查看日志
pm2 logs nsradar

# 开机自启
pm2 save
pm2 startup
```

### 使用 systemd

创建 `/etc/systemd/system/nsradar.service`：

```ini
[Unit]
Description=NSRadar Telegram Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/NSRadar
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable nsradar
systemctl start nsradar
systemctl status nsradar
```

### 使用 Docker（可选）

如需容器化，可自行编写 `Dockerfile`（未提供）。

## ⚠️ 注意事项

- **首次运行**：Bot 启动后 5 秒执行首次检查，仅记录历史帖子不推送，避免刷屏
- **数据库**：SQLite 文件位于 `./data/nsradar.db`（已 `.gitignore`），定期备份
- **敏感信息**：`.env` 包含 Bot Token，**不要提交到 Git**
- **NodeSeek 反爬**：若抓取失败，可配置 `USER_AGENT` 和 `RSS_COOKIE`
- **Telegram 限流**：推送间隔 60ms，广播时自动限速

## 📝 许可证

MIT

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 📧 反馈

如有问题或建议，请提 Issue 或联系作者。
