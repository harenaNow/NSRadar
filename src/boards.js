/**
 * NodeSeek 板块定义。
 *
 * 板块 slug 来自 RSS channel 的 <category> 标签（自动发现）。
 * 此处硬编码已知 slug 的中文标签，未知的用 slug 本身显示。
 */

// 已知板块 slug → 中文标签（从 RSS channel header 发现）
const KNOWN_LABELS = {
  daily: "日常",
  tech: "技术",
  info: "情报",
  review: "测评",
  trade: "交易",
  carpool: "拼车",
  dev: "开发",
  "photo-share": "晒图",
  expose: "曝光",
};

// 运行时从 RSS 发现的板块（自动补充）
let discovered = [];

export function setDiscoveredBoards(slugs) {
  discovered = (slugs || []).filter((s) => typeof s === "string" && s);
}

/** 返回所有板块 [{slug, label}]，按已知顺序优先，发现的补充在后。 */
export function getBoards() {
  const knownSlugs = Object.keys(KNOWN_LABELS);
  const all = [...new Set([...knownSlugs, ...discovered])];
  return all.map((slug) => ({ slug, label: KNOWN_LABELS[slug] || slug }));
}

export function boardLabel(slug) {
  return KNOWN_LABELS[slug] || slug;
}

/** 解析配置中的额外板块标签：格式 "slug:标签,slug2:标签2" */
export function parseBoardLabels(raw) {
  if (!raw) return {};
  const map = {};
  for (const pair of raw.split(",")) {
    const [slug, label] = pair.split(":").map((s) => s.trim());
    if (slug) map[slug] = label || slug;
  }
  return map;
}

/** 将 boards 字符串解析为 Set；"*" 或空表示全部。 */
export function parseBoardsStr(str) {
  if (!str || str === "*") return null; // null = 全部
  return new Set(str.split(",").filter(Boolean));
}

/** 判断板块是否在 boards 集合内（null = 全部通过）。 */
export function boardMatches(slug, boardsSet) {
  if (boardsSet === null) return true;
  return boardsSet.has(slug);
}

/** 将 Set 序列化为存储字符串。 */
export function boardsToStr(boardsSet) {
  if (boardsSet === null) return "*";
  return [...boardsSet].join(",");
}
