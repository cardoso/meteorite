import { describe, it, expect, vi } from 'vitest';
import { 
  LocalCollection, 
  Matcher,
  makeLookupFunction,
  compileProjection,
  compareValues,
  isEqual 
} from 'meteor/minimongo';
import { EJSON } from 'meteor/ejson';
// --- Test Helpers ---

const assert_ordering = (f: Function, values: any[]) => {
  for (let i = 0; i < values.length; i++) {
    const x = f(values[i], values[i]);
    expect(x).toBe(0);
    
    if (i + 1 < values.length) {
      const less = values[i];
      const more = values[i + 1];
      expect(f(less, more)).toBeLessThan(0);
      expect(f(more, less)).toBeGreaterThan(0);
    }
  }
};

const log_callbacks = (operations: any[]) => ({
  addedAt(obj: any, idx: number, before: any) {
    delete obj._id;
    operations.push(EJSON.clone(['added', obj, idx, before]));
  },
  changedAt(obj: any, old_obj: any, at: number) {
    delete obj._id;
    delete old_obj._id;
    operations.push(EJSON.clone(['changed', obj, at, old_obj]));
  },
  movedTo(obj: any, old_at: number, new_at: number, before: any) {
    delete obj._id;
    operations.push(EJSON.clone(['moved', obj, old_at, new_at, before]));
  },
  removedAt(old_obj: any, at: number) {
    const id = old_obj._id;
    delete old_obj._id;
    operations.push(EJSON.clone(['removed', id, at, old_obj]));
  },
});

const matches = (shouldMatch: boolean, selector: any, doc: any) => {
  const doesMatch = new Matcher(selector).documentMatches(doc).result;
  expect(doesMatch).toBe(shouldMatch);
};

const match = matches.bind(null, true);
const nomatch = matches.bind(null, false);

// --- Tests ---

