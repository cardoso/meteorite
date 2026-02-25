import { DDP } from './namespace.ts';
import { loadAsyncStubHelpers } from "./queue-stub-helpers.ts";
import { Retry } from 'meteor/retry';

const Package = (typeof globalThis !== 'undefined' ? (globalThis as any).Package : null);

export const setupClientConvenience = (Meteor: any) => {
  Meteor.refresh = () => {};

  const runtimeConfig = typeof (globalThis as any).__meteor_runtime_config__ !== 'undefined' 
    ? (globalThis as any).__meteor_runtime_config__ 
    : Object.create(null);
    
  const ddpUrl = runtimeConfig.DDP_DEFAULT_CONNECTION_URL || '/';

  const retry = new Retry();

  function onDDPVersionNegotiationFailure(description: string) {
    console.warn(description);
    if (Package?.reload) {
      const migrationData = Package.reload.Reload._migrationData('livedata') || Object.create(null);
      let failures = migrationData.DDPVersionNegotiationFailures || 0;
      ++failures;
      Package.reload.Reload._onMigrate('livedata', () => [true, { DDPVersionNegotiationFailures: failures }]);
      retry.retryLater(failures, () => {
        Package.reload.Reload._reload({ immediateMigration: true });
      });
    }
  }

  loadAsyncStubHelpers();

  Meteor.connection = DDP.connect(ddpUrl, {
    onDDPVersionNegotiationFailure: onDDPVersionNegotiationFailure
  });

  [
    'subscribe',
    'methods',
    'isAsyncCall',
    'call',
    'callAsync',
    'apply',
    'applyAsync',
    'status',
    'reconnect',
    'disconnect'
  ].forEach(name => {
    Meteor[name] = Meteor.connection[name].bind(Meteor.connection);
  });
};