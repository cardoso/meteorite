import { EJSON } from 'meteor/ejson';
export { Heartbeat } from './heartbeat.ts';
export { MethodInvocation } from './method-invocation.ts';
export { RandomStream, makeRpcSeed } from './random-stream.ts';

export const hasOwn = Object.prototype.hasOwnProperty;
export const slice = Array.prototype.slice;

export function keys(obj: any): string[] {
  return Object.keys(Object(obj));
}

export function isEmpty(obj: any): boolean {
  if (obj == null) {
    return true;
  }

  if (Array.isArray(obj) || typeof obj === "string") {
    return obj.length === 0;
  }

  for (const key in obj) {
    if (hasOwn.call(obj, key)) {
      return false;
    }
  }

  return true;
}

export function last<T>(array: T[], n?: number, guard?: boolean): T | T[] | undefined {
  if (array == null) {
    return undefined;
  }

  if (n == null || guard) {
    return array[array.length - 1];
  }

  return slice.call(array, Math.max(array.length - n, 0)) as T[];
}

export const SUPPORTED_DDP_VERSIONS = ['1', 'pre2', 'pre1'];

export function parseDDP(stringMessage: string): any {
  let msg: any;
  try {
    msg = JSON.parse(stringMessage);
  } catch (e) {
    console.error("Discarding message with invalid JSON", stringMessage);
    return null;
  }

  // DDP messages must be objects.
  if (msg === null || typeof msg !== 'object') {
    console.error("Discarding non-object DDP message", stringMessage);
    return null;
  }

  // switch between "cleared" rep of unsetting fields and "undefined" rep of same
  if (hasOwn.call(msg, 'cleared')) {
    if (!hasOwn.call(msg, 'fields')) {
      msg.fields = {};
    }
    msg.cleared.forEach((clearKey: string) => {
      msg.fields[clearKey] = undefined;
    });
    delete msg.cleared;
  }

  ['fields', 'params', 'result'].forEach(field => {
    if (hasOwn.call(msg, field)) {
      msg[field] = (EJSON as any)._adjustTypesFromJSONValue(msg[field]);
    }
  });

  return msg;
}

export function stringifyDDP(msg: any): string {
  const copy = EJSON.clone(msg);

  // swizzle 'changed' messages from 'fields undefined' rep to 'fields and cleared' rep
  if (hasOwn.call(msg, 'fields')) {
    const cleared: string[] = [];

    Object.keys(msg.fields).forEach(key => {
      const value = msg.fields[key];

      if (typeof value === "undefined") {
        cleared.push(key);
        delete copy.fields[key];
      }
    });

    if (!isEmpty(cleared)) {
      copy.cleared = cleared;
    }

    if (isEmpty(copy.fields)) {
      delete copy.fields;
    }
  }

  // adjust types to basic
  ['fields', 'params', 'result'].forEach(field => {
    if (hasOwn.call(copy, field)) {
      copy[field] = (EJSON as any)._adjustTypesToJSONValue(copy[field]);
    }
  });

  if (msg.id && typeof msg.id !== 'string') {
    throw new Error("Message id is not a string");
  }

  return JSON.stringify(copy);
}