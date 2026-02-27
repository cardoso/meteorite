import { DDPCommon } from 'meteor/ddp-common';
import { Tracker } from 'meteor/tracker';
import { EJSON } from 'meteor/ejson';
import { Random } from 'meteor/random';
import { DDP } from './namespace.js';
import { MethodInvoker } from './method-invoker.ts';
import { ConnectionStreamHandlers } from './connection-stream-handlers.ts';
import { MongoIDMap } from './mongo-id-map.ts';
import { MessageProcessors } from './message-processors.ts';
import { DocumentProcessors } from './document-processors.ts';
import { ClientStream } from 'meteor/socket-stream-client';

export type ConnectionOptions = {
  onConnected?: () => void;
  onDDPVersionNegotiationFailure?: (description: string) => void;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  npmFayeOptions?: Record<string, unknown>;
  reloadWithOutstanding?: boolean;
  supportedDDPVersions?: string[];
  retry?: boolean;
  respondToPings?: boolean;
  bufferedWritesInterval?: number;
  bufferedWritesMaxAge?: number;
  headers?: Record<string, string>;
  _sockjsOptions?: Record<string, unknown>;
  _dontPrintErrors?: boolean;
  connectTimeoutMs?: number;
};

export type OutstandingMethodBlock = {
  wait: boolean;
  methods: MethodInvoker[];
};

export class Connection {
  public options: ConnectionOptions;
  public onReconnect: (() => void) | null;
  public _stream: any;
  public _lastSessionId: string | null;
  public _versionSuggestion: string | null;
  public _version: string | null;
  public _stores: Record<string, any>;
  public _methodHandlers: Record<string, Function>;
  public _nextMethodId: number;
  public _supportedDDPVersions: string[];
  public _heartbeatInterval: number;
  public _heartbeatTimeout: number;
  public _methodInvokers: Record<string, MethodInvoker>;
  public _outstandingMethodBlocks: OutstandingMethodBlock[];
  public _documentsWrittenByStub: Record<string, any[]>;
  public _serverDocuments: Record<string, MongoIDMap>;
  public _afterUpdateCallbacks: Array<() => void>;
  public _messagesBufferedUntilQuiescence: any[];
  public _methodsBlockingQuiescence: Record<string, boolean>;
  public _subsBeingRevived: Record<string, boolean>;
  public _resetStores: boolean;
  public _updatesForUnknownStores: Record<string, any[]>;
  public _retryMigrate: (() => void) | null;
  public _bufferedWrites: Record<string, any[]>;
  public _bufferedWritesFlushAt: number | null;
  public _bufferedWritesFlushHandle: ReturnType<typeof setTimeout> | null;
  public _bufferedWritesInterval: number;
  public _bufferedWritesMaxAge: number;
  public _subscriptions: Record<string, any>;
  
  protected _userId: string | null;
  protected _userIdDeps: any;
  protected _streamHandlers: ConnectionStreamHandlers;
  protected _messageProcessors: MessageProcessors;
  protected _documentProcessors: DocumentProcessors;
  protected _heartbeat: any;
  public _liveDataWritesPromise?: Promise<void>;

  // Async Stub Queue State
  private _queueSize = 0;
  private _queue: Promise<any> = Promise.resolve();
  private _queueSend = false;
  private _currentMethodInvocation: any = null;

