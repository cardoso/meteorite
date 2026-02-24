let nextId = 1;
const pendingComputations: Computation[] = [];
let willFlush = false;
let isFlushing = false;
let inCompute = false;

const afterFlushCallbacks: (() => void)[] = [];

function requireFlush() {
	if (!willFlush) {
		setTimeout(_runFlush, 0);
		willFlush = true;
	}
}

export let active = false;
export let currentComputation: Computation | null = null;

export function inFlush() {
	return isFlushing;
}

export class Computation {
    stopped = false;
    invalidated = false;
    firstRun = true;
    _recomputing = false;
    _id = nextId++;
    _onInvalidateCallbacks: ((c: Computation) => void)[] = [];
    _onStopCallbacks: ((c: Computation) => void)[] = [];
    _parent: Computation | null;
    _func: (computation: Computation) => void;
    _onError?: ((error: unknown) => void) | undefined;
    firstRunPromise: Promise<unknown> | null = null;

    constructor(f: (computation: Computation) => void, parent: Computation | null, onError?: (error: unknown) => void) {
        this._parent = parent;
        this._func = f;
        this._onError = onError;

        let errored = true;
        try {
            this._compute();
            errored = false;
        } finally {
            this.firstRun = false;
            if (errored) this.stop();
        }
    }

    // ... (then/catch methods remain the same) ...

    onInvalidate(f: (c: Computation) => void) {
        if (typeof f !== 'function') throw new Error('onInvalidate requires a function');

        if (this.invalidated) {
            nonreactive(() => f(this));
        } else {
            this._onInvalidateCallbacks.push(f);
        }
    }

    onStop(f: (c: Computation) => void) {
        if (typeof f !== 'function') throw new Error('onStop requires a function');

        if (this.stopped) {
            nonreactive(() => f(this));
        } else {
            this._onStopCallbacks.push(f);
        }
    }

    invalidate() {
        if (this.invalidated) return;

        this.invalidated = true;

        // If not already recomputing and not stopped, queue it up
        if (!this._recomputing && !this.stopped) {
            requireFlush();
            pendingComputations.push(this);
        }

        // Run invalidation callbacks immediately
        if (this._onInvalidateCallbacks.length > 0) {
            const callbacks = this._onInvalidateCallbacks;
            this._onInvalidateCallbacks = [];
            nonreactive(() => {
                for (const f of callbacks) f(this);
            });
        }
    }

    stop() {
        if (!this.stopped) {
            this.stopped = true;
            this.invalidate(); // This MUST be able to trigger callbacks

            if (this._onStopCallbacks.length > 0) {
                const callbacks = this._onStopCallbacks;
                this._onStopCallbacks = [];
                nonreactive(() => {
                    for (const f of callbacks) f(this);
                });
            }
        }
    }

    _compute() {
        // RESET IS KEY: Clear invalidated flag so invalidate() can be called again
        this.invalidated = false;

        const previousInCompute = inCompute;
        inCompute = true;

        try {
            const firstRunPromise = withComputation(this, () => {
                return this._func(this);
            });

            if (this.firstRun) {
                this.firstRunPromise = Promise.resolve(firstRunPromise);
            }
        } finally {
            inCompute = previousInCompute;
        }
    }

    _needsRecompute() {
        return this.invalidated && !this.stopped;
    }

    _recompute() {
        this._recomputing = true;
        try {
            // Re-check needsRecompute because it might have been stopped 
            // while sitting in the pendingComputations queue
            if (this._needsRecompute()) {
                this._compute();
            }
        } finally {
            this._recomputing = false;
        }
    }

    flush() {
        if (this._recomputing) return;
        this._recompute();
    }

    run() {
        this.invalidate();
        this.flush();
    }
}

export class Dependency {
	_dependents = new Set<Computation>();

