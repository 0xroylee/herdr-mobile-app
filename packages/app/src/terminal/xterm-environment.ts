// @xterm/headless calls navigator.userAgent.includes(...) and navigator.platform.indexOf(...) during module evaluation.
export function ensureXtermEnvironment(scope: object = globalThis): void {
  const currentNavigator = Reflect.get(scope, "navigator");
  const navigator =
    currentNavigator !== null &&
    (typeof currentNavigator === "object" || typeof currentNavigator === "function")
      ? currentNavigator
      : {};

  if (navigator !== currentNavigator) Reflect.set(scope, "navigator", navigator);
  if (typeof Reflect.get(navigator, "userAgent") !== "string") {
    Reflect.set(navigator, "userAgent", "ReactNative");
  }
  if (typeof Reflect.get(navigator, "platform") !== "string") {
    Reflect.set(navigator, "platform", "");
  }
}

ensureXtermEnvironment();
