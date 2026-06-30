import { Bot, InlineKeyboard } from "grammy";
import { log } from "./logger.js";
import { fetchAllFeeds, itemMatchText } from "./rss.js";
import { compileKeywords, matchText } from "./matcher.js";
import { getBoards, boardLabel, setDiscoveredBoards } from "./boards.js";

const SLEEP_MS = 60; // 推送间间隔，规避 Telegram 限流
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function arg(ctx) {
  const text = ctx.message?.text || "";
  const sp = text.indexOf(" ");
  return sp === -1 ? "" : text.slice(sp + 1).trim();
}

/** 构建板块选择 inline 键盘 */
function buildBoardKeyboard(kwId, boardsStr, boardList) {
  const selected =
    boardsStr === "*"
      ? new Set(boardList.map((b) => b.slug))
      : new Set(boardsStr.split(",").filter(Boolean));
  const kb = new InlineKeyboard();
  boardList.forEach((b, i) => {
    const mark = selected.has(b.slug) ? "✅" : "⬜";
    kb.add({ text: `${mark} ${b.label}`, callback_data: `bd:${kwId}:${b.slug}` });
    if ((i + 1) % 3 === 0) kb.row();
  });
  kb.row();
  kb.add({ text: "🌐 全选", callback_data: `bd:${kwId}:all` });
  kb.add({ text: "✅ 完成", callback_data: `bd:${kwId}:done` });
  return kb;
}

const HELP_TEXT = `🛰 <b>NSRadar — NodeSeek RSS 监控</b>

<b>关键词语法</b>
• 普通词：子串匹配（不区分大小写），如 <code>VPS</code>
• 正则：以 <code>re:</code> 开头，如 <code>re:\\d{4}</code>
• 排除词：以 <code>-</code> 开头，如 <code>-广告</code> / <code>-re:推广</code>
• 仅设置排除词时：除排除项外全部推送

<b>板块选择</b>
• 添加关键词后会弹出板块选择菜单
• 可多选板块，或点「全选」监控所有板块
• /boards 查看全部可用板块

<b>命令</b>
/add &lt;关键词&gt; — 添加关键词（后选板块）
/del &lt;关键词&gt; — 删除关键词
/list — 查看关键词（含板块与命中次数）
/boards — 查看全部板块
/pause — 暂停推送
/resume — 恢复推送
/status — 运行状态
/test — 发送测试消息
/help — 本帮助

<b>管理员命令</b>
/check — 立即检查一次
/users — 用户列表
/stats — 统计信息
/broadcast &lt;消息&gt; — 全体广播`;

