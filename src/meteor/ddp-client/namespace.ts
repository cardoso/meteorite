import { DDPCommon } from 'meteor/ddp-common';
import { Meteor } from 'meteor/meteor';
import { Hook } from 'meteor/callback-hook';
import type { BaseConnection, ConnectionOptions } from './base-connection.ts';
import { Connection } from './livedata-connection.ts';

// Export an array to track connections for _allSubscriptionsReady
export const allConnections: BaseConnection[] = [];

class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DDP.ConnectionError';
  }
}

class ForcedReconnectError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'DDP.ForcedReconnectError';
  }
}

const _reconnectHook = new Hook({ bindEnvironment: false });

const onReconnect = (callback: (conn: BaseConnection) => void) => {
  return DDP._reconnectHook.register(callback);
};

const _allSubscriptionsReady = () => allConnections.every((conn) => Object.values(conn._subscriptions).every((sub) => sub.ready));

const connect = (url: string | object, options?: ConnectionOptions) => {
  const ret = new Connection(url, options);
  allConnections.push(ret); // hack. see below.
  return ret;
}

export const DDP = {
  ConnectionError,
  ForcedReconnectError,
  _reconnectHook,
  onReconnect,
  _allSubscriptionsReady,
  _CurrentMethodInvocation: null! as Meteor.EnvironmentVariable,
  connect,

  randomStream: (name?: string) => {
    const scope = DDP._CurrentMethodInvocation?.get();
    return DDPCommon.RandomStream.get(scope, name);
  }
};

// LAZY INITIALIZATION: Fixes the "Cannot access 'Meteor' before initialization" error
const lazyEnvVar = (key: string) => {
  let instance: any;
  Object.defineProperty(DDP, key, {
    get() {
      if (!instance) instance = new Meteor.EnvironmentVariable();
      return instance;
    },
    set(val) { instance = val; },
    enumerable: true,
    configurable: true
  });
};

lazyEnvVar('_CurrentMethodInvocation');
lazyEnvVar('_CurrentPublicationInvocation');
lazyEnvVar('_CurrentCallAsyncInvocation');

Object.defineProperty(DDP, '_CurrentInvocation', {
  get() { return DDP._CurrentMethodInvocation; },
  set(val) { DDP._CurrentMethodInvocation = val; }
});