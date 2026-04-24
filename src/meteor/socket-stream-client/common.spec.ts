import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamClientCommon } from './common';

class TestStream extends StreamClientCommon {
  public changedUrls: string[] = [];
  public cleanedWith: Array<Error | undefined> = [];
  public launched = 0;

  protected _changeUrl(url: string): void {
    this.changedUrls.push(url);
  }

  protected _cleanup(maybeError?: Error): void {
    this.cleanedWith.push(maybeError);
  }

  protected _launchConnection(): void {
    this.launched += 1;
  }
}

describe('StreamClientCommon', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers callbacks and iterates over registered event callbacks', () => {
    const stream = new TestStream();
    const onMessage = vi.fn();
    const onReset = vi.fn();

    stream.on('message', onMessage);
    stream.on('reset', onReset);

    const visited: Array<Function> = [];
    stream.forEachCallback('message', (callback) => {
      visited.push(callback);
      callback('payload');
    });

    expect(visited).toHaveLength(1);
    expect(onMessage).toHaveBeenCalledWith('payload');
    expect(onReset).not.toHaveBeenCalled();
  });

  it('throws on unknown event names', () => {
    const stream = new TestStream();

    expect(() => stream.on('unknown' as never, () => {})).toThrow(/unknown event type/);
  });

  it('reconnect with force while connected triggers forced lost connection path', () => {
    const stream = new TestStream({ retry: false });
    const retryLaterSpy = vi.spyOn((stream as any)._retry, 'retryLater').mockReturnValue(50);

    (stream as any).currentStatus.connected = true;
    (stream as any).currentStatus.status = 'connected';

    stream.reconnect({ _force: true });

    expect(stream.cleanedWith).toHaveLength(1);
    expect(stream.cleanedWith[0]).toBeInstanceOf(Error);
    expect(stream.cleanedWith[0]?.message).toContain('forced reconnect');
    expect(retryLaterSpy).toHaveBeenCalledOnce();
    expect((stream as any).currentStatus.status).toBe('waiting');
    expect((stream as any).currentStatus.connected).toBe(false);
  });

  it('reconnect with url while connected updates URL and triggers lost connection', () => {
    const stream = new TestStream({ retry: false });
    const retryLaterSpy = vi.spyOn((stream as any)._retry, 'retryLater').mockReturnValue(10);

    (stream as any).currentStatus.connected = true;
    (stream as any).currentStatus.status = 'connected';

    stream.reconnect({ url: 'ws://new-host' });

    expect(stream.changedUrls).toEqual(['ws://new-host']);
    expect(stream.cleanedWith).toHaveLength(1);
    expect(retryLaterSpy).toHaveBeenCalledOnce();
  });

  it('reconnect from connecting state clears retry and restarts connection attempt', () => {
    const stream = new TestStream();
    const clearSpy = vi.spyOn((stream as any)._retry, 'clear');

    (stream as any).currentStatus.connected = false;
    (stream as any).currentStatus.status = 'connecting';
    (stream as any).currentStatus.retryCount = 3;

    stream.reconnect();

    expect(clearSpy).toHaveBeenCalledOnce();
    expect((stream as any).currentStatus.retryCount).toBe(3);
    expect((stream as any).currentStatus.status).toBe('connecting');
    expect(stream.launched).toBe(1);
    expect(stream.cleanedWith).toHaveLength(1);
  });

  it('disconnect transitions to offline or failed depending on permanence', () => {
    const stream = new TestStream();
    const clearSpy = vi.spyOn((stream as any)._retry, 'clear');

    stream.disconnect();
    expect((stream as any).currentStatus.status).toBe('offline');
    expect((stream as any).currentStatus.connected).toBe(false);
    expect(clearSpy).toHaveBeenCalledOnce();

    stream.disconnect({ _permanent: true, _error: 'fatal' });
    expect((stream as any)._forcedToDisconnect).toBe(true);
    expect((stream as any).currentStatus.status).toBe('failed');
    expect((stream as any).currentStatus.reason).toBe('fatal');
  });

  it('online event reconnects unless currently offline', () => {
    const stream = new TestStream();
    const reconnectSpy = vi.spyOn(stream, 'reconnect');

    (stream as any).currentStatus.status = 'offline';
    stream._online();
    expect(reconnectSpy).not.toHaveBeenCalled();

    (stream as any).currentStatus.status = 'waiting';
    stream._online();
    expect(reconnectSpy).toHaveBeenCalledOnce();
  });

  it('retryLater marks stream failed when retries are disabled', () => {
    const stream = new TestStream({ retry: false });

    (stream as any).currentStatus.retryTime = 12345;
    (stream as any)._retryLater();

    expect((stream as any).currentStatus.status).toBe('failed');
    expect((stream as any).currentStatus.connected).toBe(false);
    expect((stream as any).currentStatus.retryTime).toBeUndefined();
  });

  it('status notifies Tracker dependency via depend()', () => {
    const stream = new TestStream();
    const depend = vi.fn();
    const changed = vi.fn();

    (stream as any).statusListeners = { depend, changed };

    const status = stream.status();

    expect(depend).toHaveBeenCalledOnce();
    expect(status).toBe((stream as any).currentStatus);
  });
});
