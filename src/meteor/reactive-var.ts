// Assuming Tracker is provided by your modern reactive environment or a local implementation
import * as Tracker from './tracker';

export type EqualsFunction<T> = (oldValue: T, newValue: T) => boolean;

export class ReactiveVar<T> {
  private curValue: T;
  private equalsFunc?: EqualsFunction<T>;
  private dep: Tracker.Dependency;

  constructor(initialValue: T, equalsFunc?: EqualsFunction<T>) {
    // Note: Parameter properties are intentionally avoided to ensure standard erasable TS
    this.curValue = initialValue;
    this.equalsFunc = equalsFunc;
    this.dep = new Tracker.Dependency();
  }

  static _isEqual(oldValue: unknown, newValue: unknown): boolean {
    if (oldValue !== newValue) {
      return false;
    }
    
    return (
      !oldValue ||
      typeof oldValue === 'number' ||
      typeof oldValue === 'boolean' ||
      typeof oldValue === 'string'
    );
  }

  get(): T {
    if (Tracker.active) {
      this.dep.depend();
    }
    return this.curValue;
  }

  set(newValue: T): void {
    const oldValue = this.curValue;
    
    // Fallback to default static equality check if no custom function was provided
    const isEqual = this.equalsFunc || ReactiveVar._isEqual;

    if (isEqual(oldValue, newValue)) {
      return;
    }

    this.curValue = newValue;
    this.dep.changed();
  }

  toString(): string {
    return `ReactiveVar{${String(this.get())}}`;
  }

  _numListeners(): number {
    // Kept primarily for test suite compatibility
    let count = 0;
    for (const _id in (this.dep as any)._dependentsById) {
      count++;
    }
    return count;
  }
}