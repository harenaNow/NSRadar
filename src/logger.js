import process from "node:process";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const levelValue = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 20;

function ts() {
  return new Date().toISOString();
}

function emit(label, level, args) {
  if (LEVELS[level] < levelValue) return;
  const msg = args
    .map((a) =>
      a instanceof Error
        ? `${a.message}\n${a.stack || ""}`
        : typeof a === "object"
          ? safeStringify(a)
          : String(a),
    )
    .join(" ");
  // eslint-disable-next-line no-console
  console.log(`[${ts()}] [${label.toUpperCase()}] ${msg}`);
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

export const log = {
  debug: (...a) => emit("debug", "debug", a),
  info: (...a) => emit("info", "info", a),
  warn: (...a) => emit("warn", "warn", a),
  error: (...a) => emit("error", "error", a),
};
