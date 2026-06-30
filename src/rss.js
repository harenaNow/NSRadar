import RSSParser from "rss-parser";
import { log } from "./logger.js";

const parser = new RSSParser({
  timeout: 15000,
  customFields: {
    item: ["creator", "categories", "content"],
  },
});

/** 去除 HTML 标签并折叠空白，用于匹配与摘要展示。 */
export function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function normalizeItem(item) {
  const guid = String(item.guid || item.id || item.link || item.title || "").trim();
  const title = stripHtml(item.title || "");
  const link = String(item.link || "").trim();
  const contentRaw = item.contentSnippet || item.summary || item.content || "";
  const content = stripHtml(contentRaw);
  const categories = Array.isArray(item.categories)
    ? item.categories.map((c) => (typeof c === "string" ? c : c?.term || "")).filter(Boolean)
    : [];
  const author = item.creator || item.author || "";
  const pubDate = item.pubDate || item.isoDate || "";
  const pubTs = parseDate(pubDate);
  return {
    guid: guid || link || title,
    title,
    link,
    content,
    snippet: truncate(content, 280),
    categories,
    author,
    pubDate,
    pubTs,
  };
}

function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 抓取单个 RSS 源，返回归一化后的 items 数组。
 */
export async function fetchFeed(url, { userAgent, cookie }) {
  const headers = {
    "User-Agent": userAgent,
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  if (!xml || xml.length < 32) {
    throw new Error("空响应或非 RSS 内容");
  }
  const feed = await parser.parseString(xml);
  const items = (feed.items || []).map(normalizeItem).filter((i) => i.guid);
  log.debug(`fetched ${items.length} items from ${url}`);
  return items;
}

/**
 * 并发抓取多个源，汇总并按发布时间倒序排序。失败的源仅记录警告不中断。
 */
export async function fetchAllFeeds(feeds, opts) {
  const results = await Promise.allSettled(feeds.map((u) => fetchFeed(u, opts)));
  const all = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      all.push(...r.value);
    } else {
      log.warn(`抓取失败 ${feeds[i]}: ${r.reason?.message || r.reason}`);
    }
  }
  // 去重（按 guid）
  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    if (!seen.has(it.guid)) {
      seen.add(it.guid);
      deduped.push(it);
    }
  }
  // 按时间倒序；无时间的排到最后
  deduped.sort((a, b) => (b.pubTs || 0) - (a.pubTs || 0));
  return deduped;
}

/** 供匹配使用的全文文本（标题 + 摘要 + 分类）。 */
export function itemMatchText(item) {
  return [item.title, item.content, (item.categories || []).join(" "), item.author]
    .filter(Boolean)
    .join(" ");
}
