import { describe, it, expect, vi } from 'vitest';
import { LocalCollection } from './local-collection.ts';

describe('LocalCollection', () => {
  it('performs basic CRUD operations', () => {
    const c = new LocalCollection();
    
    const fluffyKittenId = c.insert({ type: 'kitten', name: 'fluffy' });
    c.insert({ type: 'kitten', name: 'snookums' });
    c.insert({ type: 'cryptographer', name: 'alice' });

    expect(c.find().count()).toBe(3);
    expect(c.find({ type: 'kitten' }).count()).toBe(2);
    expect(c.find({ type: 'cryptographer' }).count()).toBe(1);
    
    expect(c.findOne({ type: 'kitten', name: 'fluffy' })?._id).toBe(fluffyKittenId);

    c.remove({ name: 'alice' });
    expect(c.find().count()).toBe(2);

    const count = c.update({ name: 'snookums' }, { $set: { type: 'cryptographer' } });
    expect(count).toBe(1);
    expect(c.find({ type: 'kitten' }).count()).toBe(1);
    expect(c.find({ type: 'cryptographer' }).count()).toBe(1);
  });

  it('handles limit and skip correctly', () => {
    const c = new LocalCollection();
    for (let i = 0; i < 20; i++) {
      c.insert({ i });
    }

    expect(c.find().count()).toBe(20);
    
    const limited = c.find({}, { skip: 5, limit: 10 }).fetch();
    expect(limited).toHaveLength(10);
    expect(limited[0].i).toBe(5);
    expect(limited[9].i).toBe(14);
  });

  it('handles upsert correctly', () => {
    const c = new LocalCollection();

    c.upsert({ name: 'doc' }, { $set: { value: 1 } });
    expect(c.find({}).count()).toBe(1);
    expect(c.findOne({ name: 'doc' })?.value).toBe(1);

    // Update existing
    c.upsert({ name: 'doc' }, { $set: { value: 2 } });
    expect(c.find({}).count()).toBe(1);
    expect(c.findOne({ name: 'doc' })?.value).toBe(2);
  });

  it('iterates via forEach and map', () => {
    const c = new LocalCollection();
    for (let i = 0; i < 5; i++) {
      c.insert({ i });
    }

    const q = c.find({}, { sort: { i: 1 } });
    
    let count = 0;
    q.forEach((doc, i) => {
      expect(doc.i).toBe(count++);
      expect(doc.i).toBe(i);
    });
    expect(count).toBe(5);

    const mapped = q.map(doc => doc.i * 2);
    expect(mapped).toEqual([0, 2, 4, 6, 8]);
  });

  describe('Reactivity (Observers)', () => {
    it('buffers changes when paused and replays them on resume', () => {
      const c = new LocalCollection();
      
      const addedSpy = vi.fn();
      const changedSpy = vi.fn();
      const removedSpy = vi.fn();

      const handle = c.find({}).observe({
        added: addedSpy,
        changed: changedSpy,
        removed: removedSpy
      });

      const id = c.insert({ a: 1 });
      expect(addedSpy).toHaveBeenCalledTimes(1);

      c.pauseObservers();

      // two modifications should become one coalesced diff
      c.update({ _id: id }, { $set: { a: 2 } });
      c.update({ _id: id }, { $set: { a: 3 } });

      expect(changedSpy).not.toHaveBeenCalled(); // Still paused

      c.resumeObserversClient();
      
      expect(changedSpy).toHaveBeenCalledTimes(1);
      expect(changedSpy).toHaveBeenCalledWith(
        expect.objectContaining({ a: 3 }), 
        expect.objectContaining({ a: 1 })
      );

      handle.stop();
    });
  });

  describe('saveOriginals / retrieveOriginals (Latency Compensation)', () => {
    it('maintains original state snapshots properly', () => {
      const c = new LocalCollection();

      c.insert({ _id: 'foo', x: 'untouched' });
      c.insert({ _id: 'bar', x: 'updateme' });

      c.saveOriginals();
      
      c.insert({ _id: 'hooray', z: 'insertme' });
      c.update({ _id: 'bar' }, { $set: { k: 7 } });

      const originals = c.retrieveOriginals();
      expect(originals).toBeDefined();
      expect(originals!.size).toBe(2);
      
      expect(originals!.get('bar')).toEqual({ _id: 'bar', x: 'updateme' });
      expect(originals!.get('hooray')).toBeUndefined(); // Inserted, so original was undefined
    });

    it('throws errors on invalid usage', () => {
      const c = new LocalCollection();
      expect(() => c.retrieveOriginals()).toThrow(/without saveOriginals/);
      
      c.saveOriginals();
      expect(() => c.saveOriginals()).toThrow(/twice without retrieveOriginals/);
    });
  });
});