import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection } from './livedata-connection';
import { StubStream } from './stub-stream';
import { SUPPORTED_DDP_VERSIONS } from './ddp-common.core';

// --- Test Helpers ---

const SESSION_ID = '17';

const newConnection = (stream: StubStream, options: any = {}) => {
  return new Connection(stream, {
    reloadWithOutstanding: true,
    bufferedWritesInterval: 0,
    ...options,
  });
};

const makeConnectMessage = (session?: string) => {
  const msg: any = {
    msg: 'connect',
    version: SUPPORTED_DDP_VERSIONS[0],
    support: SUPPORTED_DDP_VERSIONS,
  };
  if (session) msg.session = session;
  return msg;
};

const testGotMessage = (stream: StubStream, expected: any) => {
  expect(stream.sent.length).toBeGreaterThan(0);
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
  expect(stream.sent.length).toBe(0);

  await stream.receive({ msg: 'connected', session: SESSION_ID });
  expect(stream.sent.length).toBe(0);
};

// A lightweight mock to replace Meteor's Mongo.Collection for DDP testing
class MockStore {
  public data: any[] = [];
  
  constructor(public name: string, public conn: Connection) {
    conn.registerStoreClient(name, {
      beginUpdate: () => {},
      update: (msg: any) => {
        if (msg.msg === 'added') this.data.push({ _id: msg.id, ...msg.fields });
        if (msg.msg === 'changed') {
          const doc = this.data.find(d => d._id === msg.id);
          if (doc) Object.assign(doc, msg.fields);
        }
        if (msg.msg === 'removed') {
          this.data = this.data.filter(d => d._id !== msg.id);
        }
      },
      endUpdate: () => {},
      saveOriginals: () => {},
      retrieveOriginals: () => new Map(),
      getDoc: (id: string) => this.data.find(d => d._id === id)
    });
  }

  find(query: any = {}) {
    const matches = this.data.filter(d => 
      Object.keys(query).every(k => d[k] === query[k])
    );
    return {
      fetch: () => matches,
      count: () => matches.length
    };
  }
}

// --- Tests ---

describe('LiveData Connection', () => {
  
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('receives data and populates unknown stores', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);

    await startAndConnect(stream);

    const collName = 'test_collection';
    
    // Data comes in for unknown collection.
    await stream.receive({
      msg: 'added',
      collection: collName,
      id: '1234',
      fields: { a: 1 }
    });

    // Break through the black box and test internal state
    expect((conn as any)._updatesForUnknownStores[collName].length).toBe(1);

    // Registering the store should process the queued updates
    const coll = new MockStore(collName, conn);

    expect((conn as any)._updatesForUnknownStores[collName]).toBeUndefined();
    expect(coll.find().fetch()).toEqual([{ _id: '1234', a: 1 }]);

    // Second message. Applied directly to the db.
    await stream.receive({
      msg: 'changed',
      collection: collName,
      id: '1234',
      fields: { a: 2 }
    });
    
    expect(coll.find().fetch()).toEqual([{ _id: '1234', a: 2 }]);
  });

  it('buffers data appropriately', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream, {
      bufferedWritesInterval: 10,
      bufferedWritesMaxAge: 40
    });

    await startAndConnect(stream);

    const collName = 'buffered_collection';
    const coll = new MockStore(collName, conn);

    const addDoc = async () => {
      await stream.receive({
        msg: 'added',
        collection: collName,
        id: Math.random().toString(),
        fields: {}
      });
    };

    // Starting at 0 ticks
    await addDoc(); // 1st Doc
    expect((conn as any)._liveDataWritesPromise).toBeUndefined();
    expect(coll.find().count()).toBe(0); // Waiting for buffer

    vi.advanceTimersByTime(6); // 6 total ticks
    expect(coll.find().count()).toBe(0); 

    vi.advanceTimersByTime(4); // 10 total ticks, 1st buffer interval
    
    // Let internal promises resolve
    await Promise.resolve();
    
    expect(coll.find().count()).toBe(1); // 1st doc visible

    await addDoc(); // 2nd doc
    vi.advanceTimersByTime(1); 
    expect(coll.find().count()).toBe(1); 
    
    vi.advanceTimersByTime(9); // 20 total ticks
    await Promise.resolve();
    expect(coll.find().count()).toBe(2); 
  });

  it('handles basic ping without id', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);
    await startAndConnect(stream);

    await stream.receive({ msg: 'ping' });
    testGotMessage(stream, { msg: 'pong' });
  });

  it('handles ping with id', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);
    await startAndConnect(stream);

    const id = 'random-ping-id';
    await stream.receive({ msg: 'ping', id });
    testGotMessage(stream, { msg: 'pong', id });
  });

  it('handles method wait state and queues messages', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);
    await startAndConnect(stream);

    const responses: string[] = [];
    conn.methods({ do_something: (x: any) => {} });

    conn.apply('do_something', ['one!'], {}, () => responses.push('one'));
    
    let oneMessage = JSON.parse(stream.sent.shift()!);
    expect(oneMessage.params).toEqual(['one!']);

    // Call a wait method
    conn.apply('do_something', ['two!'], { wait: true }, () => responses.push('two'));
    
    // 'two!' isn't sent yet, because it's a wait method.
    expect(stream.sent.length).toBe(0);

    conn.apply('do_something', ['three!'], {}, () => responses.push('three'));

    // Verify no more sent because waiting on 'one!' which blocks the 'two!' wait method
    expect(stream.sent.length).toBe(0);

    // Let "one!" finish
    await stream.receive({ msg: 'result', id: oneMessage.id });
    await stream.receive({ msg: 'updated', methods: [oneMessage.id] });
    
    expect(responses).toEqual(['one']);

    // Now we've sent out "two!"
    let twoMessage = JSON.parse(stream.sent.shift()!);
    expect(twoMessage.params).toEqual(['two!']);
    
    // "three!" still waiting on "two!"
    expect(stream.sent.length).toBe(0);

    // Let "two!" finish
    await stream.receive({ msg: 'updated', methods: [twoMessage.id] });
    await stream.receive({ msg: 'result', id: twoMessage.id });
    
    expect(responses).toEqual(['one', 'two']);

    // "three!" is now sent
    expect(stream.sent.length).toBe(1);
    let threeMessage = JSON.parse(stream.sent.shift()!);
    expect(threeMessage.params).toEqual(['three!']);
  });

  it('handles outstanding methods on reset', async () => {
    const stream = new StubStream();
    const conn = newConnection(stream);
    await startAndConnect(stream);

    conn.methods({ do_something: (x: any) => {} });

    conn.apply('do_something', ['one'], {}, () => {});
    conn.apply('do_something', ['two'], { wait: true }, () => {});
    
    // initial connect
    stream.sent = [];
    await stream.reset();
    
    testGotMessage(stream, makeConnectMessage((conn as any)._lastSessionId));

    // Test that we re-send the first message block.
    const loginId = testGotMessage(stream, {
      msg: 'method',
      method: 'do_something',
      params: ['one'],
      id: '*'
    }).id;

    // Connect again
    await stream.receive({ msg: 'connected', session: 'new-session-id' });
    expect(stream.sent.length).toBe(0);
  });
});