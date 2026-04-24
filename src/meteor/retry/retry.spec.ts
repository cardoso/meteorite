import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Retry } from './retry';

describe('Retry', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('returns minTimeout while count is below minCount', () => {
		const retry = new Retry({ minCount: 3, minTimeout: 25 });

		expect(retry._timeout(0)).toBe(25);
		expect(retry._timeout(2)).toBe(25);
	});

	it('calculates timeout with exponent growth and max cap when fuzz is zero', () => {
		const retry = new Retry({
			baseTimeout: 100,
			exponent: 2,
			maxTimeout: 350,
			minCount: 0,
			fuzz: 0,
		});

		expect(retry._timeout(1)).toBe(200);
		expect(retry._timeout(3)).toBe(350);
	});

	it('applies fuzz range based on random factor', () => {
		const retry = new Retry({
			baseTimeout: 100,
			exponent: 2,
			maxTimeout: 1000,
			minCount: 0,
			fuzz: 0.5,
		});

		vi.spyOn(Math, 'random').mockReturnValue(0);
		expect(retry._timeout(2)).toBe(300);

		vi.spyOn(Math, 'random').mockReturnValue(1);
		expect(retry._timeout(2)).toBe(500);
	});

	it('retryLater schedules callback and returns computed timeout', () => {
		const retry = new Retry({ minCount: 2, minTimeout: 15 });
		const fn = vi.fn();

		const timeout = retry.retryLater(1, fn);

		expect(timeout).toBe(15);
		expect(retry.retryTimer).not.toBeNull();
		vi.advanceTimersByTime(15);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retryLater clears an existing timer before scheduling a new one', () => {
		const retry = new Retry({ minCount: 2, minTimeout: 10 });
		const first = vi.fn();
		const second = vi.fn();

		retry.retryLater(1, first);
		retry.retryLater(1, second);

		vi.advanceTimersByTime(10);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('clear cancels a pending timer and resets retryTimer', () => {
		const retry = new Retry({ minCount: 2, minTimeout: 20 });
		const fn = vi.fn();

		retry.retryLater(1, fn);
		retry.clear();

		expect(retry.retryTimer).toBeNull();
		vi.advanceTimersByTime(20);
		expect(fn).not.toHaveBeenCalled();
	});
});
