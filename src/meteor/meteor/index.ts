import { MeteorError } from './errors';
import { EnvironmentVariable, bindEnvironment } from './dynamics';
import { defer, setTimeoutWrapped, setIntervalWrapped, clearTimeoutWrapped, clearIntervalWrapped } from './timers';
import { _debug } from './debug';
import { AsynchronousQueue, SynchronousQueue } from './queues';
import { startup } from './startup';
import type { Connection } from 'meteor/ddp-client';
import { Accounts } from 'meteor/accounts-base';

export const refresh = () => { };
let _connection: Connection | null = null;
export const isClient = true;
export const isServer = false;
export const isCordova = false;

export const Error = MeteorError;

export type User = {
  _id: string;
}

export declare namespace Meteor {
  type User = {
    _id: string;
  };
}

export const Meteor = {
  // Hardcoded environment flags for standard client builds


  user: Accounts.user.bind(Accounts),
  userId: Accounts.userId.bind(Accounts),
  EnvironmentVariable,
  bindEnvironment,
  get connection() {
    if (!_connection) {
      throw new Error('Meteor.connection has not been set yet');
    }
    return _connection;
  },
  set connection(conn: Connection) {
    _connection = conn;
  },
  get call(): Connection['call'] {
    return this.connection.call.bind(this.connection);
  },
  Error,
  defer,
  setTimeout: setTimeoutWrapped,
  setInterval: setIntervalWrapped,
  clearTimeout: clearTimeoutWrapped,
  clearInterval: clearIntervalWrapped,

  _AsynchronousQueue: AsynchronousQueue,
  _SynchronousQueue: SynchronousQueue,

  _debug,
  startup,
  refresh,

  // Minimal utility polyfills that some legacy packages still look for
  _get: (obj: any, ...args: string[]) => {
    for (let i = 0; i < args.length; i++) {
      if (!obj || !(args[i] in obj)) return undefined;
      obj = obj[args[i]];
    }
    return obj;
  },
  _ensure: (obj: any, ...args: string[]) => {
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (!(key in obj)) obj[key] = {};
      obj = obj[key];
    }
    return obj;
  },

  // Stubs for safely removing nodejs/server specific features
  _noYieldsAllowed: (f: Function) => f(),
};