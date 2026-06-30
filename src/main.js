import process from "node:process";
import { loadEnv, buildConfig, validateConfig } from "./config.js";
import { log } from "./logger.js";
import { Store } from "./store.js";
import { fetchAllFeeds, itemMatchText } from "./rss.js";
import { compileKeywords, matchText } from "./matcher.js";
import { setDiscoveredBoards } from "./boards.js";
import { createRuntime } from "./bot.js";

/** 一次性自检模式：抓取 RSS 并模拟匹配，不启动 Bot、不发送消息。 */
async function runOnce(config, store) {
  log.info("== 一次性自检模式 (--once) ==");
  log.info(`RSS 源：${config.feeds.join(", ")}`);
  const { items, boards } = await fetchAllFeeds(config.feeds, {
    userAgent: config.userAgent,
    cookie: config.cookie,
  });
  if (boards.length) {
    setDiscoveredBoards(boards);
    log.info(`发现板块（${boards.length}）：${boards.join(", ")}`);
  }
  log.info(`抓取到 ${items.length} 条帖子，最新 ${Math.min(10, items.length)} 条：`);
  for (const it of items.slice(0, 10)) {
    log.info(`  • ${it.title || "(无标题)"} | ${it.link}`);
  }

  const users = store.getActiveUsersWithKeywords();
  if (!users.length) {
    log.info("无活跃用户/关键词，跳过匹配模拟。");
    return;
  }
  let matched = 0;
  for (const u of users) {
    const compiled = compileKeywords(u.keywords);
    for (const it of items) {
      const hits = matchText(itemMatchText(it), it.board, compiled);
      if (hits) {
        matched++;
        log.info(`[匹配] 用户 ${u.user_id} <- "${it.title}" 命中 ${hits.join(",")}`);
      }
    }
  }
  log.info(`模拟匹配完成：共 ${matched} 条命中（未发送）。`);
}

async function main() {
  loadEnv();
  const config = buildConfig();
  let store;
  try {
    store = new Store(config.dbPath);
  } catch (e) {
    log.error(`无法初始化数据库: ${e.message}`);
    process.exit(1);
  }

  // --once：仅需 RSS 源，不校验 Bot Token
  if (config.once) {
    if (!config.feeds.length) {
      log.error("缺少 RSS_FEEDS");
      store.close();
      process.exit(1);
    }
    try {
      await runOnce(config, store);
    } catch (e) {
      log.error(`自检失败: ${e.message}`);
      store.close();
      process.exit(1);
    }
    // 不强制 process.exit：让事件循环自然退出，避免 node:sqlite 异步句柄拆除竞速
    store.close();
    return;
  }

  const errors = validateConfig(config);
  if (errors.length) {
    for (const e of errors) log.error(e);
    log.error("配置校验未通过。请复制 .env.example 为 .env 并填写必要项。");
    store.close();
    process.exit(1);
  }

  const rt = createRuntime(config, store);

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${sig}，正在关闭…`);
    try {
      await rt.stop();
    } catch {
      /* ignore */
    }
    store.close();
    // 让事件循环自然退出，避免 node:sqlite 异步句柄拆除竞速；
    // unref 计时器作为兜底，防止意外挂起。
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("NSRadar 启动中…");
  try {
    await rt.start();
  } catch (e) {
    log.error(`Bot 启动失败: ${e.message}`);
    store.close();
    process.exit(1);
  }
}

main().catch((e) => {
  log.error(`致命错误: ${e.message}`);
  console.error(e);
  process.exit(1);
});
