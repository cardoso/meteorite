// Assuming Tracker and EJSON are provided by your modern environment
import { Tracker } from './tracker.ts';
import { EJSON } from './ejson.ts';

const hasOwn = Object.prototype.hasOwnProperty;

function stringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  return EJSON.stringify(value);
}

function parse(serialized: string): any {
  if (serialized === undefined || serialized === 'undefined') {
    return undefined;
  }
  return EJSON.parse(serialized);
}

function changed(dep?: Tracker.Dependency): void {
  if (dep) {
    dep.changed();
  }
}

export class ReactiveDict<O extends Record<string, any> = Record<string, any>> {
  public name?: string;
  private keys: Record<string, string> = {};
  private allDeps: Tracker.Dependency;
  private keyDeps: Record<string, Tracker.Dependency> = {};
  private keyValueDeps: Record<string, Record<string, Tracker.Dependency>> = {};

  constructor(dictNameOrData?: string | Partial<O>, dictData?: Partial<O>) {
    this.allDeps = new Tracker.Dependency();

    // The fix: properly handling falsy first arguments (like undefined)
    if (dictNameOrData) {
      if (typeof dictNameOrData === 'string') {
        this.name = dictNameOrData;
        if (dictData) {
          this._setObject(dictData);
        }
      } else if (typeof dictNameOrData === 'object') {
        this._setObject(dictNameOrData as Partial<O>);
      } else {
        throw new Error(`Invalid ReactiveDict argument: ${String(dictNameOrData)}`);
      }
    } else if (typeof dictData === 'object' && dictData !== null) {
      // If dictNameOrData is undefined, we still need to set the dictData
      this._setObject(dictData);
    }
  }

  set<P extends keyof O>(key: P, value?: O[P]): void;
  set(object: Partial<O>): void;
  set(keyOrObject: keyof O | Partial<O>, value?: any): void {
    if (typeof keyOrObject === 'object' && keyOrObject !== null && value === undefined) {
      this._setObject(keyOrObject as Partial<O>);
      return;
    }

    const key = keyOrObject as string;
    const serializedValue = stringify(value);
    
    const keyExisted = hasOwn.call(this.keys, key);
    const oldSerializedValue = keyExisted ? this.keys[key] : 'undefined';
    const isNewValue = serializedValue !== oldSerializedValue;

    this.keys[key] = serializedValue;

    if (isNewValue || !keyExisted) {
      changed(this.allDeps);
    }

    if (isNewValue && this.keyDeps) {
      changed(this.keyDeps[key]);
      if (this.keyValueDeps[key]) {
        changed(this.keyValueDeps[key][oldSerializedValue]);
        changed(this.keyValueDeps[key][serializedValue]);
      }
    }
  }

  setDefault<P extends keyof O>(key: P, value?: O[P]): void;
  setDefault(object: Partial<O>): void;
  setDefault(keyOrObject: keyof O | Partial<O>, value?: any): void {
    if (typeof keyOrObject === 'object' && keyOrObject !== null && value === undefined) {
      this._setDefaultObject(keyOrObject as Partial<O>);
      return;
    }

    const key = keyOrObject as string;
    if (!hasOwn.call(this.keys, key)) {
      this.set(key, value);
    }
  }

  get<P extends keyof O>(key: P): O[P] | undefined {
    const keyStr = key as string;
    this._ensureKey(keyStr);
    this.keyDeps[keyStr].depend();
    return parse(this.keys[keyStr]);
  }

  equals<P extends keyof O>(
    key: P,
    value: string | number | boolean | undefined | null | Date
  ): boolean {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      typeof value !== 'undefined' &&
      !(value instanceof Date) &&
      value !== null
    ) {
      throw new Error('ReactiveDict.equals: value must be scalar');
    }

    const keyStr = key as string;
    const serializedValue = stringify(value);

    if (Tracker.active) {
      this._ensureKey(keyStr);

      if (!hasOwn.call(this.keyValueDeps[keyStr], serializedValue)) {
        this.keyValueDeps[keyStr][serializedValue] = new Tracker.Dependency();
      }

      const isNew = this.keyValueDeps[keyStr][serializedValue].depend();
      if (isNew) {
        Tracker.onInvalidate(() => {
          if (!this.keyValueDeps[keyStr][serializedValue].hasDependents()) {
            delete this.keyValueDeps[keyStr][serializedValue];
          }
        });
      }
    }

    let oldValue: any = undefined;
    if (hasOwn.call(this.keys, keyStr)) {
      oldValue = parse(this.keys[keyStr]);
    }
    return EJSON.equals(oldValue, value);
  }

  all(): Partial<O> {
    this.allDeps.depend();
    const ret: Partial<O> = {};
    for (const key of Object.keys(this.keys)) {
      ret[key as keyof O] = parse(this.keys[key]);
    }
    return ret;
  }

  clear(): void {
    const oldKeys = this.keys;
    this.keys = {};

    this.allDeps.changed();

    for (const key of Object.keys(oldKeys)) {
      changed(this.keyDeps[key]);
      if (this.keyValueDeps[key]) {
        changed(this.keyValueDeps[key][oldKeys[key]]);
        changed(this.keyValueDeps[key]['undefined']);
      }
    }
  }

  delete<P extends keyof O>(key: P): boolean {
    const keyStr = key as string;
    let didRemove = false;

    if (hasOwn.call(this.keys, keyStr)) {
      const oldValue = this.keys[keyStr];
      delete this.keys[keyStr];
      changed(this.keyDeps[keyStr]);
      
      if (this.keyValueDeps[keyStr]) {
        changed(this.keyValueDeps[keyStr][oldValue]);
        changed(this.keyValueDeps[keyStr]['undefined']);
      }
      
      this.allDeps.changed();
      didRemove = true;
    }
    return didRemove;
  }

  destroy(): void {
    this.clear();
  }

  private _setObject(object: Partial<O>): void {
    for (const key of Object.keys(object)) {
      this.set(key as keyof O, object[key as keyof O]);
    }
  }

  private _setDefaultObject(object: Partial<O>): void {
    for (const key of Object.keys(object)) {
      this.setDefault(key as keyof O, object[key as keyof O]);
    }
  }

  private _ensureKey(key: string): void {
    if (!(key in this.keyDeps)) {
      this.keyDeps[key] = new Tracker.Dependency();
      this.keyValueDeps[key] = {};
    }
  }
}