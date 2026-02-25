import { describe, it, expect, vi, afterEach } from 'vitest';
import { Tracker } from 'meteor/tracker';
import { ReactiveVar } from 'meteor/reactive-var';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { DDPCommon } from 'meteor/ddp-common';
import { Connection } from 'meteor/ddp-client';
import { StubStream } from './stub-stream.ts';

const SESSION_ID = '17';
const identity = (x: any) => x;

const newConnection = (stream: StubStream, options: any = {}) => {
  return new Connection(
    stream,
    Object.assign(
      {
        reloadWithOutstanding: true,
        bufferedWritesInterval: 0
      },
      options
    )
  );
};

const makeConnectMessage = (session?: string) => {
  const msg: any = {
    msg: 'connect',
    version: DDPCommon.SUPPORTED_DDP_VERSIONS[0],
    support: DDPCommon.SUPPORTED_DDP_VERSIONS
  };
  if (session) msg.session = session;
  return msg;
};

const testGotMessage = (stream: StubStream, expected: any) => {
  if (stream.sent.length === 0) {
    throw new Error(`no message received, expected: ${JSON.stringify(expected)}`);
  }

  let got = stream.sent.shift();
  if (typeof got === 'string' && typeof expected === 'object') {
    got = JSON.parse(got);
  }

  if (typeof expected === 'object') {
    const keysWithStarValues = Object.keys(expected).filter(k => expected[k] === '*');
    keysWithStarValues.forEach(k => {
      expected[k] = got[k];
    });
  }

  expect(got).toEqual(expected);
  return got;
};

const startAndConnect = async (stream: StubStream) => {
  await stream.reset();
  testGotMessage(stream, makeConnectMessage());
  expect(stream.sent).toHaveLength(0);

  await stream.receive({ msg: 'connected', session: SESSION_ID });
  expect(stream.sent).toHaveLength(0);
};

const observeCursor = async (cursor: any) => {
  const counts = { added: 0, removed: 0, changed: 0, moved: 0 };
  const expectedCounts = Object.assign({}, counts);

  const handle = await cursor.observe({
    addedAt: () => { counts.added += 1; },
    removedAt: () => { counts.removed += 1; },
    changedAt: () => { counts.changed += 1; },
    movedTo: () => { counts.moved += 1; }
  });

  return {
    stop: handle.stop.bind(handle),
    expectCallbacks: (delta?: Partial<typeof counts>) => {
      Object.entries(delta || {}).forEach(([field, mod]) => {
        (expectedCounts as any)[field] += mod;
      });
      expect(counts).toEqual(expectedCounts);
    }
  };
};

