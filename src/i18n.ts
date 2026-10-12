/**
 * Interface language for everything Roundtable says (chat replies, cards, CLI output) and the language
 * it asks models to answer in. Set once at startup from config `locale`; strings are written inline as
 * `L(zh, en)` so each message keeps both versions side by side.
 */
export type Locale = "zh" | "en";

let current: Locale = process.env.ROUNDTABLE_LOCALE === "en" ? "en" : "zh";

/** Also exported to the environment so child processes (watchdog, scripts) speak the same language. */
export function setLocale(locale: Locale): void { current = locale; process.env.ROUNDTABLE_LOCALE = locale; }
export function locale(): Locale { return current; }

/** The string for the active locale. */
export function L(zh: string, en: string): string { return current === "en" ? en : zh; }
