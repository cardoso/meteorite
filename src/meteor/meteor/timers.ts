import { Meteor } from 'meteor/meteor';

export function setTimeout(func: Function, delay: number): number {
  return globalThis.setTimeout(func as TimerHandler, delay);
}

export function setInterval(func: Function, delay: number): number {
  return globalThis.setInterval(func as TimerHandler, delay);
}

export function clearTimeout(id: number): void {
  globalThis.clearTimeout(id);
}

export function clearInterval(id: number): void {
  globalThis.clearInterval(id);
}

/**
 * Defer execution of a function to run asynchronously in the background.
 * Replaces Meteor._setImmediate polyfill with modern queueMicrotask.
 */
export function defer(func: Function): void {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(func as () => void);
  } else {
    // Fallback if queueMicrotask is somehow unavailable
    globalThis.setTimeout(func as TimerHandler, 0);
  }
}

/**
 * Defer execution based on environment.
 */
export function deferrable<T extends Function>(
  func: T,
  options: { on: Array<"development" | "production" | "test"> }
): T | void {
  const on = options?.on || [];
  const env = Meteor.isDevelopment ? "development" : Meteor.isProduction ? "production" : "test";

  if (on.includes(env)) {
    defer(func);
    return;
  }

  // If not in the specified env, run synchronously to maintain legacy behavior
  return func() as unknown as T;
}

export function deferDev<T extends Function>(func: T): T | void {
  return deferrable(func, { on: ["development", "test"] });
}

export function deferProd<T extends Function>(func: T): T | void {
  return deferrable(func, { on: ["production"] });
}