describe('livedata connection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stub - receive data', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);

    await startAndConnect(stream);

    const coll_name = Random.id();
    await stream.receive({
      msg: 'added',
      collection: coll_name,
      id: '1234',
      fields: { a: 1 }
    });

    expect(conn._updatesForUnknownStores[coll_name]).toHaveLength(1);

    const coll = new Mongo.Collection(coll_name, { connection: conn });
    // await coll._settingUpReplicationPromise;

    expect(conn._updatesForUnknownStores[coll_name]).toBeUndefined();
    expect(coll.find({}).fetch()).toEqual([{ _id: '1234', a: 1 }]);

    await stream.receive({
      msg: 'changed',
      collection: coll_name,
      id: '1234',
      fields: { a: 2 }
    });

    expect(coll.find({}).fetch()).toEqual([{ _id: '1234', a: 2 }]);
    expect(conn._updatesForUnknownStores[coll_name]).toBeUndefined();
  });

  it('stub - buffering data', async () => {
    vi.useFakeTimers();
    const tick = (timeout: number) => vi.advanceTimersByTime(timeout);

    const stream = new StubStream();
    const conn = newConnection(stream, {
      bufferedWritesInterval: 10,
      bufferedWritesMaxAge: 40
    });

    await startAndConnect(stream);

    const coll_name = Random.id();
    const coll = new Mongo.Collection(coll_name, { connection: conn });

    const addDoc = async () => {
      await stream.receive({
        msg: 'added',
        collection: coll_name,
        id: Random.id(),
        fields: {}
      });
    };

    await addDoc(); // 1st
    expect(conn._liveDataWritesPromise).toBeUndefined();
    expect(await coll.find({}).count()).toBe(0);

    tick(6); // 6 total
    expect(conn._liveDataWritesPromise).toBeUndefined();
    expect(await coll.find({}).count()).toBe(0);

    tick(4); // 10 total
    expect(conn._liveDataWritesPromise).toBeDefined();
    await conn._liveDataWritesPromise;
    expect(await coll.find({}).count()).toBe(1);

    await addDoc(); // 2nd
    expect(conn._liveDataWritesPromise).toBeUndefined();
    tick(1); // 11 total
    expect(conn._liveDataWritesPromise).toBeUndefined();
    expect(await coll.find({}).count()).toBe(1);

    tick(9); // 20 total
    expect(conn._liveDataWritesPromise).toBeDefined();
    await conn._liveDataWritesPromise;
    expect(await coll.find({}).count()).toBe(2);
  });

  it('stub - reactive subscribe', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);
    await startAndConnect(stream);

    const rFoo = new ReactiveVar('foo1');
    const rBar = new ReactiveVar('bar1');

    const onReadyCount: Record<string, number> = {};
    const onReady = (tag: string) => () => {
      onReadyCount[tag] = (onReadyCount[tag] || 0) + 1;
    };

    let stopperHandle: any, completerHandle: any;
    const autorunHandle = Tracker.autorun(() => {
      conn.subscribe('foo', rFoo.get(), onReady(rFoo.get()));
      conn.subscribe('bar', rBar.get(), onReady(rBar.get()));
      completerHandle = conn.subscribe('completer', onReady('completer'));
      stopperHandle = conn.subscribe('stopper', onReady('stopper'));
    });

    let completerReady = false;
    const readyAutorunHandle = Tracker.autorun(() => {
      completerReady = completerHandle.ready();
    });

    expect(stream.sent).toHaveLength(4);

    let message = JSON.parse(stream.sent.shift());
    const idFoo1 = message.id;
    delete message.id;
    expect(message).toEqual({ msg: 'sub', name: 'foo', params: ['foo1'] });

    message = JSON.parse(stream.sent.shift());
    const idBar1 = message.id;
    delete message.id;
    expect(message).toEqual({ msg: 'sub', name: 'bar', params: ['bar1'] });

    message = JSON.parse(stream.sent.shift());
    const idCompleter = message.id;
    delete message.id;
    expect(message).toEqual({ msg: 'sub', name: 'completer', params: [] });

    message = JSON.parse(stream.sent.shift());
    const idStopper = message.id;
    delete message.id;
    expect(message).toEqual({ msg: 'sub', name: 'stopper', params: [] });

    expect(onReadyCount).toEqual({});
    Tracker.flush();
    expect(completerReady).toBe(false);

    await stream.receive({ msg: 'ready', subs: [idCompleter] });
    expect(onReadyCount).toEqual({ completer: 1 });
    expect(stream.sent).toHaveLength(0);
    Tracker.flush();
    expect(completerReady).toBe(true);

    stopperHandle.stop();
    expect(stream.sent).toHaveLength(1);
    message = JSON.parse(stream.sent.shift());
    expect(message).toEqual({ msg: 'unsub', id: idStopper });

    rFoo.set('foo2');
    Tracker.flush();
    expect(stream.sent).toHaveLength(3);

    message = JSON.parse(stream.sent.shift());
    const idFoo2 = message.id;
    delete message.id;
    expect(message).toEqual({ msg: 'sub', name: 'foo', params: ['foo2'] });

    message = JSON.parse(stream.sent.shift());
    const idStopperAgain = message.id;
    delete message.id;
    expect(message).toEqual({ msg: 'sub', name: 'stopper', params: [] });

    message = JSON.parse(stream.sent.shift());
    expect(message).toEqual({ msg: 'unsub', id: idFoo1 });

    expect(onReadyCount).toEqual({ completer: 2 });
    expect(completerReady).toBe(true);

    await stream.receive({ msg: 'ready', subs: [idStopperAgain, idBar1] });
    expect(onReadyCount).toEqual({ completer: 2, bar1: 1, stopper: 1 });

    autorunHandle.stop();
    Tracker.flush();
    readyAutorunHandle.stop();

    expect(stream.sent).toHaveLength(4);
    const unsubMessages = stream.sent.map((a) => JSON.parse(a));
    stream.sent.length = 0;

    expect([...new Set(unsubMessages.map(msg => msg.msg))]).toEqual(['unsub']);
    const actualIds = unsubMessages.map(msg => msg.id).sort();
    const expectedIds = [idFoo2, idBar1, idCompleter, idStopperAgain].sort();
    expect(actualIds).toEqual(expectedIds);
  });

  it('stub - this context', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);
    await startAndConnect(stream);

    conn.methods({
      test_this: function () {
        expect((this as any).isSimulation).toBe(true);
        (this as any).unblock();
      }
    });

    conn.call('test_this', identity);

    let message = JSON.parse(stream.sent.shift());
    expect(message.randomSeed).toBeUndefined();
    expect(message).toEqual({
      msg: 'method',
      method: 'test_this',
      params: [],
      id: message.id
    });
    expect(stream.sent).toHaveLength(0);

    await stream.receive({ msg: 'result', id: message.id, result: null });
    await stream.receive({ msg: 'updated', methods: [message.id] });
  });

  it('stub - mutating method args', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);
    await startAndConnect(stream);

    conn.methods({
      mutateArgs: function (arg: any) {
        arg.foo = 42;
      }
    });

    conn.call('mutateArgs', { foo: 50 }, identity);

    let message = JSON.parse(stream.sent.shift());
    expect(message.randomSeed).toBeUndefined();
    expect(message).toEqual({
      msg: 'method',
      method: 'mutateArgs',
      params: [{ foo: 50 }],
      id: message.id
    });
    expect(stream.sent).toHaveLength(0);
  });

  it('stub - method call before connect', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);

    const callbackOutput: any[] = [];
    conn.call('someMethod', (err: any, result: any) => {
      callbackOutput.push(result);
    });
    expect(callbackOutput).toEqual([]);

    stream.sent.length = 0;

    await stream.reset();

    testGotMessage(stream, makeConnectMessage());
    testGotMessage(stream, {
      msg: 'method',
      method: 'someMethod',
      params: [],
      id: '*'
    });
  });

  it('connection - ping with and without id', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);
    await startAndConnect(stream);

    await stream.receive({ msg: 'ping' });
    testGotMessage(stream, { msg: 'pong' });

    const id = Random.id();
    await stream.receive({ msg: 'ping', id: id });
    testGotMessage(stream, { msg: 'pong', id: id });
  });
});