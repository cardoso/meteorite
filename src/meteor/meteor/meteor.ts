import { MeteorError } from './errors';
import { EnvironmentVariable, bindEnvironment } from './dynamics';
import { defer, setTimeout, setInterval, clearTimeout, clearInterval } from './timers';
import { _debug } from './debug';
import { AsynchronousQueue, SynchronousQueue } from './queues';
import { startup } from './startup';
import { Connection } from 'meteor/ddp-client';
import { withAccounts } from 'meteor/accounts-base';
import { withLocalStorage } from 'meteor/localstorage';
import { _ensure, _get } from './helpers';
import { absoluteUrl } from './url';

export const refresh = () => { };
let _connection: Connection | null = null;
export const isClient = true;
export const isServer = false;
export const isCordova = false;

export const Error = MeteorError;

export declare namespace Meteor {

  type User = {
    _id: string;
  };

  type Error = MeteorError;

  type TypedError = MeteorError & { errorType: string };

  interface LoginWithExternalServiceOptions {
    requestPermissions?: ReadonlyArray<string> | undefined;
    requestOfflineToken?: Boolean | undefined;
    forceApprovalPrompt?: Boolean | undefined;
    redirectUrl?: string | undefined;
    loginHint?: string | undefined;
    loginStyle?: string | undefined;
  }

  type EnvironmentVariable<T = any> = import('./dynamics').EnvironmentVariable<T>;
}

const settings: Record<string, any> = {
  public: {},
};

// @ts-expect-error
const NODE_ENV = typeof process !== 'undefined' ? process.env.NODE_ENV : 'development';

export const Meteor = withAccounts(withLocalStorage({
  // Hardcoded environment flags for standard client builds
  settings,
  absoluteUrl,
  // --------------------
isProduction: NODE_ENV === "production",
  isDevelopment: NODE_ENV !== "production",
  
  // Demeteorized frontend is ALWAYS client, NEVER server or cordova
  isClient: true,
  isServer: false,
  isCordova: false,
  
  // Modern browser environment is assumed
  isModern: true,
  
  // Test environments
  isTest: NODE_ENV === "test",
  isAppTest: false,
  isPackageTest: false,
  
  // Dummy settings to maintain API surface
  release: "demeteorized",
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
    this.connection.call = value.bind(this.connection);
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
    this.connection.apply = value.bind(this.connection);
  },

  get applyAsync() {
    return this.connection.applyAsync.bind(this.connection);
  },
  set applyAsync(value) {
    this.connection.applyAsync = value.bind(this.connection);
  },

  get methods() {
    return this.connection.methods.bind(this.connection);
  },
  set methods(value) {
    this.connection.methods = value.bind(this.connection);
  },

  get subscribe() {
    return this.connection.subscribe.bind(this.connection);
  },
  set subscribe(value) {
    this.connection.subscribe = value.bind(this.connection);
  },

  get status() {
    return this.connection.status.bind(this.connection);
  },

  set status(value) {
    this.connection.status = value.bind(this.connection);
  },

  get reconnect() {
    return this.connection.reconnect.bind(this.connection);
  },

  set reconnect(value) {
    this.connection.reconnect = value.bind(this.connection);
  },

  get disconnect() {
    return this.connection.disconnect.bind(this.connection);
  },
  set disconnect(value) {
    this.connection.disconnect = value.bind(this.connection);
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
}));