  constructor(url: string | object, options?: ConnectionOptions) {
    this.options = {
      onConnected: () => {},
      onDDPVersionNegotiationFailure: (description: string) => {
        console.debug(description);
      },
      heartbeatInterval: 17500,
      heartbeatTimeout: 15000,
      reloadWithOutstanding: false,
      supportedDDPVersions: DDPCommon.SUPPORTED_DDP_VERSIONS,
      retry: true,
      respondToPings: true,
      ...(options || {})
    };

    this.onReconnect = null;

    if (typeof url === 'object') {
      this._stream = url;
    } else {
      this._stream = new ClientStream(url, {
        retry: this.options.retry,
        ConnectionError: DDP.ConnectionError,
        headers: this.options.headers,
        // _sockjsOptions: this.options._sockjsOptions,
        _dontPrintErrors: this.options._dontPrintErrors,
        connectTimeoutMs: this.options.connectTimeoutMs
      });
    }

    this._lastSessionId = null;
    this._versionSuggestion = null;
    this._version = null;
    this._stores = Object.create(null);
    this._methodHandlers = Object.create(null);
    this._nextMethodId = 1;
    this._supportedDDPVersions = this.options.supportedDDPVersions || [];

    this._heartbeatInterval = this.options.heartbeatInterval ?? 17500;
    this._heartbeatTimeout = this.options.heartbeatTimeout ?? 15000;

    this._methodInvokers = Object.create(null);
    this._outstandingMethodBlocks = [];
    this._documentsWrittenByStub = Object.create(null);
    this._serverDocuments = Object.create(null);
    this._afterUpdateCallbacks = [];
    this._messagesBufferedUntilQuiescence = [];
    this._methodsBlockingQuiescence = Object.create(null);
    this._subsBeingRevived = Object.create(null);
    this._resetStores = false;
    this._updatesForUnknownStores = Object.create(null);
    this._retryMigrate = null;
    this._bufferedWrites = Object.create(null);
    this._bufferedWritesFlushAt = null;
    this._bufferedWritesFlushHandle = null;
    
    this._bufferedWritesInterval = this.options.bufferedWritesInterval ?? 5;
    this._bufferedWritesMaxAge = this.options.bufferedWritesMaxAge ?? 500;
    
    this._subscriptions = Object.create(null);

    this._userId = null;
    this._userIdDeps = new Tracker.Dependency();

    const Package = (typeof globalThis !== 'undefined' ? (globalThis as any).Package : null);
    if (Package?.reload && !this.options.reloadWithOutstanding) {
      Package.reload.Reload._onMigrate((retry: () => void) => {
        if (!this._readyToMigrate()) {
          this._retryMigrate = retry;
          return [false];
        } else {
          return [true];
        }
      });
    }

    this._streamHandlers = new ConnectionStreamHandlers(this);

    const onDisconnect = () => {
      if (this._heartbeat) {
        this._heartbeat.stop();
        this._heartbeat = null;
      }
    };

    this._stream.on('message', (msg: any) => this._streamHandlers.onMessage(msg));
    this._stream.on('reset', () => this._streamHandlers.onReset());
    this._stream.on('disconnect', onDisconnect);

    this._messageProcessors = new MessageProcessors(this);
    this._documentProcessors = new DocumentProcessors(this);
  }

  // --- Queue Helpers ---

