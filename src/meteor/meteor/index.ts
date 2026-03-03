import { MeteorError } from './errors';
import { EnvironmentVariable, bindEnvironment } from './dynamics';
import { defer, setTimeout, setInterval, clearTimeout, clearInterval } from './timers';
import { _debug } from './debug';
import { AsynchronousQueue, SynchronousQueue } from './queues';
import { startup } from './startup';
import { Connection } from 'meteor/ddp-client';
import { Accounts } from 'meteor/accounts-base';
import { withLocalStorage } from 'meteor/localstorage';
import { _ensure, _get } from './helpers';
import { absoluteUrl } from './url';

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

  type Error = MeteorError;
}

const settings: Record<string, any> = {};

export const Meteor = withLocalStorage({
  // Hardcoded environment flags for standard client builds
  settings,
  absoluteUrl,

  get user() {
    return Accounts.user;
  },
  set user(value: typeof Accounts.user) {
    Accounts.user = value;
  },
  get userAsync() {
    return Accounts.userAsync.bind(Accounts);
  },
  get userId() {
    return Accounts.userId.bind(Accounts);
  },
  set userId(value: typeof Accounts.userId) {
    Accounts.userId = value;
  },

  get loggingIn() {
    return Accounts.loggingIn.bind(Accounts);
  },
  get loggingOut() {
    return Accounts.loggingOut.bind(Accounts);
  },
  get logout() {
    return Accounts.logout.bind(Accounts);
  },
  get logoutAllClients() {
    return Accounts.logoutAllClients.bind(Accounts);
  },
  get logoutOtherClients() {
    return Accounts.logoutOtherClients.bind(Accounts);
  },
  // loginWithPassword: Accounts.loginWithPassword.bind(Accounts),
  EnvironmentVariable,
  bindEnvironment,
  get connection() {
    if (!_connection) {
      _connection = new Connection('/', { retry: true });
    }
    return _connection;
  },
  set connection(conn: Connection) {
    _connection = conn;
  },
  get call(): Connection['call'] {
    return this.connection.call.bind(this.connection);
  },
  set call(value: Connection['call']) {
    this.connection.call = value;
  },
  Error,
  defer,
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,

  _AsynchronousQueue: AsynchronousQueue,
  _SynchronousQueue: SynchronousQueue,

  _debug,
  startup,
  refresh,

  // Minimal utility polyfills that some legacy packages still look for
  _get,
  _ensure,

  // Stubs for safely removing nodejs/server specific features
  _noYieldsAllowed: (f: Function) => f(),
});
