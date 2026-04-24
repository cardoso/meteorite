import { describe, expect, it } from 'vitest';
import { OrderedDict } from './index';

describe('OrderedDict', () => {
  it('appends values in insertion order and exposes boundary helpers', () => {
    const dict = new OrderedDict<string, number>();

    dict.append('a', 1);
    dict.append('b', 2);
    dict.append('c', 3);

    expect(dict.empty()).toBe(false);
    expect(dict.size()).toBe(3);
    expect(dict.first()).toBe('a');
    expect(dict.firstValue()).toBe(1);
    expect(dict.last()).toBe('c');
    expect(dict.lastValue()).toBe(3);
    expect(dict.prev('a')).toBeNull();
    expect(dict.next('a')).toBe('b');
    expect(dict.prev('c')).toBe('b');
    expect(dict.next('c')).toBeNull();
    expect(dict.indexOf('a')).toBe(0);
    expect(dict.indexOf('b')).toBe(1);
    expect(dict.indexOf('c')).toBe(2);
    expect(dict.indexOf('missing')).toBeNull();
  });

  it('supports putBefore and rejects duplicate or unknown placement targets', () => {
    const dict = new OrderedDict<string, number>();

    dict.append('a', 1);
    dict.append('c', 3);
    dict.putBefore('b', 2, 'c');

    expect(dict.first()).toBe('a');
    expect(dict.next('a')).toBe('b');
    expect(dict.next('b')).toBe('c');

    expect(() => dict.putBefore('b', 22, null)).toThrow(/already present/);
    expect(() => dict.putBefore('x', 99, 'missing')).toThrow(/Could not find item/);
  });

  it('removes entries and updates links, and throws when removing missing keys', () => {
    const dict = new OrderedDict<string, number>();

    dict.append('a', 1);
    dict.append('b', 2);
    dict.append('c', 3);

    const removed = dict.remove('b');

    expect(removed).toBe(2);
    expect(dict.size()).toBe(2);
    expect(dict.next('a')).toBe('c');
    expect(dict.prev('c')).toBe('a');
    expect(dict.has('b')).toBe(false);
    expect(dict.get('b')).toBeUndefined();
    expect(() => dict.remove('b')).toThrow(/not present/);
  });

  it('moveBefore reorders items and validates move arguments', () => {
    const dict = new OrderedDict<string, number>();

    dict.append('a', 1);
    dict.append('b', 2);
    dict.append('c', 3);

    dict.moveBefore('c', 'a');
    expect(dict.first()).toBe('c');
    expect(dict.next('c')).toBe('a');

    dict.moveBefore('c', 'a');
    expect(dict.first()).toBe('c');
    expect(dict.next('c')).toBe('a');

    dict.moveBefore('a', null);
    expect(dict.last()).toBe('a');

    expect(() => dict.moveBefore('missing', null)).toThrow(/Item to move is not present/);
    expect(() => dict.moveBefore('a', 'missing')).toThrow(/Could not find element/);
  });

  it('iterates in order and can stop early via OrderedDict.BREAK', () => {
    const dict = new OrderedDict<string, number>();
    dict.append('a', 1);
    dict.append('b', 2);
    dict.append('c', 3);

    const seen: Array<string> = [];
    dict.forEach((value, key, index) => {
      seen.push(`${index}:${key}=${value}`);
      if (key === 'b') {
        return OrderedDict.BREAK;
      }
      return;
    });

    expect(seen).toEqual(['0:a=1', '1:b=2']);
  });

  it('forEachAsync preserves order and supports early break', async () => {
    const dict = new OrderedDict<string, number>();
    dict.append('a', 1);
    dict.append('b', 2);
    dict.append('c', 3);

    const seen: Array<string> = [];
    await dict.forEachAsync(async (value, key, index) => {
      seen.push(`${index}:${key}=${value}`);
      if (key === 'b') {
        return OrderedDict.BREAK;
      }
      return;
    });

    expect(seen).toEqual(['0:a=1', '1:b=2']);
  });

  it('supports custom key stringification for object keys', () => {
    const dict = new OrderedDict<{ id: string }, string>((key) => key.id);
    const keyA = { id: 'a' };

    dict.append(keyA, 'value-a');

    expect(dict.has({ id: 'a' })).toBe(true);
    expect(dict.get({ id: 'a' })).toBe('value-a');
    expect(dict.first()).toEqual(keyA);
  });
});
