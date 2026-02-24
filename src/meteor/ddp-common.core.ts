// Assuming EJSON and Random are provided by your modern environment
import { EJSON } from './ejson.ts';
import { Random } from './random.ts';

// --- Utilities ---

export const hasOwn = Object.prototype.hasOwnProperty;
export const slice = Array.prototype.slice;

export function keys(obj: any): string[] {
    return Object.keys(Object(obj));
}

export function isEmpty(obj: any): boolean {
    if (obj == null) {
        return true;
    }

    if (Array.isArray(obj) || typeof obj === 'string') {
        return obj.length === 0;
    }

    for (const key in obj) {
        if (hasOwn.call(obj, key)) {
            return false;
        }
    }

    return true;
}

export function last<T>(array: T[] | null | undefined, n?: number, guard?: boolean): T | T[] | undefined {
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
        console.debug("Discarding message with invalid JSON", stringMessage);
        return null;
    }

    // DDP messages must be objects.
    if (msg === null || typeof msg !== 'object') {
        console.debug("Discarding non-object DDP message", stringMessage);
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
            // Accessing internal adjusters from EJSON
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

// --- Heartbeat ---

export type HeartbeatOptions = {
    heartbeatInterval: number;
    heartbeatTimeout: number;
    sendPing: () => void;
    onTimeout: () => void;
};

export class Heartbeat {
    public heartbeatInterval: number;
    public heartbeatTimeout: number;

    private _sendPing: () => void;
    private _onTimeout: () => void;
    private _seenPacket: boolean;
    private _heartbeatIntervalHandle: ReturnType<typeof setInterval> | null;
    private _heartbeatTimeoutHandle: ReturnType<typeof setTimeout> | null;

    constructor(options: HeartbeatOptions) {
        this.heartbeatInterval = options.heartbeatInterval;
        this.heartbeatTimeout = options.heartbeatTimeout;
        this._sendPing = options.sendPing;
        this._onTimeout = options.onTimeout;
        this._seenPacket = false;

        this._heartbeatIntervalHandle = null;
        this._heartbeatTimeoutHandle = null;
    }

    stop(): void {
        this._clearHeartbeatIntervalTimer();
        this._clearHeartbeatTimeoutTimer();
    }

    start(): void {
        this.stop();
        this._startHeartbeatIntervalTimer();
    }

    private _startHeartbeatIntervalTimer(): void {
        this._heartbeatIntervalHandle = setInterval(
            () => this._heartbeatIntervalFired(),
            this.heartbeatInterval
        );
    }

    private _startHeartbeatTimeoutTimer(): void {
        this._heartbeatTimeoutHandle = setTimeout(
            () => this._heartbeatTimeoutFired(),
            this.heartbeatTimeout
        );
    }

    private _clearHeartbeatIntervalTimer(): void {
        if (this._heartbeatIntervalHandle) {
            clearInterval(this._heartbeatIntervalHandle);
            this._heartbeatIntervalHandle = null;
        }
    }

    private _clearHeartbeatTimeoutTimer(): void {
        if (this._heartbeatTimeoutHandle) {
            clearTimeout(this._heartbeatTimeoutHandle);
            this._heartbeatTimeoutHandle = null;
        }
    }

    private _heartbeatIntervalFired(): void {
        if (!this._seenPacket && !this._heartbeatTimeoutHandle) {
            this._sendPing();
            this._startHeartbeatTimeoutTimer();
        }
        this._seenPacket = false;
    }

    private _heartbeatTimeoutFired(): void {
        this._heartbeatTimeoutHandle = null;
        this._onTimeout();
    }

    messageReceived(): void {
        this._seenPacket = true;
        if (this._heartbeatTimeoutHandle) {
            this._clearHeartbeatTimeoutTimer();
        }
    }
}

// --- Random Stream ---

export type RandomStreamOptions = {
    seed?: any[] | any;
};

export class RandomStream {
    public seed: any[];
    public sequences: Record<string, any>;

    constructor(options: RandomStreamOptions) {
        this.seed = [].concat(options.seed || randomToken());
        this.sequences = Object.create(null);
    }

    _sequence(name: string): any {
        let sequence = this.sequences[name] || null;
        if (sequence === null) {
            const sequenceSeed = this.seed.concat(name);
            for (let i = 0; i < sequenceSeed.length; i++) {
                if (typeof sequenceSeed[i] === "function") {
                    sequenceSeed[i] = sequenceSeed[i]();
                }
            }
            this.sequences[name] = sequence = Random.createWithSeeds.apply(null, sequenceSeed);
        }
        return sequence;
    }

    static get(scope: MethodInvocation | null | undefined, name?: string): any {
        if (!name) {
            name = "default";
        }
        if (!scope) {
            return Random.insecure;
        }
        let randomStream = scope.randomStream;
        if (!randomStream) {
            scope.randomStream = randomStream = new RandomStream({
                seed: scope.randomSeed
            });
        }
        return randomStream._sequence(name);
    }
}

export function randomToken(): string {
    return Random.hexString(20);
}

export function makeRpcSeed(enclosing: MethodInvocation | null | undefined, methodName: string): string {
    const stream = RandomStream.get(enclosing, '/rpc/' + methodName);
    return stream.hexString(20);
}

// --- Method Invocation ---

export type MethodInvocationOptions = {
    name: string;
    isSimulation?: boolean;
    unblock?: () => void;
    isFromCallAsync?: boolean;
    userId?: string | null;
    setUserId?: (userId: string | null) => Promise<void> | void;
    connection?: any;
    randomSeed?: any;
    fence?: any;
};

export class MethodInvocation {
    public name: string;
    public isSimulation?: boolean;
    public userId?: string | null;
    public connection?: any;
    public randomSeed?: any;
    public randomStream: RandomStream | null;
    public fence?: any;

    private _unblock: () => void;
    private _calledUnblock: boolean;
    _isFromCallAsync?: boolean;
    private _setUserId: (userId: string | null) => Promise<void> | void;

    constructor(options: MethodInvocationOptions) {
        this.name = options.name;
        this.isSimulation = options.isSimulation;
        this._unblock = options.unblock || function () { };
        this._calledUnblock = false;
        this._isFromCallAsync = options.isFromCallAsync;
        this.userId = options.userId;
        this._setUserId = options.setUserId || function () { };
        this.connection = options.connection;
        this.randomSeed = options.randomSeed;
        this.randomStream = null;
        this.fence = options.fence;
    }

    unblock(): void {
        this._calledUnblock = true;
        this._unblock();
    }

    async setUserId(userId: string | null): Promise<void> {
        if (this._calledUnblock) {
            throw new Error("Can't call setUserId in a method after calling unblock");
        }
        this.userId = userId;
        await this._setUserId(userId);
    }
}