import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toWebsocketUrl } from "meteor/socket-stream-client/urls";
import { ClientStream } from "meteor/socket-stream-client";
import { Tracker } from "meteor/tracker";

// Lightweight array equality helper
const isArrayEqual = (a: string[], b: string[]): boolean => {
    return a.length === b.length && a.every((val, index) => val === b[index]);
};

// Mock WebSocket to simulate server connection success without a real server
class MockWebSocket {
    onopen?: () => void;
    onclose?: () => void;
    onerror?: (e: Event) => void;
    onmessage?: (e: MessageEvent) => void;
    url: string;

    constructor(url: string) {
        this.url = url;
        // Automatically "connect" shortly after instantiation
        setTimeout(() => {
            if (this.onopen) this.onopen();
        }, 5);
    }

    send(_data: any) { }

    close() {
        // Automatically "close" shortly after request
        setTimeout(() => {
            if (this.onclose) this.onclose();
        }, 5);
    }
}

describe('Client Stream Status', () => {

    beforeEach(() => {
        vi.stubGlobal('WebSocket', MockWebSocket);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('websocket urls are computed correctly', () => {
        const testHasWebsocketUrl = (raw: string, expectedUrl: string | RegExp) => {
            const actual = toWebsocketUrl(raw);
            if (expectedUrl instanceof RegExp) {
                expect(actual).toMatch(expectedUrl);
            } else {
                expect(actual).toBe(expectedUrl);
            }
        };

        testHasWebsocketUrl('http://subdomain.meteor.com/', 'ws://subdomain.meteor.com/websocket');
        testHasWebsocketUrl('http://subdomain.meteor.com', 'ws://subdomain.meteor.com/websocket');
        testHasWebsocketUrl('subdomain.meteor.com/', 'ws://subdomain.meteor.com/websocket');
        testHasWebsocketUrl('subdomain.meteor.com', 'ws://subdomain.meteor.com/websocket');

        testHasWebsocketUrl('http://localhost:3000/', 'ws://localhost:3000/websocket');
        testHasWebsocketUrl('http://localhost:3000', 'ws://localhost:3000/websocket');
        testHasWebsocketUrl('localhost:3000', 'ws://localhost:3000/websocket');

        testHasWebsocketUrl('https://subdomain.meteor.com/', 'wss://subdomain.meteor.com/websocket');
        testHasWebsocketUrl('https://subdomain.meteor.com', 'wss://subdomain.meteor.com/websocket');

        testHasWebsocketUrl('ddp+sockjs://ddp--****-foo.meteor.com/sockjs', /^wss:\/\/ddp--\d\d\d\d-foo\.meteor\.com\/sockjs$/);
        testHasWebsocketUrl('ddpi+sockjs://ddp--****-foo.meteor.com/sockjs', /^ws:\/\/ddp--\d\d\d\d-foo\.meteor\.com\/sockjs$/);
    });

    it('disconnecting and reconnecting transitions through the correct statuses', () => {
        return new Promise<void>((resolve, reject) => {
            const history: string[] = [];
            const stream = new ClientStream('/');

            Tracker.autorun((computation) => {
                const status = stream.status();

                if (history[history.length - 1] !== status.status) {
                    history.push(status.status);

                    if (isArrayEqual(history, ['connecting'])) {
                        // wait
                    } else if (isArrayEqual(history, ['connecting', 'connected'])) {
                        stream.disconnect();
                    } else if (isArrayEqual(history, ['connecting', 'connected', 'offline'])) {
                        stream.reconnect();
                    } else if (isArrayEqual(history, ['connecting', 'connected', 'offline', 'connecting'])) {
                        // wait
                    } else if (isArrayEqual(history, ['connecting', 'connected', 'offline', 'connecting', 'connected'])) {
                        computation.stop();
                        stream.disconnect();
                        resolve();
                    } else if (isArrayEqual(history, ['connecting', 'connected', 'offline', 'connecting', 'connected', 'offline'])) {
                        // End condition
                    } else {
                        computation.stop();
                        stream.disconnect();
                        reject(new Error('Unexpected status history: ' + JSON.stringify(history)));
                    }
                }
            });
        });
    });

    it('remains offline if the online event is received while offline', () => {
        return new Promise<void>((resolve, reject) => {
            const history: string[] = [];
            const stream = new ClientStream('/');

            Tracker.autorun((computation) => {
                const status = stream.status();

                if (history[history.length - 1] !== status.status) {
                    history.push(status.status);

                    if (isArrayEqual(history, ['connecting'])) {
                        // wait
                    } else if (isArrayEqual(history, ['connecting', 'connected'])) {
                        stream.disconnect();
                    } else if (isArrayEqual(history, ['connecting', 'connected', 'offline'])) {
                        stream._online();
                        expect(stream.status().status).toBe('offline');
                        computation.stop();
                        resolve();
                    } else {
                        computation.stop();
                        reject(new Error('Unexpected status history: ' + JSON.stringify(history)));
                    }
                }
            });
        });
    });

});