describe('Minimongo Client', () => {

  describe('Basics', () => {
    it('handles inserts, finds, updates, and removes', async () => {
      const c = new LocalCollection();
      
      const fluffyKitten_id = await c.insertAsync({ type: 'kitten', name: 'fluffy' });
      await c.insertAsync({ type: 'kitten', name: 'snookums' });
      await c.insertAsync({ type: 'cryptographer', name: 'alice' });
      await c.insertAsync({ type: 'cryptographer', name: 'bob' });
      await c.insertAsync({ type: 'cryptographer', name: 'cara' });
      
      expect(c.find().count()).toBe(5);
      expect(c.find({ type: 'kitten' }).count()).toBe(2);
      expect(c.find({ type: 'cryptographer' }).count()).toBe(3);
      expect(c.find({ type: 'kitten' }).fetch()).toHaveLength(2);
      
      expect(c.findOne({ type: 'kitten', name: 'fluffy' })?._id).toBe(fluffyKitten_id);

      await c.removeAsync({ name: 'cara' });
      expect(c.find().count()).toBe(4);
      expect(c.find({ type: 'cryptographer' }).count()).toBe(2);

      const count = await c.updateAsync({ name: 'snookums' }, { $set: { type: 'cryptographer' } });
      expect(count).toBe(1);
      expect(c.find({ type: 'kitten' }).count()).toBe(1);
      expect(c.find({ type: 'cryptographer' }).count()).toBe(3);

      await c.removeAsync(null);
      await c.removeAsync(false);
      await c.removeAsync(undefined);
      expect(c.find().count()).toBe(4);

      await c.removeAsync({});
      expect(c.find().count()).toBe(0);

      await c.insertAsync({ _id: '1', name: 'strawberry', tags: ['fruit', 'red', 'squishy'] });
      await c.insertAsync({ _id: '2', name: 'apple', tags: ['fruit', 'red', 'hard'] });
      await c.insertAsync({ _id: '3', name: 'rose', tags: ['flower', 'red', 'squishy'] });

      expect(c.find({ tags: 'flower' }).count()).toBe(1);
      expect(c.find({ tags: 'fruit' }).count()).toBe(2);

      expect((await c.findOneAsync('1'))?.name).toBe('strawberry');
      expect((await c.findOneAsync('4'))).toBeUndefined();

      expect(c.find('1', { skip: 1 }).count()).toBe(0);
      expect(c.find({}, { skip: 1 }).count()).toBe(2);
      expect(c.find({}, { limit: 2 }).count()).toBe(2);
    });

    it('handles upsert correctly', async () => {
      const c = new LocalCollection();
      await c.upsertAsync({ name: 'doc' }, { name: 'doc' });
      expect(c.find({}).count()).toBe(1);

      await c.removeAsync({});
      c.upsert({ name: 'doc' }, { name: 'doc' });
      expect(c.find({}).count()).toBe(1);
    });

    it('handles operation result fields', async () => {
      const c = new LocalCollection();

      const insertedId = await c.insertAsync({ name: 'doc1' });
      expect(insertedId).toBeDefined();

      const updateResult: any = await c.updateAsync({ name: 'doc1' }, { $set: { value: 1 } });
      expect(updateResult).toBe(1);

      const upsertUpdateResult: any = await c.upsertAsync({ name: 'doc1' }, { $set: { value: 2 } });
      expect(upsertUpdateResult.numberAffected).toBe(1);
      expect(upsertUpdateResult.insertedId).toBeUndefined();

      const upsertInsertResult: any = await c.upsertAsync({ name: 'doc2' }, { $set: { value: 3 } });
      expect(upsertInsertResult.numberAffected).toBe(1);
      expect(upsertInsertResult.insertedId).toBeDefined();

      const removeResult = await c.removeAsync({ name: 'doc1' });
      expect(removeResult).toBe(1);
    });

    it('handles bulk remove with $in operator', () => {
      const coll = new LocalCollection();
      const ids = ['id1', 'id2', 'id3', 'id4'];
      ids.forEach(id => coll.insert({ _id: id, value: `item-${id}` }));
      
      expect(coll.find().count()).toBe(4);
      
      const removedCount = coll.remove({ _id: { $in: ['id1', 'id2'] } });
      expect(removedCount).toBe(2);
      expect(coll.find().count()).toBe(2);
      expect(coll.findOne('id1')).toBeUndefined();
      expect(coll.findOne('id3')).toBeDefined();
    });
  });

  describe('Cursors & Iterators', () => {
    it('supports basic cursor mapping and iteration', () => {
      const c = new LocalCollection();
      for (let i = 0; i < 20; i++) c.insert({ i });

      const q = c.find();
      expect(q.count()).toBe(20);

      const res = q.fetch();
      expect(res).toHaveLength(20);
      for (let i = 0; i < 20; i++) {
        expect(res[i].i).toBe(i);
      }

      let count = 0;
      q.forEach((obj: any, i: number) => {
        expect(obj.i).toBe(count++);
        expect(obj.i).toBe(i);
      });
      expect(count).toBe(20);

      count = 0;
      for (const obj of q as any) {
        expect(obj.i).toBe(count++);
      }
      expect(count).toBe(20);

      const mapped = q.map((obj: any, i: number) => obj.i * 2);
      expect(mapped).toHaveLength(20);
      expect(mapped[0]).toBe(0);
      expect(mapped[1]).toBe(2);
    });

    it('asyncIterator is supported', async () => {
      const collection = new LocalCollection();
      collection.insert({ _id: 'a' });
      collection.insert({ _id: 'b' });

      let itemIds: string[] = [];
      for await (const item of (collection.find() as any)) {
        itemIds.push(item._id);
      }
      expect(itemIds).toEqual(['a', 'b']);
    });
  });

  describe('Selector Compiler', () => {
    it('handles empty selectors and scalars', () => {
      match({}, {});
      match({}, { a: 12 });
      match(1, { _id: 1, a: 'foo' });
      nomatch(1, { _id: 2, a: 'foo' });
      match('a', { _id: 'a', a: 'foo' });
    });

    it('matches one or more keys', () => {
      nomatch({ a: 12 }, {});
      match({ a: 12 }, { a: 12 });
      match({ a: 12, b: 13 }, { a: 12, b: 13 });
      nomatch({ a: 12, b: 13, c: 14 }, { a: 12, b: 13 });
      match({ a: 12 }, { a: [11, 12, 13] });
      nomatch({ a: 12 }, { a: [11, 13] });
    });

    it('handles dates', () => {
      const date1 = new Date();
      const date2 = new Date(date1.getTime() + 1000);
      match({ a: date1 }, { a: date1 });
      nomatch({ a: date1 }, { a: date2 });
      match({ a: { $gt: date1 } }, { a: date2 });
    });

    it('handles literal documents', () => {
      match({ a: { b: 12 } }, { a: { b: 12 } });
      nomatch({ a: { b: 12, c: 13 } }, { a: { b: 12 } });
      nomatch({ a: { b: 12 } }, { a: { b: 12, c: 13 } });
      match({ a: { b: 12, c: 20 } }, { a: [{ b: 11 }, { b: 12, c: 20 }, { b: 13 }] });
    });

    it('handles order comparisons', () => {
      match({ a: { $lt: 10 } }, { a: 9 });
      nomatch({ a: { $lt: 10 } }, { a: 10 });
      match({ a: { $gt: 10 } }, { a: 11 });
      match({ a: { $lte: 10 } }, { a: 10 });
      match({ a: { $gte: 10 } }, { a: 10 });
    });

    it('handles $all, $exists, $mod', () => {
      match({ a: { $all: [1, 2] } }, { a: [1, 2] });
      nomatch({ a: { $all: [1, 2, 3] } }, { a: [1, 2] });
      match({ a: { $all: [1, 2] } }, { a: [3, 2, 1] });

      match({ a: { $exists: true } }, { a: 12 });
      nomatch({ a: { $exists: true } }, { b: 12 });
      
      match({ a: { $mod: [10, 1] } }, { a: 11 });
      nomatch({ a: { $mod: [10, 1] } }, { a: 12 });
    });

    it('handles $in, $nin, $ne, $eq', () => {
      match({ a: { $eq: 2 } }, { a: 2 });
      nomatch({ a: { $eq: 1 } }, { a: 2 });
      
      match({ a: { $ne: 1 } }, { a: 2 });
      nomatch({ a: { $ne: 2 } }, { a: 2 });

      match({ a: { $in: [1, 2, 3] } }, { a: 2 });
      nomatch({ a: { $in: [1, 2, 3] } }, { a: 4 });

      nomatch({ a: { $nin: [1, 2, 3] } }, { a: 2 });
      match({ a: { $nin: [1, 2, 3] } }, { a: 4 });
    });

    it('handles $size, $type, $regex', () => {
      match({ a: { $size: 0 } }, { a: [] });
      match({ a: { $size: 2 } }, { a: [2, 2] });
      nomatch({ a: { $size: 1 } }, { a: [] });

      match({ a: { $type: 1 } }, { a: 1.1 });
      match({ a: { $type: 2 } }, { a: '1' });
      match({ a: { $type: 8 } }, { a: true });

      match({ a: /a/ }, { a: 'cat' });
      nomatch({ a: /a/ }, { a: 'cut' });
      match({ a: /a/i }, { a: 'CAT' });
      match({ a: { $regex: 'a' } }, { a: 'cat' });
    });

    it('handles logicals $or, $and, $nor, $not', () => {
      match({ x: { $not: { $gt: 7 } } }, { x: 6 });
      nomatch({ x: { $not: { $gt: 7 } } }, { x: 8 });

      match({ $or: [{ a: 1 }, { b: 2 }] }, { a: 1 });
      match({ $or: [{ a: 1 }, { b: 2 }] }, { b: 2 });
      nomatch({ $or: [{ c: 3 }, { d: 4 }] }, { a: 1 });

      match({ $and: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 2 });
      nomatch({ $and: [{ a: 1 }, { a: 2 }] }, { a: 1 });

      nomatch({ $nor: [{ a: 1 }, { b: 2 }] }, { a: 1 });
      match({ $nor: [{ c: 3 }, { d: 4 }] }, { a: 1 });
    });

    it('handles $where', () => {
      match({ $where: 'this.a === 1' }, { a: 1 });
      nomatch({ $where: 'this.a !== 1' }, { a: 1 });
      match({ $where: 'this.a instanceof Array' }, { a: [] });
    });

    it('handles reaching into arrays and $elemMatch', () => {
      match({ 'dogs.name': 'Fido' }, { dogs: [{ name: 'Fido' }, { name: 'Rex' }] });
      match({ dogs: { $elemMatch: { name: /e/ } } }, { dogs: [{ name: 'Fido' }, { name: 'Rex' }] });
      nomatch({ dogs: { $elemMatch: { name: /a/ } } }, { dogs: [{ name: 'Fido' }, { name: 'Rex' }] });
      match({ dogs: { $elemMatch: { name: 'Fido', age: { $gt: 4 } } } }, { dogs: [{ name: 'Fido', age: 5 }, { name: 'Rex', age: 3 }] });
    });
  });

  describe('Lookups and Utilities', () => {
    it('makeLookupFunction behaves correctly', () => {
      const lookupA = makeLookupFunction('a');
      expect(lookupA({})).toEqual([{ value: undefined }]);
      expect(lookupA({ a: 1 })).toEqual([{ value: 1 }]);
      expect(lookupA({ a: [1] })).toEqual([{ value: [1] }]);

      const lookupAX = makeLookupFunction('a.x');
      expect(lookupAX({ a: { x: 1 } })).toEqual([{ value: 1 }]);
      expect(lookupAX({ a: 5 })).toEqual([{ value: undefined }]);
      expect(lookupAX({ a: [{ x: 1 }, { x: [2] }, { y: 3 }] })).toEqual([
        { value: 1, arrayIndices: [0] },
        { value: [2], arrayIndices: [1] },
        { value: undefined, arrayIndices: [2] }
      ]);
    });

    it('assert_ordering values accurately', () => {
      const date1 = new Date();
      const date2 = new Date(date1.getTime() + 1000);

      assert_ordering(compareValues, [
        null, 1, 2.2, 3, '03', '1', '11', '2', 'a', 'aaa',
        {}, { a: 2 }, { a: 3 }, { a: 3, b: 4 }, { b: 4 }, { b: 4, a: 3 },
        { b: {} }, { b: [1, 2, 3] }, { b: [1, 2, 4] },
        [], [1, 2], [1, 2, 3], [1, 2, 4], [1, 2, '4'], [1, 2, [4]],
        false, true, date1, date2,
      ]);
    });
  });

  describe('Projection Compiler', () => {
    const testProjection = (projection: any, tests: any[]) => {
      const projection_f = compileProjection(projection);
      tests.forEach(testCase => {
        expect(projection_f(testCase[0])).toEqual(testCase[1]);
      });
    };

    it('handles whitelists', () => {
      testProjection({ foo: 1, bar: 1 }, [
        [{ foo: 42, bar: 'something', baz: 'else' }, { foo: 42, bar: 'something' }],
        [{ foo: { nested: 17 }, baz: {} }, { foo: { nested: 17 } }],
        [{ _id: 'uid', bazbaz: 42 }, { _id: 'uid' }],
      ]);
    });

    it('handles blacklists', () => {
      testProjection({ foo: 0, bar: 0 }, [
        [{ foo: 42, bar: 'something', baz: 'else' }, { baz: 'else' }],
        [{ foo: { nested: 17 }, baz: { foo: 'something' } }, { baz: { foo: 'something' } }],
        [{ _id: 'uid', bazbaz: 42 }, { _id: 'uid', bazbaz: 42 }],
      ]);
    });

    it('throws on mixed projections', () => {
      expect(() => compileProjection({ inc: 1, excl: 0 })).toThrow(/mix including and excluding fields/);
    });
  });

  describe('Sorting', () => {
    it('sorts properly using Sorter', () => {
      const c = new LocalCollection();
      for (let i = 0; i < 50; i++) {
        for (let j = 0; j < 2; j++) { c.insert({ a: i, b: j, _id: `${i}_${j}` }); }
      }

      expect(c.find({ a: { $gt: 10 } }, { sort: { b: -1, a: 1 }, limit: 5 }).fetch()).toEqual([
        { a: 11, b: 1, _id: '11_1' },
        { a: 12, b: 1, _id: '12_1' },
        { a: 13, b: 1, _id: '13_1' },
        { a: 14, b: 1, _id: '14_1' },
        { a: 15, b: 1, _id: '15_1' }
      ]);
    });

    it('supports custom sort functions', () => {
      const c = new LocalCollection();
      [1, 10, 5, 7, 2, 4, 3].forEach(a => c.insert({ a }));

      const sortFunction = (doc1: any, doc2: any) => doc2.a - doc1.a;
      const sortedViaDb = c.find({}, { sort: sortFunction }).fetch();
      const sortedViaArray = c.find({}).fetch().sort(sortFunction);
      
      expect(sortedViaDb).toEqual(sortedViaArray);
    });
  });

  describe('GeoQueries & $near', () => {
    it('throws error for unsupported geo queries like $geoIntersects', () => {
      const collection = new LocalCollection();
      collection.insert({ _id: 'a', loc: { type: 'Point', coordinates: [0, 0] } });

      const query = {
        loc: {
          $geoIntersects: {
            $geometry: {
              type: 'Polygon',
              coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
            }
          }
        }
      };

      expect(() => collection.findOne(query)).toThrow(/Unrecognized operator: \$geoIntersects/);
    });

    it('sorts correctly with $near without overriding explicit sorts', async () => {
      const coll = new LocalCollection();
      await coll.insertAsync({ _id: 'x', k: 9, a: { b: [[100, 100], [1, 1]] } });
      await coll.insertAsync({ _id: 'y', k: 9, a: { b: [5, 5] } });

      const res = await coll.find({ 'a.b': { $near: [1, 1] } }, { sort: { k: 1 } }).fetchAsync();
      expect(res.map((d: any) => d._id)).toEqual(['x', 'y']);
    });
  });

  describe('Reactivity & Observes', () => {
    it('calls added/changed/removed on ordered observer', async () => {
      const operations: any[] = [];
      const cbs = log_callbacks(operations);

      const c = new LocalCollection();
      const handle = c.find({}, { sort: { a: 1 } }).observe(cbs);
      
      await c.insertAsync({ _id: 'foo', a: 1 });
      expect(operations.shift()).toEqual(['added', { a: 1 }, 0, null]);
      
      await c.updateAsync({ a: 1 }, { $set: { a: 2 } });
      expect(operations.shift()).toEqual(['changed', { a: 2 }, 0, { a: 1 }]);

      await c.insertAsync({ a: 10 });
      expect(operations.shift()).toEqual(['added', { a: 10 }, 1, null]);

      await c.removeAsync({ a: 2 });
      expect(operations.shift()).toBeUndefined();
      
      await c.removeAsync({ a: 10 });
      expect(operations.shift()).toEqual(['removed', 'foo', 0, { a: 10 }]);

      handle.stop();
    });

    it('pauses and resumes observers', async () => {
      const operations: any[] = [];
      const cbs = log_callbacks(operations);

      const c = new LocalCollection();
      const h = c.find({}).observe(cbs);

      await c.insertAsync({ _id: '1', a: 1 });
      expect(operations.shift()).toEqual(['added', { a: 1 }, 0, null]);

      c.pauseObservers();

      await c.removeAsync({ _id: '1' });
      expect(operations).toHaveLength(0);
      
      await c.insertAsync({ _id: '1', a: 1 });
      expect(operations).toHaveLength(0);

      (c as any).resumeObserversClient();
      expect(operations).toHaveLength(0); // cancelled out
      h.stop();
    });
  });

  describe('Save / Retrieve Originals', () => {
    it('manages original snapshots effectively', () => {
      const c = new LocalCollection();

      c.insert({ _id: 'foo', x: 'untouched' });
      c.insert({ _id: 'bar', x: 'updateme' });
      
      c.saveOriginals();
      c.insert({ _id: 'hooray', z: 'insertme' });
      c.update('bar', { $set: { k: 7 } });

      const originals = c.retrieveOriginals();
      expect(originals.has('bar')).toBe(true);
      expect(originals.get('bar')).toEqual({ _id: 'bar', x: 'updateme' });
      expect(originals.get('hooray')).toBeUndefined();
    });

    it('throws errors on improper original fetching', () => {
      const c = new LocalCollection();
      expect(() => c.retrieveOriginals()).toThrow(/Called retrieveOriginals without saveOriginals/);
      c.saveOriginals();
      expect(() => c.saveOriginals()).toThrow(/Called saveOriginals twice without retrieveOriginals/);
    });
  });
});