import type { } from 'meteor/ddp-client';
import { EJSON } from 'meteor/ejson';
import type { DisconnectOptions, ClientStream } from 'meteor/socket-stream-client';

export class StubStream implements ClientStream {
    public sent: any[];
    public callbacks: Record<string, Array<(...args: any[]) => any>>;
    public _isStub: boolean;
    public _neverQueued: boolean;

    constructor() {
        this.sent = [];
        this.callbacks = Object.create(null);
        this._isStub = true;
        this._neverQueued = true;
    }

    disconnect: (options?: DisconnectOptions) => void = () => {
        // no-op
    };

    public on(name: string, callback: (...args: any[]) => any): void {
        if (!this.callbacks[name]) {
            this.callbacks[name] = [callback];
        } else {
            this.callbacks[name].push(callback);
        }
    }

    public send(data: any): void {
        this.sent.push(data);
    }

    public status(): StreamStatus {
        return { status: 'connected', fake: true };
    }

    public reconnect(): void {
        // no-op
    }

    public _lostConnection(): void {
        // no-op
    }

    public async receive(data: any): Promise<void> {
        if (typeof data === 'object') {
            data = EJSON.stringify(data);
        }

        if (this.callbacks['message']) {
            for (const cb of this.callbacks['message']) {
                await cb(data);
            }
        }
    }

    public async reset(): Promise<void> {
        if (this.callbacks['reset']) {
            for (const cb of this.callbacks['reset']) {
                await cb();
            }
        }
    }
}