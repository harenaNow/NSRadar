import process from "node:process";

/**
 * 加载 .env 文件（Node 22.13+ 内置，文件不存在时静默回退到真实环境变量）。
 */
export function loadEnv() {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件，忽略；依赖真实环境变量
  }
}

function parseNumberList(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

function parseStringList(raw, fallback) {
  if (!raw) return fallback.slice();
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback.slice();
}

function toBool(raw, def = false) {
  if (raw === undefined || raw === "") return def;
  return String(raw).toLowerCase() === "true";
}

function toNumber(raw, def) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export function buildConfig() {
  const adminIds = parseNumberList(process.env.ADMIN_IDS);
  const feeds = parseStringList(
    process.env.RSS_FEEDS,
    ["https://www.nodeseek.com/rss.xml"],
  );

  return {
    botToken: (process.env.BOT_TOKEN || "").trim(),
    adminIds: new Set(adminIds),
    allowPublic: toBool(process.env.ALLOW_PUBLIC, false),
    feeds,
    checkIntervalSec: Math.max(15, toNumber(process.env.CHECK_INTERVAL_SEC, 60)),
    dbPath: (process.env.DB_PATH || "./data/nsradar.db").trim(),
    userAgent:
      process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    cookie: (process.env.RSS_COOKIE || "").trim(),
    maxAgeHours: Math.max(0, toNumber(process.env.MAX_AGE_HOURS, 0)),
    logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
    once: process.argv.includes("--once"),
  };
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.botToken) {
    errors.push("缺少 BOT_TOKEN（请在 .env 中配置 Telegram Bot Token）");
  }
  if (cfg.adminIds.size === 0) {
    errors.push("缺少 ADMIN_IDS（请至少配置一个管理员 Telegram 用户 ID）");
  }
  if (cfg.feeds.length === 0) {
    errors.push("缺少 RSS_FEEDS（请至少配置一个 RSS 源）");
  }
  return errors;
}
