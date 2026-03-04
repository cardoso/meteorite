import { expect, test } from 'vitest';
import { Random } from 'meteor/random';
import { DDP } from 'meteor/ddp-client';

test('livedata - DDP.randomStream', async () => {
    const randomSeed = Random.id();
    const context = { randomSeed: randomSeed };

    let sequence = await DDP._CurrentMethodInvocation.withValue(context, function () {
        return DDP.randomStream('1');
    });

    let seeds = sequence.alea.args;

    expect(seeds.length).toBe(2);
    expect(seeds[0]).toBe(randomSeed);
    expect(seeds[1]).toBe('1');

    const id1 = sequence.id();

    // Clone the sequence by building it the same way RandomStream.get does
    const sequenceClone = Random.createWithSeeds.apply(null, seeds);
    const id1Cloned = sequenceClone.id();
    const id2Cloned = sequenceClone.id();
    expect(id1).toBe(id1Cloned);

    // We should get the same sequence when we use the same key
    sequence = await DDP._CurrentMethodInvocation.withValue(context, function () {
        return DDP.randomStream('1');
    });
    seeds = sequence.alea.args;
    expect(seeds.length).toBe(2);
    expect(seeds[0]).toBe(randomSeed);
    expect(seeds[1]).toBe('1');

    // But we should be at the 'next' position in the stream
    const id2 = sequence.id();

    // Technically these could be equal, but likely to be a bug if hit
    // http://search.dilbert.com/comic/Random%20Number%20Generator
    expect(id1).not.toBe(id2);

    expect(id2).toBe(id2Cloned);
});

test('livedata - DDP.randomStream with no-args', () => {
    DDP.randomStream().id();
});
