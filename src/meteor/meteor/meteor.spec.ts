import { expect, test } from 'vitest';
import { Meteor } from 'meteor/meteor';

test("environment - client basics", () => {
  expect(Meteor.isClient).toBe(true);
  expect(Meteor.isServer).toBe(false);
});