  protected _queueFunction(fn: (resolve: any, reject: any) => void, promiseProps: any = {}): Promise<any> {
    this._queueSize += 1;

    let resolveFn: any;
    let rejectFn: any;
    
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    }) as any;

    this._queue = this._queue.finally(() => {
      fn(resolveFn, rejectFn);
      return promise.stubPromise?.catch(() => {});
    });

    promise
      .catch(() => {})
      .finally(() => {
        this._queueSize -= 1;
        if (this._queueSize === 0) {
          this._maybeMigrate();
        }
      });

    promise.stubPromise = promiseProps.stubPromise;
    promise.serverPromise = promiseProps.serverPromise;

    return promise;
  }

  // --- Processors ---

  public _livedata_connected(msg: any): Promise<void> {
    return this._messageProcessors._livedata_connected(msg);
  }

  public _livedata_data(msg: any): Promise<void> {
    return this._messageProcessors._livedata_data(msg);
  }

  public _livedata_nosub(msg: any): Promise<void> {
    return this._messageProcessors._livedata_nosub(msg);
  }

  public _livedata_result(msg: any): Promise<void> {
    return this._messageProcessors._livedata_result(msg);
  }

  public _livedata_error(msg: any): void {
    return this._messageProcessors._livedata_error(msg);
  }

  public _process_added(msg: any, updates: any): Promise<void> {
    return this._documentProcessors._process_added(msg, updates);
  }

  public _process_changed(msg: any, updates: any): void {
    return this._documentProcessors._process_changed(msg, updates);
  }

  public _process_removed(msg: any, updates: any): void {
    return this._documentProcessors._process_removed(msg, updates);
  }

  public _process_ready(msg: any, updates: any): void {
    return this._documentProcessors._process_ready(msg, updates);
  }

  public _process_updated(msg: any, updates: any): void {
    return this._documentProcessors._process_updated(msg, updates);
  }

  public _pushUpdate(updates: any, collection: string, msg: any): void {
    return this._documentProcessors._pushUpdate(updates, collection, msg);
  }

  public _getServerDoc(collection: string, id: string): any {
    return this._documentProcessors._getServerDoc(collection, id);
  }

  public createStoreMethods(name: string, wrappedStore: any): any {
    if (name in this._stores) return false;

    const store = Object.create(null);
    const keysOfStore = [
      'update',
      'beginUpdate',
      'endUpdate',
      'saveOriginals',
      'retrieveOriginals',
      'getDoc',
      '_getCollection'
    ];
    
    keysOfStore.forEach((method) => {
      store[method] = (...args: any[]) => {
        if (wrappedStore[method]) {
          return wrappedStore[method](...args);
        }
      };
    });
    
    this._stores[name] = store;
    return store;
  }

  public registerStoreClient(name: string, wrappedStore: any): boolean {
    const store = this.createStoreMethods(name, wrappedStore);
    const queued = this._updatesForUnknownStores[name];
    
    if (Array.isArray(queued)) {
      store.beginUpdate(queued.length, false);
      queued.forEach(msg => store.update(msg));
      store.endUpdate();
      delete this._updatesForUnknownStores[name];
    }

    return true;
  }

  // --- Subscriptions ---

  public subscribe(name: string, ...args: any[]): any {
    if (this._stream._neverQueued) {
      return this._baseSubscribe(name, ...args);
    }

    this._queueSend = true;
    try {
      return this._baseSubscribe(name, ...args);
    } finally {
      this._queueSend = false;
    }
  }

  protected _baseSubscribe(name: string, ...args: any[]): any {
    const params = [...args];
    let callbacks: Record<string, any> = Object.create(null);
    
    if (params.length) {
      const lastParam = params[params.length - 1];
      if (typeof lastParam === 'function') {
        callbacks.onReady = params.pop();
      } else if (lastParam && [
        lastParam.onReady,
        lastParam.onError,
        lastParam.onStop
      ].some(f => typeof f === "function")) {
        callbacks = params.pop();
      }
    }

    const existing = Object.values(this._subscriptions).find(
      sub => (sub.inactive && sub.name === name && EJSON.equals(sub.params, params))
    );

    let id: string;
    if (existing) {
      id = existing.id;
      existing.inactive = false; 

      if (callbacks.onReady) {
        if (existing.ready) {
          callbacks.onReady();
        } else {
          existing.readyCallback = callbacks.onReady;
        }
      }

      if (callbacks.onError) {
        existing.errorCallback = callbacks.onError;
      }

      if (callbacks.onStop) {
        existing.stopCallback = callbacks.onStop;
      }
    } else {
      id = Random.id();
      this._subscriptions[id] = {
        id: id,
        name: name,
        params: EJSON.clone(params),
        inactive: false,
        ready: false,
        readyDeps: new Tracker.Dependency(),
        readyCallback: callbacks.onReady,
        errorCallback: callbacks.onError,
        stopCallback: callbacks.onStop,
        connection: this,
        remove() {
          delete this.connection._subscriptions[this.id];
          this.ready && this.readyDeps.changed();
        },
        stop() {
          this.connection._sendQueued({ msg: 'unsub', id: id });
          this.remove();
          if (callbacks.onStop) {
            callbacks.onStop();
          }
        }
      };
      this._send({ msg: 'sub', id: id, name: name, params: params });
    }

    const handle = {
      stop: () => {
        if (!Object.prototype.hasOwnProperty.call(this._subscriptions, id)) return;
        this._subscriptions[id].stop();
      },
      ready: () => {
        if (!Object.prototype.hasOwnProperty.call(this._subscriptions, id)) return false;
        const record = this._subscriptions[id];
        record.readyDeps.depend();
        return record.ready;
      },
      subscriptionId: id
    };

    if (Tracker.active) {
      Tracker.onInvalidate(() => {
        if (Object.prototype.hasOwnProperty.call(this._subscriptions, id)) {
          this._subscriptions[id].inactive = true;
        }
        Tracker.afterFlush(() => {
          if (Object.prototype.hasOwnProperty.call(this._subscriptions, id) &&
              this._subscriptions[id].inactive) {
            handle.stop();
          }
        });
      });
    }

    return handle;
  }

  // --- Methods ---

  public isAsyncCall(): boolean {
    return DDP._CurrentMethodInvocation._isCallAsyncMethodRunning();
  }

  public methods(methods: Record<string, Function>): void {
    Object.entries(methods).forEach(([name, func]) => {
      if (typeof func !== 'function') {
        throw new Error(`Method '${name}' must be a function`);
      }
      if (this._methodHandlers[name]) {
        throw new Error(`A method named '${name}' is already defined`);
      }
      this._methodHandlers[name] = func;
    });
  }

  protected _getIsSimulation(options: { isFromCallAsync?: boolean, alreadyInSimulation?: boolean }): boolean {
    if (!options.isFromCallAsync) {
      return !!options.alreadyInSimulation;
    }
    return !!options.alreadyInSimulation && DDP._CurrentMethodInvocation._isCallAsyncMethodRunning();
  }

  public call(name: string, ...args: any[]): any {
    let callback;
    if (args.length && typeof args[args.length - 1] === 'function') {
      callback = args.pop();
    }
    return this.apply(name, args, callback);
  }

  public callAsync(name: string, ...args: any[]): Promise<any> {
    if (args.length && typeof args[args.length - 1] === 'function') {
      throw new Error("Meteor.callAsync() does not accept a callback. You should 'await' the result, or use .then().");
    }
    return this.applyAsync(name, args, { returnServerResultPromise: true });
  }

  public apply(name: string, args: any[], options?: any, callback?: any): any {
    if (this._stream._neverQueued) {
      return this._baseApply(name, args, options, callback);
    }

    if (!callback && typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    const { methodInvoker, result } = this._baseApply(name, args, {
      ...options,
      _returnMethodInvoker: true,
    }, callback);

    if (methodInvoker) {
      this._queueFunction((resolve) => {
        this._addOutstandingMethod(methodInvoker, options);
        resolve(undefined);
      });
    }

    return result;
  }

  protected _baseApply(name: string, args: any[], options?: any, callback?: any): any {
    const { stubInvocation, invocation, ...stubOptions } = this._stubCall(name, EJSON.clone(args));

    if (stubOptions.hasStub) {
      if (!this._getIsSimulation({
          alreadyInSimulation: stubOptions.alreadyInSimulation,
          isFromCallAsync: stubOptions.isFromCallAsync,
        })) {
        this._saveOriginals();
      }
      try {
        stubOptions.stubReturnValue = DDP._CurrentMethodInvocation.withValue(invocation, stubInvocation);
        if (stubOptions.stubReturnValue && typeof stubOptions.stubReturnValue.then === 'function') {
          console.warn(`Method ${name}: Calling a method that has an async method stub with call/apply can lead to unexpected behaviors. Use callAsync/applyAsync instead.`);
        }
      } catch (e) {
        stubOptions.exception = e;
      }
    }
    return this._apply(name, stubOptions, args, options, callback);
  }

  public applyAsync(name: string, args: any[], options?: any, callback: any = null): any {
    if (this._currentMethodInvocation) {
      DDP._CurrentMethodInvocation._set(this._currentMethodInvocation);
      this._currentMethodInvocation = null;
    }

    const enclosing = DDP._CurrentMethodInvocation.get();
    const alreadyInSimulation = enclosing?.isSimulation;
    const isFromCallAsync = enclosing?._isFromCallAsync;

    if (
      this._getIsSimulation({
        isFromCallAsync,
        alreadyInSimulation,
      })
    ) {
      return this._baseApplyAsync(name, args, options, callback);
    }

    let stubPromiseResolver: any;
    let serverPromiseResolver: any;
    
    const stubPromise = new Promise((r) => (stubPromiseResolver = r));
    const serverPromise = new Promise((r) => (serverPromiseResolver = r));

    return this._queueFunction(
      (resolve, reject) => {
        let finished = false;

        setTimeout(() => {
          const applyAsyncPromise = this._baseApplyAsync(name, args, options, callback);
          stubPromiseResolver(applyAsyncPromise.stubPromise);
          serverPromiseResolver(applyAsyncPromise.serverPromise);

          applyAsyncPromise.stubPromise
            .catch(() => {})
            .finally(() => {
              finished = true;
            });

          applyAsyncPromise
            .then((result: any) => resolve(result))
            .catch((err: any) => reject(err));

          serverPromise.catch(() => {});
        }, 0);

        setTimeout(() => {
          if (!finished) {
            console.warn(`Method stub (${name}) took too long and could cause unexpected problems.`);
          }
        }, 0);
      },
      {
        stubPromise,
        serverPromise,
      }
    );
  }

  protected _baseApplyAsync(name: string, args: any[], options?: any, callback: any = null): any {
    const stubPromise = this._applyAsyncStubInvocation(name, args, options);
    const promise: any = this._applyAsync({ name, args, options, callback, stubPromise });
    
    promise.stubPromise = stubPromise.then((o: any) => {
      if (o.exception) throw o.exception;
      return o.stubReturnValue;
    });
    
    promise.serverPromise = new Promise((resolve, reject) =>
      promise.then(resolve).catch(reject)
    );
    
    return promise;
  }

  protected async _applyAsyncStubInvocation(name: string, args: any[], options?: any): Promise<any> {
    const { stubInvocation, invocation, ...stubOptions } = this._stubCall(name, EJSON.clone(args), options);
    
    if (stubOptions.hasStub) {
      if (!this._getIsSimulation({
          alreadyInSimulation: stubOptions.alreadyInSimulation,
          isFromCallAsync: stubOptions.isFromCallAsync,
        })) {
        this._saveOriginals();
      }
      try {
        const currentContext = DDP._CurrentMethodInvocation._setNewContextAndGetCurrent(invocation);
        try {
          stubOptions.stubReturnValue = await stubInvocation();
        } catch (e) {
          stubOptions.exception = e;
        } finally {
          DDP._CurrentMethodInvocation._set(currentContext);
        }
      } catch (e) {
        stubOptions.exception = e;
      }
    }
    return stubOptions;
  }

  protected async _applyAsync({ name, args, options, callback, stubPromise }: any): Promise<any> {
    const stubOptions = await stubPromise;
    return this._apply(name, stubOptions, args, options, callback);
  }

  protected _apply(name: string, stubCallValue: any, args: any[], options: any, callback: any): any {
    if (!callback && typeof options === 'function') {
      callback = options;
      options = Object.create(null);
    }
    options = options || Object.create(null);

    const MeteorBindEnvironment = (typeof globalThis !== 'undefined' && (globalThis as any).Meteor?.bindEnvironment) || ((f: any) => f);
    
    if (callback) {
      callback = MeteorBindEnvironment(callback, `delivering result of invoking '${name}'`);
    }

    const { hasStub, exception, stubReturnValue, alreadyInSimulation, randomSeed } = stubCallValue;
    args = EJSON.clone(args);

    if (this._getIsSimulation({
        alreadyInSimulation,
        isFromCallAsync: stubCallValue.isFromCallAsync,
      })) {
      let result;
      if (callback) {
        callback(exception, stubReturnValue);
      } else {
        if (exception) throw exception;
        result = stubReturnValue;
      }
      return options._returnMethodInvoker ? { result } : result;
    }

    const methodId = '' + this._nextMethodId++;
    if (hasStub) {
      this._retrieveAndStoreOriginals(methodId);
    }

    const message: any = {
      msg: 'method',
      id: methodId,
      method: name,
      params: args
    };

    if (exception) {
      if (options.throwStubExceptions) {
        throw exception;
      } else if (!exception._expectedByTest) {
        console.warn(`Exception while simulating the effect of invoking '${name}'`, exception);
      }
    }

    let promise;
    if (!callback) {
      if (!options.returnServerResultPromise && (!options.isFromCallAsync || options.returnStubValue)) {
        callback = (err: any) => {
          if (err) console.warn(`Error invoking Method '${name}'`, err);
        };
      } else {
        promise = new Promise((resolve, reject) => {
          callback = (...allArgs: any[]) => {
            const err = allArgs.shift();
            if (err) {
              reject(err);
              return;
            }
            resolve(allArgs[0]);
          };
        });
      }
    }

    if (randomSeed.value !== null) {
      message.randomSeed = randomSeed.value;
    }

    const methodInvoker = new MethodInvoker({
      methodId,
      callback: callback,
      connection: this,
      onResultReceived: options.onResultReceived,
      wait: !!options.wait,
      message: message,
      noRetry: !!options.noRetry
    });

    let result;
    if (promise) {
      result = options.returnStubValue ? promise.then(() => stubReturnValue) : promise;
    } else {
      result = options.returnStubValue ? stubReturnValue : undefined;
    }

    if (options._returnMethodInvoker) {
      return { methodInvoker, result };
    }

    this._addOutstandingMethod(methodInvoker, options);
    return result;
  }

  protected _stubCall(name: string, args: any[], options?: any): any {
    const enclosing = DDP._CurrentMethodInvocation.get();
    const stub = this._methodHandlers[name];
    const alreadyInSimulation = enclosing?.isSimulation;
    const isFromCallAsync = enclosing?._isFromCallAsync;
    const randomSeed = { value: null as string | null };

    const defaultReturn = {
      alreadyInSimulation,
      randomSeed,
      isFromCallAsync,
    };

    if (!stub) {
      return { ...defaultReturn, hasStub: false };
    }

    const randomSeedGenerator = () => {
      if (randomSeed.value === null) {
        randomSeed.value = DDPCommon.makeRpcSeed(enclosing, name);
      }
      return randomSeed.value;
    };

    const invocation = new DDPCommon.MethodInvocation({
      name,
      isSimulation: true,
      userId: this.userId(),
      isFromCallAsync: options?.isFromCallAsync,
      setUserId: (userId: string | null) => this.setUserId(userId),
      randomSeed: () => randomSeedGenerator()
    });

    const stubInvocation = () => {
      return stub.apply(invocation, EJSON.clone(args));
    };

    return { ...defaultReturn, hasStub: true, stubInvocation, invocation };
  }

  protected _saveOriginals(): void {
    if (!this._waitingForQuiescence()) {
      this._flushBufferedWrites();
    }
    Object.values(this._stores).forEach((store: any) => store.saveOriginals());
  }

  protected _retrieveAndStoreOriginals(methodId: string): void {
    if (this._documentsWrittenByStub[methodId]) {
      throw new Error('Duplicate methodId in _retrieveAndStoreOriginals');
    }

    const docsWritten: any[] = [];

    Object.entries(this._stores).forEach(([collection, store]) => {
      const originals = store.retrieveOriginals();
      if (!originals) return;
      
      originals.forEach((doc: any, id: string) => {
        docsWritten.push({ collection, id });
        if (!Object.prototype.hasOwnProperty.call(this._serverDocuments, collection)) {
          this._serverDocuments[collection] = new MongoIDMap();
        }
        
        const serverDoc = this._serverDocuments[collection].setDefault(id, Object.create(null));
        
        if (serverDoc.writtenByStubs) {
          serverDoc.writtenByStubs[methodId] = true;
        } else {
          serverDoc.document = doc;
          serverDoc.flushCallbacks = [];
          serverDoc.writtenByStubs = Object.create(null);
          serverDoc.writtenByStubs[methodId] = true;
        }
      });
    });

    if (docsWritten.length > 0) {
      this._documentsWrittenByStub[methodId] = docsWritten;
    }
  }

  // --- Network ---

  public _unsubscribeAll(): void {
    Object.values(this._subscriptions).forEach((sub: any) => {
      if (sub.name !== 'meteor_autoupdate_clientVersions') {
        sub.stop();
      }
    });
  }

  public _send(obj: any, shouldQueue: boolean = false): void {
    if (this._stream._neverQueued) {
      return this._baseSend(obj);
    }

    if (!this._queueSend && !shouldQueue) {
      return this._baseSend(obj);
    }

    this._queueSend = false;
    this._queueFunction((resolve) => {
      try {
        this._baseSend(obj);
      } finally {
        resolve(undefined);
      }
    });
  }

  protected _baseSend(obj: any): void {
    this._stream.send(DDPCommon.stringifyDDP(obj));
  }

  public _sendQueued(obj: any): void {
    this._send(obj, true);
  }

  public _lostConnection(error: Error): void {
    this._stream._lostConnection(error);
  }

  public status(...args: any[]): any {
    return this._stream.status(...args);
  }

  public reconnect(...args: any[]): void {
    return this._stream.reconnect(...args);
  }

  public disconnect(...args: any[]): void {
    return this._stream.disconnect(...args);
  }

  public close(): void {
    return this._stream.disconnect({ _permanent: true });
  }

  public userId(): string | null {
    if (this._userIdDeps) this._userIdDeps.depend();
    return this._userId;
  }

  public setUserId(userId: string | null): void {
    if (this._userId === userId) return;
    this._userId = userId;
    if (this._userIdDeps) this._userIdDeps.changed();
  }

  // --- Flush & Quiescence ---

  public _waitingForQuiescence(): boolean {
    return (
      Object.keys(this._subsBeingRevived).length > 0 ||
      Object.keys(this._methodsBlockingQuiescence).length > 0
    );
  }

  protected _anyMethodsAreOutstanding(): boolean {
    return Object.values(this._methodInvokers).some((invoker) => !!invoker.sentMessage);
  }

  protected _prepareBuffersToFlush(): Record<string, any[]> {
    if (this._bufferedWritesFlushHandle) {
      clearTimeout(this._bufferedWritesFlushHandle);
      this._bufferedWritesFlushHandle = null;
    }

    this._bufferedWritesFlushAt = null;
    const writes = this._bufferedWrites;
    this._bufferedWrites = Object.create(null);
    return writes;
  }

  protected _performWritesClient(updates: Record<string, any[]>): void {
    if (this._resetStores || Object.keys(updates).length > 0) {
      Object.values(this._stores).forEach(store => {
        store.beginUpdate(updates[store._name]?.length || 0, this._resetStores);
      });

      this._resetStores = false;

      Object.entries(updates).forEach(([storeName, messages]) => {
        const store = this._stores[storeName];
        if (store) {
          messages.forEach(msg => store.update(msg));
        } else {
          this._updatesForUnknownStores[storeName] = this._updatesForUnknownStores[storeName] || [];
          this._updatesForUnknownStores[storeName].push(...messages);
        }
      });

      Object.values(this._stores).forEach(store => store.endUpdate());
    }
    this._runAfterUpdateCallbacks();
  }

  public async _flushBufferedWrites(): Promise<void> {
    const writes = this._prepareBuffersToFlush();
    this._performWritesClient(writes);
  }

  public _runAfterUpdateCallbacks(): void {
    const callbacks = this._afterUpdateCallbacks;
    this._afterUpdateCallbacks = [];
    callbacks.forEach((c) => c());
  }

  public _runWhenAllServerDocsAreFlushed(f: () => void): void {
    const runFAfterUpdates = () => {
      this._afterUpdateCallbacks.push(f);
    };
    
    let unflushedServerDocCount = 0;
    const onServerDocFlush = () => {
      --unflushedServerDocCount;
      if (unflushedServerDocCount === 0) {
        runFAfterUpdates();
      }
    };

    Object.values(this._serverDocuments).forEach((serverDocuments) => {
      serverDocuments.forEach((serverDoc: any) => {
        const writtenByStubForAMethodWithSentMessage = Object.keys(serverDoc.writtenByStubs).some(methodId => {
          const invoker = this._methodInvokers[methodId];
          return invoker && invoker.sentMessage;
        });

        if (writtenByStubForAMethodWithSentMessage) {
          ++unflushedServerDocCount;
          serverDoc.flushCallbacks.push(onServerDocFlush);
        }
      });
    });

    if (unflushedServerDocCount === 0) {
      runFAfterUpdates();
    }
  }

  public _addOutstandingMethod(methodInvoker: MethodInvoker, options?: any): void {
    if (options?.wait) {
      this._outstandingMethodBlocks.push({
        wait: true,
        methods: [methodInvoker]
      });
    } else {
      if (this._outstandingMethodBlocks.length === 0 || 
          this._outstandingMethodBlocks[this._outstandingMethodBlocks.length - 1].wait) {
        this._outstandingMethodBlocks.push({
          wait: false,
          methods: [],
        });
      }
      this._outstandingMethodBlocks[this._outstandingMethodBlocks.length - 1].methods.push(methodInvoker);
    }

    if (this._outstandingMethodBlocks.length === 1) {
      methodInvoker.sendMessage();
    }
  }

  public _outstandingMethodFinished(): void {
    if (this._anyMethodsAreOutstanding()) return;

    if (this._outstandingMethodBlocks.length > 0) {
      const firstBlock = this._outstandingMethodBlocks.shift()!;
      if (firstBlock.methods.length > 0) {
        throw new Error(`No methods outstanding but nonempty block: ${JSON.stringify(firstBlock)}`);
      }

      if (this._outstandingMethodBlocks.length > 0) {
        this._sendOutstandingMethods();
      }
    }

    this._maybeMigrate();
  }

  protected _sendOutstandingMethods(): void {
    if (this._outstandingMethodBlocks.length === 0) return;

    this._outstandingMethodBlocks[0].methods.forEach(m => {
      m.sendMessage();
    });
  }

  public _sendOutstandingMethodBlocksMessages(oldOutstandingMethodBlocks: OutstandingMethodBlock[]): void {
    if (this._stream._neverQueued) {
      return this._baseSendOutstandingMethodBlocksMessages(oldOutstandingMethodBlocks);
    }
    this._queueFunction((resolve) => {
      try {
        this._baseSendOutstandingMethodBlocksMessages(oldOutstandingMethodBlocks);
      } finally {
        resolve(undefined);
      }
    });
  }

  protected _baseSendOutstandingMethodBlocksMessages(oldOutstandingMethodBlocks: OutstandingMethodBlock[]): void {
    if (oldOutstandingMethodBlocks.length === 0) return;

    if (this._outstandingMethodBlocks.length === 0) {
      this._outstandingMethodBlocks = oldOutstandingMethodBlocks;
      this._sendOutstandingMethods();
      return;
    }

    if (!this._outstandingMethodBlocks[this._outstandingMethodBlocks.length - 1].wait &&
        !oldOutstandingMethodBlocks[0].wait) {
      oldOutstandingMethodBlocks[0].methods.forEach((m) => {
        this._outstandingMethodBlocks[this._outstandingMethodBlocks.length - 1].methods.push(m);

        if (this._outstandingMethodBlocks.length === 1) {
          m.sendMessage();
        }
      });
      oldOutstandingMethodBlocks.shift();
    }

    this._outstandingMethodBlocks.push(...oldOutstandingMethodBlocks);
  }

  public _callOnReconnectAndSendAppropriateOutstandingMethods(): void {
    const oldOutstandingMethodBlocks = this._outstandingMethodBlocks;
    this._outstandingMethodBlocks = [];

    if (this.onReconnect) this.onReconnect();
    
    DDP._reconnectHook.each((callback: Function) => {
      callback(this);
      return true;
    });

    this._sendOutstandingMethodBlocksMessages(oldOutstandingMethodBlocks);
  }

  public _readyToMigrate(): boolean {
    if (this._queueSize > 0) {
      return false;
    }
    return Object.keys(this._methodInvokers).length === 0;
  }

  public _maybeMigrate(): void {
    if (this._retryMigrate && this._readyToMigrate()) {
      this._retryMigrate();
      this._retryMigrate = null;
    }
  }
}