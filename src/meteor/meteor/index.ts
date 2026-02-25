import { MeteorError } from './errors';
import { EnvironmentVariable, bindEnvironment } from './dynamics';
import { defer, setTimeoutWrapped, setIntervalWrapped, clearTimeoutWrapped, clearIntervalWrapped } from './timers';
import { _debug } from './debug';
import { AsynchronousQueue, SynchronousQueue } from './queues';
import { startup } from './startup';

export const Meteor = {
  // Hardcoded environment flags for standard client builds
  isClient: true,
  isServer: false,
  isCordova: false,
  
  Error: MeteorError,
  
  EnvironmentVariable,
  bindEnvironment,
  
  defer,
  setTimeout: setTimeoutWrapped,
  setInterval: setIntervalWrapped,
  clearTimeout: clearTimeoutWrapped,
  clearInterval: clearIntervalWrapped,
  
  _AsynchronousQueue: AsynchronousQueue,
  _SynchronousQueue: SynchronousQueue,
  
  _debug,
  startup,
  
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