export function createRuntime(config, store) {
  const bot = new Bot(config.botToken);
  let timer = null;
  let running = false;

  bot.catch((err) => {
    log.error(`handler error: ${err.error?.message || err.error}`);
  });

  // ---------- 授权与自动注册 ----------
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const isAdmin = config.adminIds.has(uid);
    if (!isAdmin && !config.allowPublic) {
      await ctx.reply("⛔ 本机器人仅限管理员使用。");
      return;
    }
    store.ensureUser(uid, ctx.from?.username || null, ctx.from?.first_name || null);
    return next();
  });

  const isAdmin = (uid) => config.adminIds.has(uid);
  async function requireAdmin(ctx) {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply("⛔ 该命令仅限管理员。");
      return false;
    }
    return true;
  }

  // ---------- 命令 ----------
  bot.command("start", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.command("add", async (ctx) => {
    const kw = arg(ctx);
    if (!kw) {
      await ctx.reply("用法：/add <关键词>\n示例：/add VPS\n正则：/add re:\\d{4}\n排除：/add -广告");
      return;
    }
    if (kw.length > 200) {
      await ctx.reply("关键词过长（≤200 字符）。");
      return;
    }
    const kwId = store.addKeyword(ctx.from.id, kw);
    const total = store.countKeywords(ctx.from.id);
    if (kwId === null) {
      await ctx.reply(`⚠️ 该关键词已存在（当前共 ${total} 个）`, { parse_mode: "HTML" });
      return;
    }
    // 弹出板块选择菜单（默认全部）
    const kb = buildBoardKeyboard(kwId, "*", getBoards());
    await ctx.reply(
      `✅ 已添加关键词 <code>${escapeHtml(kw)}</code>（共 ${total} 个）\n\n请选择监控板块（默认全部）：`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.command("del", async (ctx) => {
    const kw = arg(ctx);
    if (!kw) {
      await ctx.reply("用法：/del <关键词>");
      return;
    }
    const ok = store.removeKeyword(ctx.from.id, kw);
    const total = store.countKeywords(ctx.from.id);
    await ctx.reply(
      ok ? `🗑 已删除关键词 <code>${escapeHtml(kw)}</code>（剩余 ${total} 个）` : `⚠️ 未找到该关键词（剩余 ${total} 个）`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("list", async (ctx) => {
    const kws = store.listKeywordsWithStats(ctx.from.id);
    if (!kws.length) {
      await ctx.reply("你还没有关键词。使用 /add 添加。");
      return;
    }
    const body = kws
      .map((k, i) => {
        const boards =
          k.boards === "*"
            ? "全部"
            : k.boards.split(",").map(boardLabel).join("/");
        const isExclude = k.keyword.startsWith("-");
        const hits = isExclude ? "—" : `${k.hit_count}`;
        return `${i + 1}. <code>${escapeHtml(k.keyword)}</code> | 📋 ${escapeHtml(boards)} | 🎯 命中 ${hits}`;
      })
      .join("\n");
    await ctx.reply(`📋 <b>你的关键词（${kws.length}）</b>\n${body}`, { parse_mode: "HTML" });
  });

  bot.command("boards", async (ctx) => {
    const boards = getBoards();
    const body = boards
      .map((b, i) => `${i + 1}. <code>${b.slug}</code> → ${escapeHtml(b.label)}`)
      .join("\n");
    await ctx.reply(`🏷 <b>全部板块（${boards.length}）</b>\n${body}`, { parse_mode: "HTML" });
  });

  bot.command("pause", async (ctx) => {
    store.setPaused(ctx.from.id, true);
    await ctx.reply("⏸ 已暂停推送。使用 /resume 恢复。");
  });

  bot.command("resume", async (ctx) => {
    store.setPaused(ctx.from.id, false);
    await ctx.reply("▶️ 已恢复推送。");
  });

  bot.command("status", async (ctx) => {
    const s = store.stats();
    const lastCheck = s.lastCheckAt ? new Date(Number(s.lastCheckAt)).toLocaleString("zh-CN") : "从未";
    const myKw = store.countKeywords(ctx.from.id);
    const paused = store.isPaused(ctx.from.id);
    const lines = [
      "📊 <b>NSRadar 状态</b>",
      "",
      "🟢 监控：运行中",
      `📡 RSS 源：${config.feeds.length} 个`,
      `⏱ 检查间隔：${config.checkIntervalSec} 秒`,
      `🕐 最近检查：${lastCheck}`,
      `🆕 上次新帖：${s.lastNewCount} 条`,
      `📤 累计推送：${s.totalPushed} 条`,
      `👥 用户数：${s.users}`,
      `📦 已记录帖子：${s.seen}`,
      "",
      `👤 你的关键词：${myKw} 个${paused ? "（已暂停）" : ""}`,
      `🌐 公开注册：${config.allowPublic ? "开" : "关"}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("test", async (ctx) => {
    const item = {
      title: "【测试】这是一条 NSRadar 测试消息",
      link: "https://www.nodeseek.com/",
      snippet: "如果你收到这条消息，说明推送通道正常工作。",
      pubDate: new Date().toUTCString(),
      categories: ["测试"],
    };
    await pushToUser(ctx.from.id, item, ["test"]);
    await ctx.reply("✅ 测试消息已发送。");
  });

  bot.command("check", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.reply("🔍 正在检查 RSS…");
    const r = await runCheck("manual");
    const summary = r?.error
      ? `❌ 检查失败：${escapeHtml(r.error)}`
      : `✅ 检查完成：新帖 ${r.newItems ?? 0} 条，推送 ${r.pushed ?? 0} 条${r.backfilled ? `（首次运行已记录 ${r.backfilled} 条历史）` : ""}`;
    await ctx.reply(summary, { parse_mode: "HTML" });
  });

  bot.command("users", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const users = store.listUsers();
    if (!users.length) {
      await ctx.reply("暂无用户。");
      return;
    }
    const lines = users.slice(0, 50).map((u) => {
      const name = u.username ? `@${u.username}` : u.first_name || "-";
      return `${u.user_id}  ${name}${u.paused ? "  ⏸" : ""}`;
    });
    await ctx.reply(`👥 <b>用户（${users.length}）</b>\n<pre>${escapeHtml(lines.join("\n"))}</pre>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("stats", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const s = store.stats();
    const lastCheck = s.lastCheckAt ? new Date(Number(s.lastCheckAt)).toLocaleString("zh-CN") : "从未";
    const lines = [
      "📈 <b>统计</b>",
      `用户：${s.users}`,
      `关键词总数：${s.keywords}`,
      `已记录帖子：${s.seen}`,
      `已推送记录：${s.sent}`,
      `累计推送：${s.totalPushed}`,
      `最近检查：${lastCheck}`,
      `上次新帖：${s.lastNewCount}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("broadcast", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const msg = arg(ctx);
    if (!msg) {
      await ctx.reply("用法：/broadcast <消息内容>");
      return;
    }
    const users = store.listUsers();
    let ok = 0;
    let fail = 0;
    for (const u of users) {
      try {
        await bot.api.sendMessage(Number(u.user_id), `📢 <b>管理员广播</b>\n\n${escapeHtml(msg)}`, {
          parse_mode: "HTML",
        });
        ok++;
      } catch (e) {
        fail++;
        if (e?.error_code === 403) store.setPaused(Number(u.user_id), true);
      }
      await sleep(SLEEP_MS);
    }
    await ctx.reply(`广播完成：成功 ${ok}，失败 ${fail}（共 ${users.length}）`);
  });

  // ---------- 板块选择 callback ----------
  bot.callbackQuery(/^bd:(\d+):(.+)$/, async (ctx) => {
    const kwId = Number(ctx.match[1]);
    const action = ctx.match[2];
    const kw = store.getKeywordById(kwId);
    if (!kw || kw.user_id !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: "无权限" });
      return;
    }
    const boardList = getBoards();

    if (action === "done") {
      const boardsStr = store.getKeywordBoardsById(kwId);
      const display =
        boardsStr === "*"
          ? "全部"
          : boardsStr.split(",").map(boardLabel).join("、");
      await ctx.answerCallbackQuery({ text: "已保存" });
      await ctx.editMessageText(
        `✅ 关键词 <code>${escapeHtml(kw.keyword)}</code>\n📋 板块：${escapeHtml(display)}`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (action === "all") {
      store.setKeywordBoardsById(kwId, "*");
      await ctx.answerCallbackQuery({ text: "已设为全部板块" });
      await ctx.editMessageReplyMarkup({ reply_markup: buildBoardKeyboard(kwId, "*", boardList) });
      return;
    }

    // 切换单个板块
    const allSlugs = boardList.map((b) => b.slug);
    let boardsStr = store.getKeywordBoardsById(kwId);
    let selected;
    if (boardsStr === "*") {
      // 当前全选 → 取消点击的那个
      selected = new Set(allSlugs.filter((s) => s !== action));
    } else {
      selected = new Set(boardsStr.split(",").filter(Boolean));
      if (selected.has(action)) selected.delete(action);
      else selected.add(action);
      if (allSlugs.every((s) => selected.has(s))) {
        store.setKeywordBoardsById(kwId, "*");
        await ctx.answerCallbackQuery({ text: "已全选" });
        await ctx.editMessageReplyMarkup({ reply_markup: buildBoardKeyboard(kwId, "*", boardList) });
        return;
      }
    }
    const newBoards = [...selected].join(",");
    store.setKeywordBoardsById(kwId, newBoards);
    await ctx.answerCallbackQuery({});
    await ctx.editMessageReplyMarkup({ reply_markup: buildBoardKeyboard(kwId, newBoards, boardList) });
  });

  bot.on("message:text", async (ctx) => {
    await ctx.reply("未识别的命令。发送 /help 查看用法。");
  });

  // ---------- 推送 ----------
  function formatPush(item, hits) {
    const kws = hits
      .map((h) => (h === "*" ? "全部（排除模式）" : escapeHtml(h)))
      .join("、");
    const titleHtml = item.link
      ? `<a href="${escapeHtml(item.link)}">${escapeHtml(item.title || "(无标题)")}</a>`
      : escapeHtml(item.title || "(无标题)");
    const lines = [
      "🛰 <b>NSRadar 命中</b>",
      "",
      `🔑 <b>关键词</b>: ${kws}`,
      `📝 <b>标题</b>: ${titleHtml}`,
    ];
    if (item.board) lines.push(`📋 <b>板块</b>: ${escapeHtml(boardLabel(item.board))}`);
    if (item.snippet) lines.push(`📄 <b>摘要</b>: ${escapeHtml(item.snippet)}`);
    if (item.pubDate) lines.push(`🕒 <b>时间</b>: ${escapeHtml(item.pubDate)}`);
    if (item.categories?.length) lines.push(`🏷 <b>标签</b>: ${escapeHtml(item.categories.join(", "))}`);
    return lines.join("\n");
  }

  async function pushToUser(userId, item, hits) {
    const text = formatPush(item, hits);
    try {
      await bot.api.sendMessage(userId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (e) {
      // Telegram API 错误带有 error_code（如 403 用户已屏蔽 / 400 等）
      if (e && typeof e.error_code === "number" && e.error_code === 403) {
        log.warn(`用户 ${userId} 已屏蔽机器人，自动暂停推送`);
        store.setPaused(userId, true);
      } else {
        log.warn(`推送给 ${userId} 失败: ${e?.message || e}`);
      }
      return false;
    }
  }

  // ---------- 检查主流程 ----------
  async function runCheck(reason = "scheduled") {
    if (running) {
      log.warn("上一次检查仍在进行，跳过本次");
      return { skipped: true };
    }
    running = true;
    try {
      const { items, boards } = await fetchAllFeeds(config.feeds, {
        userAgent: config.userAgent,
        cookie: config.cookie,
      });
      if (boards.length) setDiscoveredBoards(boards);

      let filtered = items;
      if (config.maxAgeHours > 0) {
        const cutoff = Date.now() - config.maxAgeHours * 3600 * 1000;
        filtered = items.filter((it) => it.pubTs === 0 || it.pubTs >= cutoff);
      }

      // 首次运行：仅记录历史，不推送，避免一次性刷屏
      if (store.countSeen() === 0) {
        for (const it of filtered) store.markSeen(it.guid, it.title);
        store.setMeta("last_check_at", Date.now());
        store.setMeta("last_new_count", "0");
        log.info(`首次运行：已记录 ${filtered.length} 条历史帖子，暂不推送。`);
        return { backfilled: filtered.length };
      }

      const newItems = filtered.filter((it) => store.isNew(it.guid));
      // 先标记 seen，防止异常中断导致重复处理
      for (const it of newItems) store.markSeen(it.guid, it.title);

      const users = store
        .getActiveUsersWithKeywords()
        .map((u) => ({ ...u, compiled: compileKeywords(u.keywords) }));

      let pushed = 0;
      if (newItems.length && users.length) {
        for (const it of newItems) {
          const text = itemMatchText(it);
          for (const u of users) {
            if (store.isSent(u.user_id, it.guid)) continue;
            const hits = matchText(text, it.board, u.compiled);
            if (!hits) continue;
            // 命中计数（排除模式 "*" 不计数）
            for (const h of hits) {
              if (h !== "*") store.incrementHitCount(u.user_id, h);
            }
            const ok = await pushToUser(u.user_id, it, hits);
            if (ok) {
              store.recordSent(u.user_id, it.guid, hits.join(","));
              pushed++;
            }
            await sleep(SLEEP_MS);
          }
        }
      }

      store.setMeta("last_check_at", Date.now());
      store.setMeta("last_new_count", String(newItems.length));
      store.setMeta("total_pushed", String(Number(store.getMeta("total_pushed", "0")) + pushed));
      store.prune();
      log.info(
        `检查完成 reason=${reason} 总帖=${items.length} 新帖=${newItems.length} 推送=${pushed}`,
      );
      return { newItems: newItems.length, pushed };
    } catch (e) {
      log.error(`runCheck 失败: ${e.message}`);
      store.setMeta("last_check_at", Date.now());
      store.setMeta("last_error", String(e.message).slice(0, 300));
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  // ---------- 启动 / 停止 ----------
  const commands = [
    { command: "start", description: "开始 / 注册" },
    { command: "help", description: "查看帮助" },
    { command: "add", description: "添加关键词" },
    { command: "del", description: "删除关键词" },
    { command: "list", description: "查看我的关键词" },
    { command: "pause", description: "暂停推送" },
    { command: "resume", description: "恢复推送" },
    { command: "status", description: "运行状态" },
    { command: "test", description: "发送测试消息" },
    { command: "check", description: "立即检查(管理员)" },
    { command: "users", description: "用户列表(管理员)" },
    { command: "broadcast", description: "全体广播(管理员)" },
    { command: "stats", description: "统计(管理员)" },
    { command: "boards", description: "查看全部板块" },
  ];

  async function start() {
    await bot.init();
    try {
      await bot.api.setMyCommands(commands, { scope: { type: "all_private_chats" } });
    } catch (e) {
      log.warn(`setMyCommands 失败: ${e.message}`);
    }
    // 启动后稍延迟做首次检查
    setTimeout(() => {
      runCheck("startup").catch((e) => log.error(`startup check failed: ${e.message}`));
    }, 5000);
    timer = setInterval(() => {
      runCheck("scheduled").catch((e) => log.error(`scheduled check failed: ${e.message}`));
    }, config.checkIntervalSec * 1000);
    log.info(`定时检查已启动，间隔 ${config.checkIntervalSec} 秒`);
    await bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: (me) => log.info(`Bot 已上线：@${me.username}`),
    });
  }

  async function stop() {
    if (timer) clearInterval(timer);
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
    log.info("Bot 已停止");
  }

  return { bot, runCheck, start, stop };
}
