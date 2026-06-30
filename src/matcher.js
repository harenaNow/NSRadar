/**
 * 关键词匹配器。
 *
 * 关键词语法：
 *  - 普通词：子串匹配（不区分大小写），如 `VPS` / `甲骨文`
 *  - 正则：以 `re:` 开头，如 `re:\d{4}` （不区分大小写）
 *  - 排除词：以 `-` 开头，如 `-广告` 或 `-re:测试`
 *
 * 匹配规则：
 *  1. 若任一「排除词」命中文本 => 不推送（返回 null）
 *  2. 若有「包含词」 => 返回命中的包含词列表
 *  3. 若仅有排除词（无包含词）且未被排除 => 视为「全部命中」（返回 ["*"]）
 *  4. 否则 => 不推送（返回 null）
 */

/** 将单个原始关键词编译为 { type, regex, raw }。 */
function compileOne(raw) {
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
  return { raw, isExclude, isRegex, regex, bodyLower: body.toLowerCase() };
}

export function compileKeywords(keywords) {
  return keywords.map(compileOne).filter((k) => !(k.isRegex && k.regex === null));
}

function tokenMatches(textLower, compiled) {
  if (compiled.isRegex) {
    return compiled.regex ? compiled.regex.test(textLower) : false;
  }
  return textLower.includes(compiled.bodyLower);
}

/**
 * 返回命中的关键词数组；若命中排除词返回 null；仅排除词未排除返回 ["*"]。
 */
export function matchText(text, compiledKeywords) {
  if (!compiledKeywords.length) return null;
  const textLower = (text || "").toLowerCase();

  const includes = compiledKeywords.filter((k) => !k.isExclude);
  const excludes = compiledKeywords.filter((k) => k.isExclude);

  for (const ex of excludes) {
    if (tokenMatches(textLower, ex)) return null; // 被排除
  }

  if (includes.length === 0) {
    // 仅有排除词：未被排除即视为命中全部
    return ["*"];
  }

  const hits = includes.filter((k) => tokenMatches(textLower, k));
  return hits.length ? hits.map((k) => k.raw) : null;
}
