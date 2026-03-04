import { expect, test } from 'vitest';
import { Random } from 'meteor/random';

test('random', function () {
    // Deterministic with a specified seed, which should generate the
    // same sequence in all environments.
    //
    // For repeatable unit test failures using deterministic random
    // number sequences it's fine if a new Meteor release changes the
    // algorithm being used and it starts generating a different
    // sequence for a seed, as long as the sequence is consistent for
    // a particular release.
    const random = Random.createWithSeeds(0);
    expect(random.id()).toBe('cp9hWvhg8GSvuZ9os');
    expect(random.id()).toBe('3f3k6Xo7rrHCifQhR');
    expect(random.id()).toBe('shxDnjWWmnKPEoLhM');
    expect(random.id()).toBe('6QTjB8C5SEqhmz4ni');
});

// node crypto and window.crypto.getRandomValues() don't let us specify a seed,
// but at least test that the output is in the right format.
test('random - format', function () {
    const idLen = 17;
    expect(Random.id().length).toBe(idLen);
    expect(Random.id(29).length).toBe(29);
    const numDigits = 9;
    const hexStr = Random.hexString(numDigits);
    expect(hexStr.length).toBe(numDigits);
    Number.parseInt(hexStr, 16); // should not throw
    const frac = Random.fraction();
    expect(frac).toBeLessThan(1.0);
    expect(frac).toBeGreaterThanOrEqual(0.0);

    expect(Random.secret().length).toBe(43);
    expect(Random.secret(13).length).toBe(13);
});

test('random - createWithSeeds requires parameters', function () {
    expect(() => {
        Random.createWithSeeds();
    }).toThrow();
});
