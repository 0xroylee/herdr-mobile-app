import { Uniwind } from "uniwind";

export type ThemeChoice = "graphite" | "paper" | "system";

export function applyTheme(theme: ThemeChoice): void {
  Uniwind.setTheme(theme === "graphite" ? "dark" : theme === "paper" ? "light" : "system");
}
