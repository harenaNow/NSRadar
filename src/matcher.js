import { parseBoardsStr } from "./boards.js";

/**
 * 关键词匹配器（支持板块过滤）。
 *
 * 关键词语法：
 *  - 普通词：子串匹配（不区分大小写），如 `VPS` / `甲骨文`
 *  - 正则：以 `re:` 开头，如 `re:\d{4}` （不区分大小写）
 *  - 排除词：以 `-` 开头，如 `-广告` 或 `-re:推广`
 *
 * 板块过滤：
 *  - boards = "*" 或空 → 该关键词匹配所有板块
 *  - boards = "daily,tech" → 仅匹配这些板块的帖子
 *
 * 匹配规则：
 *  1. 若任一「排除词」命中（文本+板块均匹配） => 不推送（返回 null）
 *  2. 若有「包含词」 => 返回命中的包含词列表
 *  3. 若仅有排除词（无包含词）且未被排除 => 视为「全部命中」（返回 ["*"]）
 *  4. 否则 => 不推送（返回 null）
 */

function compileOne(kwObj) {
  const raw = kwObj.keyword;
  let isExclude = false;
  let body = raw;
  if (body.startsWith("-")) {
    isExclude = true;
    body = body.slice(1);
  }
  let regex = null;
  let isRegex = false;
  if (body.startsWith("re:")) {
    isRegex = true;
    try {
      regex = new RegExp(body.slice(3), "i");
    } catch {
      regex = null; // 非法正则，忽略
    }
  }
  return {
    raw,
    isExclude,
    isRegex,
    regex,
    bodyLower: body.toLowerCase(),
    boardsSet: parseBoardsStr(kwObj.boards), // null = 全部
  };
}

export function compileKeywords(keywords) {
  // keywords: [{ keyword, boards }]
  return keywords
    .map(compileOne)
    .filter((k) => !(k.isRegex && k.regex === null));
}

function tokenBoardMatches(board, compiled) {
  if (compiled.boardsSet === null) return true; // 全部板块
  return compiled.boardsSet.has(board);
}

function tokenTextMatches(textLower, compiled) {
  if (compiled.isRegex) {
    return compiled.regex ? compiled.regex.test(textLower) : false;
  }
  return textLower.includes(compiled.bodyLower);
}

/**
 * 返回命中的关键词数组；若命中排除词返回 null；仅排除词未排除返回 ["*"]。
 * @param {string} text   帖子全文
 * @param {string} board  帖子所属板块 slug
 * @param {Array}  compiledKeywords  编译后的关键词
 */
export function matchText(text, board, compiledKeywords) {
  if (!compiledKeywords.length) return null;
  const textLower = (text || "").toLowerCase();

  const includes = compiledKeywords.filter((k) => !k.isExclude);
  const excludes = compiledKeywords.filter((k) => k.isExclude);

  // 排除词：文本+板块均命中才排除
  for (const ex of excludes) {
    if (tokenBoardMatches(board, ex) && tokenTextMatches(textLower, ex)) return null;
  }

  if (includes.length === 0) {
    // 仅有排除词：未被排除即视为命中全部
    return ["*"];
  }

  // 包含词：板块+文本均命中
  const hits = includes.filter(
    (k) => tokenBoardMatches(board, k) && tokenTextMatches(textLower, k),
  );
  return hits.length ? hits.map((k) => k.raw) : null;
}
