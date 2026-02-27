import type { Meteor } from 'meteor/meteor';
import { DDP } from './namespace.ts';
import { loadAsyncStubHelpers } from "./queue-stub-helpers.ts";
import { Retry } from 'meteor/retry';
import { Reload } from 'meteor/reload';

export const setupClientConvenience = (Meteor: Meteor) => {
  Meteor.refresh = () => { };

  const runtimeConfig = typeof (globalThis as any).__meteor_runtime_config__ !== 'undefined'
    ? (globalThis as any).__meteor_runtime_config__
    : Object.create(null);

  const ddpUrl = runtimeConfig.DDP_DEFAULT_CONNECTION_URL || '/';



  const retry = new Retry();

  function onDDPVersionNegotiationFailure(description: string) {
    console.warn(description);
    const migrationData = Reload._migrationData('livedata') || Object.create(null);
    let failures = migrationData.DDPVersionNegotiationFailures || 0;
    ++failures;
    Reload._onMigrate('livedata', () => [true, { DDPVersionNegotiationFailures: failures }]);
    retry.retryLater(failures, () => {
      Reload._reload({ immediateMigration: true });
    });
  }

  Meteor.connection = DDP.connect(ddpUrl, {
    onDDPVersionNegotiationFailure: onDDPVersionNegotiationFailure
  });
}

loadAsyncStubHelpers();
