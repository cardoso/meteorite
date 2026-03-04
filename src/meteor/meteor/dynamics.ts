import { _debug } from './debug';

let nextSlot = 0;
let currentValues: any[] = [];
let callAsyncMethodRunning = false;

export type Func<TArgs extends unknown[] = any[], TResult = any> = (...args: TArgs) => TResult;

export class EnvironmentVariable<T = any> {
  private slot: number;

  constructor() {
    this.slot = nextSlot++;
  }

  get(): T | undefined {
    return currentValues[this.slot];
  }

  getOrNullIfOutsideFiber(): T | undefined {
    return this.get();
  }

  withValue<R>(value: T, func: () => R): R {
    const saved = currentValues[this.slot];
    try {
      currentValues[this.slot] = value;
      return func();
    } finally {
      currentValues[this.slot] = saved;
    }
  }

  _set(context: T) {
    currentValues[this.slot] = context;
  };

  _isCallAsyncMethodRunning(): boolean {
    return callAsyncMethodRunning;
  }

  _setCallAsyncMethodRunning(value: boolean) {
    callAsyncMethodRunning = value;
  }

  _setNewContextAndGetCurrent(value: T) {
    var saved = currentValues[this.slot];
    this._set(value);
    return saved;
  }
}

export function bindEnvironment<T extends Func>(
  func: T,
  _onException?: ((err: any) => void) | string,
  _this?: any
): T {
  const boundValues = currentValues.slice();
  let onException: ((err: any) => void) | undefined;
  if (typeof _onException === 'function') {
    onException = _onException;
  } else if (typeof _onException === 'string') {
    onException = (err) => {
      _debug(_onException, err);
    };
  }

  return function (this: any, ...args: Parameters<T>): ReturnType<T> | undefined {
    const savedValues = currentValues;
    try {
      currentValues = boundValues;
      return func.apply(_this || this, args);
    } catch (e) {
      if (onException) {
        onException(e);
      } else {
        _debug("Exception in callback of async function", e);
      }
      return undefined;
    } finally {
      currentValues = savedValues;
    }
  } as T;
}