	depend(computation?: Computation): boolean {
		if (!computation) {
			if (!active) return false;
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			computation = currentComputation!;
		}

		if (!this._dependents.has(computation)) {
			this._dependents.add(computation);
			computation.onInvalidate(() => {
				this._dependents.delete(computation);
			});
			return true;
		}
		return false;
	}

	changed() {
		if (this._dependents.size === 0) return;
		for (const computation of this._dependents) {
			computation.invalidate();
		}
	}

	hasDependents(): boolean {
		return this._dependents.size > 0;
	}
}

export function flush(options: { _throwFirstError?: boolean } = {}) {
	_runFlush({
		finishSynchronously: true,
		throwFirstError: options._throwFirstError,
	});
}

function _runFlush(options: { finishSynchronously?: boolean; throwFirstError?: boolean } = {}) {
	if (inFlush()) throw new Error("Can't call Tracker.flush while flushing");
	if (inCompute) throw new Error("Can't flush inside Tracker.autorun");

	isFlushing = true;
	willFlush = true;

	let recomputedCount = 0;
	let errorToThrow: any = null;

	try {
		// Use a loop to process until empty, avoiding stack recursion
		while (pendingComputations.length > 0 || afterFlushCallbacks.length > 0) {

			// 1. Process Computations
			while (pendingComputations.length > 0) {
				const comp = pendingComputations.shift()!; // Shift to handle as a queue

				try {
					comp._recompute();
				} catch (e) {
					if (options.throwFirstError) {
						if (!errorToThrow) errorToThrow = e;
					} else if (comp._onError) {
						comp._onError(e);
					} else {
						console.error('Exception from Tracker recompute function:', e);
					}
				}

				// Circuit breaker for async flushes
				if (!options.finishSynchronously && ++recomputedCount > 1000) {
					return; // Exit and let finally block schedule next tick
				}
			}

			// 2. Process afterFlush Callbacks
			if (afterFlushCallbacks.length > 0) {
				const func = afterFlushCallbacks.shift();
				try {
					if (func) func();
				} catch (e) {
					if (options.throwFirstError && !errorToThrow) {
						errorToThrow = e;
					} else {
						console.error('Exception in afterFlush callback', e);
					}
				}
			}
		}
	} finally {
		willFlush = false;
		isFlushing = false;

		// If we exited early (circuit breaker) or new work was added, schedule next run
		if (pendingComputations.length > 0 || afterFlushCallbacks.length > 0) {
			if (options.finishSynchronously) {
				// This prevents a loop that would never finish synchronously
				// eslint-disable-next-line no-unsafe-finally
				throw new Error('Tracker.flush: Still have more to do after synchronous flush');
			}
			requireFlush();
		}

		// 3. Handle throwFirstError
		if (options.throwFirstError && errorToThrow) {
			// eslint-disable-next-line no-unsafe-finally
			throw errorToThrow;
		}
	}
}

export function autorun(f: (computation: Computation) => void, options: { onError?: (error: unknown) => void } = {}): Computation {
	const c = new Computation(f, currentComputation, options.onError);

	if (active)
		onInvalidate(() => {
			c.stop();
		});

	return c;
}

export function nonreactive<T>(f: () => T): T {
	const previousComputation = currentComputation;
	const previousActive = active;

	currentComputation = null;
	active = false;

	try {
		return f();
	} finally {
		currentComputation = previousComputation;
		active = previousActive;
	}
}

export function withComputation<T>(computation: Computation | null, f: () => T): T {
	const previousComputation = currentComputation;
	const previousActive = active;

	currentComputation = computation;
	active = !!computation;

	try {
		return f();
	} finally {
		currentComputation = previousComputation;
		active = previousActive;
	}
}

export function onInvalidate(f: (c: Computation) => void) {
	if (!active || !currentComputation) throw new Error('Tracker.onInvalidate requires a currentComputation');
	currentComputation.onInvalidate(f);
}

export function afterFlush(f: () => void) {
	afterFlushCallbacks.push(f);
	requireFlush();
}
