const DEBUG = (process.env.LOG_LEVEL || "info") === "debug";

export function info(...args) { console.log(...args); }
export function warn(...args) { console.warn(...args); }
export function error(...args) { console.error(...args); }
export function debug(...args) { if (DEBUG) console.log(...args); }
export { DEBUG };
