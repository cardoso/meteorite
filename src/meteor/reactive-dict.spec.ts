import { describe, it, expect } from 'vitest';
import { ReactiveDict } from './reactive-dict.ts';
import { Tracker } from './tracker.ts';

describe('ReactiveDict', () => {
    it('set to undefined', () => {
        // Explicitly type as <any> to allow arbitrary keys
        const dict = new ReactiveDict<any>();
        dict.set('foo', undefined);
        expect(Object.keys(dict.all())).toEqual(['foo']);

        dict.setDefault('foo', 'bar');
        expect(dict.get('foo')).toBeUndefined();
    });

    it('initialize with data', () => {
        const now = new Date();
        // Type as ReactiveDict<any> so we can reassign it to dicts with different shapes
        let dict: ReactiveDict<any> = new ReactiveDict({
            now: now,
        });

        let nowFromDict = dict.get('now');
        expect(nowFromDict).toEqual(now);

        // Test with static value here as a named dict could
        // be migrated if code reload happens while testing
        dict = new ReactiveDict('foo', {
            foo: 'bar',
        });

        nowFromDict = dict.get('foo');
        expect(nowFromDict).toEqual('bar');

        dict = new ReactiveDict(undefined as any, {
            now: now,
        });

        nowFromDict = dict.get('now');
        expect(nowFromDict).toEqual(now);
    });

    it('setDefault', () => {
        let dict: ReactiveDict<any> = new ReactiveDict();
        dict.set('A', 'blah');
        dict.set('B', undefined);
        dict.setDefault('A', 'default');
        dict.setDefault('B', 'default');
        dict.setDefault('C', 'default');
        dict.setDefault('D', undefined);

        expect(dict.all()).toEqual({
            A: 'blah',
            B: undefined,
            C: 'default',
            D: undefined,
        });

        dict = new ReactiveDict();
        dict.set('A', 'blah');
        dict.set('B', undefined);
        dict.setDefault({
            A: 'default',
            B: 'default',
            C: 'default',
            D: undefined,
        });

        expect(dict.all()).toEqual({
            A: 'blah',
            B: undefined,
            C: 'default',
            D: undefined,
        });
    });

    it('all() works', () => {
        let all: Record<string, any> = {};
        const dict = new ReactiveDict<any>();

        Tracker.autorun(() => {
            all = dict.all();
        });

        expect(all).toEqual({});

        dict.set('foo', 'bar');
        Tracker.flush();
        expect(all).toEqual({ foo: 'bar' });

        dict.set('blah', undefined);
        Tracker.flush();
        expect(all).toEqual({ foo: 'bar', blah: undefined });
    });

    it('clear() works', () => {
        const dict = new ReactiveDict<any>();
        dict.set('foo', 'bar');

        dict.clear();
        dict.set('foo', 'bar');

        let val: any;
        let equals: boolean | undefined;
        let equalsUndefined: boolean | undefined;
        let all: Record<string, any> = {};

        Tracker.autorun(() => {
            val = dict.get('foo');
        });
        Tracker.autorun(() => {
            equals = dict.equals('foo', 'bar');
        });
        Tracker.autorun(() => {
            equalsUndefined = dict.equals('foo', undefined);
        });
        Tracker.autorun(() => {
            all = dict.all();
        });

        expect(val).toEqual('bar');
        expect(equals).toBe(true);
        expect(equalsUndefined).toBe(false);
        expect(all).toEqual({ foo: 'bar' });

        dict.clear();
        Tracker.flush();

        expect(val).toBeUndefined();
        expect(equals).toBe(false);
        expect(equalsUndefined).toBe(true);
        expect(all).toEqual({});
    });

    it('delete(key) works', () => {
        const dict = new ReactiveDict<any>();
        dict.set('foo', 'bar');
        dict.set('bar', 'foo');
        dict.set('baz', 123);

        expect(dict.delete('baz')).toBe(true);
        expect(dict.delete('baz')).toBe(false);

        let val: any;
        let equals: boolean | undefined;
        let equalsUndefined: boolean | undefined;
        let all: Record<string, any> = {};

        Tracker.autorun(() => {
            val = dict.get('foo');
        });
        Tracker.autorun(() => {
            equals = dict.equals('foo', 'bar');
        });
        Tracker.autorun(() => {
            equalsUndefined = dict.equals('foo', undefined);
        });
        Tracker.autorun(() => {
            all = dict.all();
        });

        expect(val).toEqual('bar');
        expect(equals).toBe(true);
        expect(equalsUndefined).toBe(false);
        expect(all).toEqual({ foo: 'bar', bar: 'foo' });

        let didRemove = dict.delete('foo');
        expect(didRemove).toBe(true);

        Tracker.flush();

        expect(val).toBeUndefined();
        expect(equals).toBe(false);
        expect(equalsUndefined).toBe(true);
        expect(all).toEqual({ bar: 'foo' });

        didRemove = dict.delete('barfoobar');
        expect(didRemove).toBe(false);
    });

    it('destroy works', () => {
        // Explicitly providing the generic type prevents TS from inferring `O` as `String`
        let dict: ReactiveDict<any> = new ReactiveDict('test');
        dict.set('foo', 'bar');

        let val: any;
        let equals: boolean | undefined;
        let equalsUndefined: boolean | undefined;
        let all: Record<string, any> = {};

        Tracker.autorun(() => {
            val = dict.get('foo');
        });
        Tracker.autorun(() => {
            equals = dict.equals('foo', 'bar');
        });
        Tracker.autorun(() => {
            equalsUndefined = dict.equals('foo', undefined);
        });
        Tracker.autorun(() => {
            all = dict.all();
        });

        expect(val).toEqual('bar');
        expect(equals).toBe(true);
        expect(equalsUndefined).toBe(false);
        expect(all).toEqual({ foo: 'bar' });

        // .destroy() should clear the dict
        dict.destroy();
        Tracker.flush();

        expect(val).toBeUndefined();
        expect(equals).toBe(false);
        expect(equalsUndefined).toBe(true);
        expect(all).toEqual({});

        // Should instantiate fine without duplicates throwing
        dict = new ReactiveDict('test');
        expect(dict).toBeInstanceOf(ReactiveDict);
    });
});