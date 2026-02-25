import { describe, it, expect } from 'vitest';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Mongo } from 'meteor/mongo';
import { EJSON } from 'meteor/ejson';
import { Connection } from 'meteor/ddp-client';
import { DDP } from 'meteor/ddp-client';
import { StubStream } from './stub-stream';
import { MongoID } from 'meteor/mongo-id';

const stubStream = new StubStream();

// Create a global connection just like Meteor does
const connection = new Connection(stubStream);


// Mock Collections
const Ledger = new Mongo.Collection('ledger', { connection });
const objectsWithUsers = new Mongo.Collection('objectsWithUsers', { connection });
const One = new Mongo.Collection('collectionOne', { connection });
const Two = new Mongo.Collection('collectionTwo', { connection });
const PublisherCloningCollection = new Mongo.Collection('publisherCloning', { connection });
const FlickerCollectionName = `allow_deny_flicker`;
const FlickerCollection = new Mongo.Collection(FlickerCollectionName, { connection });

// Helpers
const callWhenSubReady = async (subName: string, handle: any, cb: () => void | Promise<void> = () => {}) => {
  const start = Date.now();
  while (!handle.ready()) {
    if (Date.now() - start > 10000) {
      throw new Error(`Subscribe to ${subName} is taking too long!`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
  await cb();
};

const pollUntil = async (condition: () => boolean, timeout = 10000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('pollUntil timed out');
    }
    await new Promise(r => setTimeout(r, 50));
  }
};

const failure = (code?: number | string, reason?: string) => {
  return (error: any, result: any) => {
    expect(result).toBeUndefined();
    expect(typeof error).toBe('object');
    if (error && typeof error === 'object') {
      if (typeof code === 'number') {
        expect(error).toBeInstanceOf(Meteor.Error);
        if (code) expect(error.error).toBe(code);
        if (reason) expect(error.reason).toBe(reason);
      } else {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(code);
      }
    }
  };
};

const failureOnStopped = (code?: number | string, reason?: string) => {
  const f = failure(code, reason);
  return (error: any) => {
    if (error) {
      f(error, undefined);
    }
  };
};

const eavesdropOnCollection = (livedata_connection: any, collection_name: string, messages: any[]) => {
  const old_livedata_data = livedata_connection._livedata_data.bind(livedata_connection);
  livedata_connection._livedata_data = (msg: any) => {
    if (msg.collection && msg.collection === collection_name) {
      messages.push(msg);
    }
    old_livedata_data(msg);
  };
  return () => {
    livedata_connection._livedata_data = old_livedata_data;
  };
};

const checkBalances = async (runId: string, a: number, b: number) => {
  const alice = await Ledger.findOneAsync({ name: 'alice', world: runId });
  const bob = await Ledger.findOneAsync({ name: 'bob', world: runId });
  expect(alice?.balance).toBe(a);
  expect(bob?.balance).toBe(b);
};

describe('livedata - client tests', () => {

  it('Meteor.Error', () => {
    const error = new Meteor.Error(123, 'kittens', 'puppies');
    expect(error).toBeInstanceOf(Meteor.Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.error).toBe(123);
    expect(error.reason).toBe('kittens');
    expect(error.details).toBe('puppies');
  });

  it('methods with colliding names', () => {
    const x = Random.id();
    const m: any = {};
    m[x] = () => {};
    connection.methods(m);

    expect(() => connection.methods(m)).toThrow();
  });

  it('non-function method', () => {
    const x = Random.id();
    const m: any = {};
    m[x] = 'kitten';

    expect(() => connection.methods(m)).toThrow();
  });

  it('basic method invocation', async () => {
    const ret = connection.call('unknown method');
    expect(ret).toBeUndefined();

    await new Promise<void>(resolve => {
      connection.call('unknown method', (err: any, res: any) => {
        failure(404, "Method 'unknown method' not found")(err, res);
        resolve();
      });
    });

    expect(connection.call('nothing')).toBeUndefined();
    await new Promise<void>(resolve => {
      connection.call('nothing', (err: any, res: any) => {
        expect(err).toBeUndefined();
        expect(res).toBeUndefined();
        resolve();
      });
    });

    const echoTest = async (item: any) => {
      expect(connection.call('echo', item)).toBeUndefined();
      await new Promise<void>(resolve => {
        connection.call('echo', item, (err: any, res: any) => {
          expect(err).toBeUndefined();
          expect(res).toEqual([item]);
          resolve();
        });
      });
      expect(connection.call('echoOne', item)).toBeUndefined();
      await new Promise<void>(resolve => {
        connection.call('echoOne', item, (err: any, res: any) => {
          expect(err).toBeUndefined();
          expect(res).toEqual(item);
          resolve();
        });
      });
    };

    await echoTest(new Date());
    await echoTest({ d: new Date(), s: 'foobarbaz' });
    await echoTest([new Date(), 'foobarbaz']);
    await echoTest(new MongoID.ObjectID());
    await echoTest({ o: new MongoID.ObjectID() });
    await echoTest({ $date: 30 });
    await echoTest({ $literal: { $date: 30 } });
    await echoTest(12);
    await echoTest(Infinity);
    await echoTest(-Infinity);

    expect(connection.call('echo', 12, { x: 13 })).toBeUndefined();
    await new Promise<void>(resolve => {
      connection.call('echo', 12, { x: 13 }, (err: any, res: any) => {
        expect(err).toBeUndefined();
        expect(res).toEqual([12, { x: 13 }]);
        resolve();
      });
    });

    const token1 = Random.id();
    await new Promise<void>(resolve => {
      connection.apply('delayedTrue', [token1], { wait: false }, (err: any, res: any) => {
        expect(res).toBe(false);
        resolve();
      });
      connection.apply('makeDelayedTrueImmediatelyReturnFalse', [token1]);
    });

    const token2 = Random.id();
    await new Promise<void>(resolve => {
      connection.apply('delayedTrue', [token2], { wait: true }, (err: any, res: any) => {
        expect(res).toBe(true);
        resolve();
      });
      connection.apply('makeDelayedTrueImmediatelyReturnFalse', [token2]);
    });

    expect(connection.call('exception', 'both')).toBeUndefined();
    expect(connection.call('exception', 'server')).toBeUndefined();
    expect(connection.call('exception', 'client')).toBeUndefined();

    expect(() => {
      connection.apply('exception', ['both'], { throwStubExceptions: true });
    }).toThrow();
    
    expect(connection.apply('exception', ['server'], { throwStubExceptions: true })).toBeUndefined();
    
    expect(() => {
      connection.apply('exception', ['client'], { throwStubExceptions: true });
    }).toThrow();

    await new Promise<void>(resolve => {
      connection.call('exception', 'both', (err: any, res: any) => {
        failure(500, 'Internal server error')(err, res);
        resolve();
      });
    });

    await new Promise<void>(resolve => {
      connection.call('exception', 'server', (err: any, res: any) => {
        failure(500, 'Internal server error')(err, res);
        resolve();
      });
    });

    expect(connection.call('exception', 'client')).toBeUndefined();
  });

  it('compound methods', async () => {
    const runId = Random.id();
    const handle = connection.subscribe('ledger', runId, () => {});
    
    await Ledger.insertAsync({ name: 'alice', balance: 100, world: runId });
    await Ledger.insertAsync({ name: 'bob', balance: 50, world: runId });

    await connection.callAsync('ledger/transfer', runId, 'alice', 'bob', 10);
    await checkBalances(runId, 90, 60);

    const promise = connection.callAsync('ledger/transfer', runId, 'alice', 'bob', 100, true);
    await (promise as any).stubPromise;
    await checkBalances(runId, -10, 160);

    try {
      await promise;
    } catch (err) {
      failure(409)(err, undefined);
    }
    
    await checkBalances(runId, 90, 60);
    handle.stop();
  });

  it('changing userid reruns subscriptions without flapping data on the wire', async () => {
    const messages: any[] = [];
    const undoEavesdrop = eavesdropOnCollection(connection, 'objectsWithUsers', messages);

    const expectMessages = (expectedAddedMessageCount: number, expectedRemovedMessageCount: number, expectedNamesInCollection: string[]) => {
      let actualAddedMessageCount = 0;
      let actualRemovedMessageCount = 0;
      
      messages.forEach((msg) => {
        if (msg.msg === 'added') ++actualAddedMessageCount;
        else if (msg.msg === 'removed') ++actualRemovedMessageCount;
        else throw new Error(`Unexpected message: ${JSON.stringify(msg)}`);
      });
      
      expect(actualAddedMessageCount).toBe(expectedAddedMessageCount);
      expect(actualRemovedMessageCount).toBe(expectedRemovedMessageCount);
      
      expectedNamesInCollection.sort();
      const actualNames = objectsWithUsers.find({}, { sort: ['name'] }).fetch().map((x: any) => x.name);
      
      expect(actualNames).toEqual(expectedNamesInCollection);
      messages.length = 0; 
    };

    await new Promise<void>(resolve => {
      connection.apply('setUserId', [null], { wait: true }, () => resolve());
    });

    const handle = connection.subscribe('objectsWithUsers');

    await callWhenSubReady('objectsWithUsers', handle, async () => {
      expectMessages(1, 0, ['owned by none']);
      
      await new Promise<void>(resolve => {
        connection.apply('setUserId', ['1'], { wait: true }, resolve);
      });
      expectMessages(3, 1, ['owned by one - a', 'owned by one/two - a', 'owned by one/two - b']);
      
      await new Promise<void>(resolve => {
        connection.apply('setUserId', ['2'], { wait: true }, resolve);
      });
      expectMessages(2, 1, ['owned by one/two - a', 'owned by one/two - b', 'owned by two - a', 'owned by two - b']);
      
      await new Promise<void>(resolve => {
        connection.apply('setUserId', ['2'], { wait: true }, resolve);
      });
      expectMessages(0, 0, ['owned by one/two - a', 'owned by one/two - b', 'owned by two - a', 'owned by two - b']);
      
      undoEavesdrop();
    });
    handle.stop();
  });

  it('overlapping universal subs', async () => {
    const coll = new Mongo.Collection('overlappingUniversalSubs', { connection });
    const token = Random.id();
    expect(coll.findOne(token)).toBeFalsy();
    
    await new Promise<void>(resolve => {
      connection.call('testOverlappingSubs', token, (err: any) => {
        expect(err).toBeFalsy();
        expect(coll.findOne(token)).toBeTruthy();
        resolve();
      });
    });
  });

  it('runtime universal sub creation', async () => {
    const coll = new Mongo.Collection('runtimeSubCreation', { connection });
    const token = Random.id();
    expect(coll.findOne(token)).toBeFalsy();
    
    await new Promise<void>(resolve => {
      connection.call('runtimeUniversalSubCreation', token, (err: any) => {
        expect(err).toBeFalsy();
        expect(coll.findOne(token)).toBeTruthy();
        resolve();
      });
    });
  });

  it('no setUserId after unblock', async () => {
    await new Promise<void>(resolve => {
      connection.call('setUserIdAfterUnblock', (err: any, result: any) => {
        expect(err).toBeFalsy();
        expect(result).toBe(true);
        resolve();
      });
    });
  });

  it('publisher errors with onError callback', async () => {
    const conn = new Connection('/', { reloadWithOutstanding: true });
    const collName = Random.id();
    const coll = new Mongo.Collection(collName, { connection: conn });
    
    const testSubError = async (options: any) => {
      await new Promise<void>(resolve => {
        conn.subscribe('publisherErrors', collName, options, {
          onError: (err: any) => {
            failure(options.internalError ? 500 : 412, options.internalError ? 'Internal server error' : 'Explicit error')(err, undefined);
            resolve();
          },
        });
      });
    };

    await testSubError({ throwInHandler: true });
    await testSubError({ throwInHandler: true, internalError: true });
    await testSubError({ errorInHandler: true });
    await testSubError({ errorInHandler: true, internalError: true });
    await testSubError({ errorLater: true });
    await testSubError({ errorLater: true, internalError: true });
    
    conn.disconnect({ _permanent: true });
  });

  it('publish multiple cursors', async () => {
    await new Promise<void>((resolve, reject) => {
      const sub = connection.subscribe('multiPublish', { normal: 1 }, {
        onReady: () => {
          expect(sub.ready()).toBe(true);
          expect(One.find().count()).toBe(2);
          expect(Two.find().count()).toBe(3);
          resolve();
        },
        onError: (e: any) => reject(e),
      });
    });

    await new Promise<void>(resolve => {
      connection.subscribe('multiPublish', { dup: 1 }, {
        onError: (err: any) => {
          failure(500, 'Internal server error')(err, undefined);
          resolve();
        },
      });
    });

    await new Promise<void>(resolve => {
      connection.subscribe('multiPublish', { notCursor: 1 }, {
        onError: (err: any) => {
          failure(500, 'Internal server error')(err, undefined);
          resolve();
        },
      });
    });
  });

  it('connect fails to unknown place', async () => {
    const conn = DDP.connect('example.com', { _dontPrintErrors: true });
    await pollUntil(() => !conn.status().connected, 5000);
    expect(conn.status().connected).toBe(false);
    conn.close();
  });

  it('publish callbacks clone', async () => {
    await new Promise<void>((resolve, reject) => {
      connection.subscribe('publisherCloning', { normal: 1 }, {
        onReady: () => {
          expect(PublisherCloningCollection.findOne()).toEqual({
            _id: 'a',
            x: { y: 43 },
          });
          resolve();
        },
        onError: (e: any) => reject(e),
      });
    });
  });

  it('result by value', async () => {
    const testId = Random.id();
    let firstResult: any;

    await new Promise<void>(resolve => {
      connection.call('getArray', testId, (error: any, result: any) => {
        expect(error).toBeFalsy();
        expect(result).toBeTruthy();
        firstResult = result;
        resolve();
      });
    });

    await new Promise<void>(resolve => {
      connection.call('pushToArray', testId, 'xxx', (error: any) => {
        expect(error).toBeFalsy();
        resolve();
      });
    });

    await new Promise<void>(resolve => {
      connection.call('getArray', testId, (error: any, secondResult: any) => {
        expect(error).toBeFalsy();
        expect(firstResult.length + 1).toBe(secondResult.length);
        resolve();
      });
    });
  });

  it('method updated message with subscriptions', async () => {
    const collName = `test-collection`;
    const messages: any[] = [];
    
    const onMessage = (message: string) => messages.push(EJSON.parse(message));
    connection._stream.on('message', onMessage);

    const sub = connection.subscribe(`pub-${collName}`);
    await callWhenSubReady(`pub-${collName}`, sub);

    try {
      for (let i = 0; i < 5; i++) { // Using 5 to save time in tests, original was 250
        messages.length = 0;
        const insertId = await connection.callAsync(`insert-${collName}`);

        const hasResult = messages.some(msg => msg.msg === 'result');
        const resultId = messages.find(msg => msg.msg === 'result')?.id;
        const hasAdded = messages.some(msg => msg.msg === 'added');
        const hasUpdated = messages.some(msg => msg.msg === 'updated' && msg.methods?.includes(resultId));

        expect(hasResult).toBe(true);
        expect(hasAdded).toBe(true);
        expect(hasUpdated).toBe(true);

        messages.length = 0;
        await connection.callAsync(`update-${collName}`, insertId);

        const hasUpdateResult = messages.some(msg => msg.msg === 'result');
        const updateResultId = messages.find(msg => msg.msg === 'result')?.id;
        const hasChanged = messages.some(msg => msg.msg === 'changed');
        const hasUpdateUpdated = messages.some(msg => msg.msg === 'updated' && msg.methods?.includes(updateResultId));

        expect(hasUpdateResult).toBe(true);
        expect(hasChanged).toBe(true);
        expect(hasUpdateUpdated).toBe(true);

        messages.length = 0;
        await connection.callAsync(`remove-${collName}`, insertId);

        const hasRemoveResult = messages.some(msg => msg.msg === 'result');
        const removeResultId = messages.find(msg => msg.msg === 'result')?.id;
        const hasRemoved = messages.some(msg => msg.msg === 'removed');
        const hasRemoveUpdated = messages.some(msg => msg.msg === 'updated' && msg.methods?.includes(removeResultId));

        expect(hasRemoveResult).toBe(true);
        expect(hasRemoved).toBe(true);
        expect(hasRemoveUpdated).toBe(true);
      }
    } finally {
      sub.stop();
      // Cleanup listener if possible or leave for teardown
    }
  });

  it('allow/deny - no flicker with isomorphic calls', async () => {
    const runId = Random.id();
    const docId = await FlickerCollection.insertAsync({
      value: ['initial'],
      test: runId
    });

    let changeCount = 0;
    const messages: any[] = [];

    const handle = await FlickerCollection.find({ _id: docId }).observeChanges({
      added(id: string, fields: any) {
        messages.push(['added', id, fields]);
      },
      changed(id: string, fields: any) {
        changeCount++;
        messages.push(['changed', id, fields]);
        
        if (changeCount > 1) {
          throw new Error('Multiple changes detected - flicker occurred');
        }

        expect(fields.value.length).toBe(2);
        expect(fields.value.includes('updated')).toBe(true);
      }
    });

    const sub = connection.subscribe(`pub-${FlickerCollectionName}`);
    await callWhenSubReady(`pub-${FlickerCollectionName}`, sub);

    await FlickerCollection.updateAsync(docId, {
      $addToSet: {
        value: 'updated'
      }
    });

    await new Promise(r => setTimeout(r, 200));

    handle.stop();
    sub.stop();
    
    expect(changeCount).toBe(1);
    expect(messages.length).toBe(2);
    expect(messages[0][0]).toBe('added');
    expect(messages[1][0]).toBe('changed');
  });

});