import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePref = "system" | "light" | "dark";
const ORDER: ThemePref[] = ["system", "light", "dark"];
const KEY = "theme";

function readPref(): ThemePref {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return ORDER.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

const media = window.matchMedia("(prefers-color-scheme: dark)");

/** The user's choice, and the theme actually in use. */
export const theme = $state({ pref: readPref(), systemDark: media.matches });

export function resolvedTheme(): "light" | "dark" {
  return theme.pref === "system" ? (theme.systemDark ? "dark" : "light") : theme.pref;
}

function apply() {
  document.documentElement.dataset.theme = resolvedTheme();
  // Match the native title bar too (null follows the system).
  if (isTauri()) getCurrentWindow().setTheme(theme.pref === "system" ? null : theme.pref).catch(() => {});
}

export function setTheme(pref: ThemePref) {
  theme.pref = pref;
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    // ignore
  }
  apply();
}

export function cycleTheme() {
  setTheme(ORDER[(ORDER.indexOf(theme.pref) + 1) % ORDER.length]);
}

/** Applies the saved theme and follows system changes. Call before mounting. */
export function initTheme() {
  media.addEventListener("change", (e) => {
    theme.systemDark = e.matches;
    apply();
  });
  apply();
}
