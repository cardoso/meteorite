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
  set userId(value) {
    Accounts.userId = value;
  },
  get users() {
    return Accounts.users;
  },
  set users(value) {
    Accounts.users = value;
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
  set logout(value: typeof Accounts.logout) {
    Accounts.logout = value;
  },
  get logoutAllClients() {
    return Accounts.logoutAllClients.bind(Accounts);
  },
  get logoutOtherClients() {
    return Accounts.logoutOtherClients.bind(Accounts);
  },

  // --- Auth Proxies ---
  get loginWithPassword() {
    return Accounts.loginWithPassword.bind(Accounts);
  },
  set loginWithPassword(value) {
    Accounts.loginWithPassword = value;
  },

  get loginWithToken() {
    return Accounts.loginWithToken.bind(Accounts);
  },
  set loginWithToken(value) {
    Accounts.loginWithToken = value;
  },
  // --------------------

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

  // --- DDP Connection Proxies ---
  get call(): Connection['call'] {
    return this.connection.call.bind(this.connection);
  },
  set call(value: Connection['call']) {
    this.connection.call = value;
  },

  get callAsync(): Connection['callAsync'] {
    return this.connection.callAsync.bind(this.connection);
  },
  set callAsync(value: Connection['callAsync']) {
    this.connection.callAsync = value;
  },

  get apply(): Connection['apply'] {
    return this.connection.apply.bind(this.connection);
  },
  set apply(value: Connection['apply']) {
    this.connection.apply = value;
  },

  get applyAsync(): Connection['applyAsync'] {
    return this.connection.applyAsync.bind(this.connection);
  },
  set applyAsync(value: Connection['applyAsync']) {
    this.connection.applyAsync = value;
  },

  get methods(): Connection['methods'] {
    return this.connection.methods.bind(this.connection);
  },
  set methods(value: Connection['methods']) {
    this.connection.methods = value;
  },

  get subscribe(): Connection['subscribe'] {
    return this.connection.subscribe.bind(this.connection);
  },
  set subscribe(value: Connection['subscribe']) {
    this.connection.subscribe = value;
  },

  get status(): Connection['status'] {
    return this.connection.status.bind(this.connection);
  },

  get reconnect(): Connection['reconnect'] {
    return this.connection.reconnect.bind(this.connection);
  },

  get disconnect(): Connection['disconnect'] {
    return this.connection.disconnect.bind(this.connection);
  },
  // ------------------------------

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
