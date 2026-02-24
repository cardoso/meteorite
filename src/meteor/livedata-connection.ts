import { EJSON } from './ejson';
import { Tracker } from './tracker'; // Assumes modern Tracker
import { Random } from './random';
import { MethodInvoker } from './method-invoker.ts';
import { Heartbeat, RandomStream, MethodInvocation, parseDDP, stringifyDDP, hasOwn, isEmpty, last, SUPPORTED_DDP_VERSIONS } from './ddp-common.core';
import { ClientStream } from './socket-stream-client'; 
import { applyChanges } from './diff-sequence.core';

export type ConnectionOptions = {
  onConnected?: () => void;
  onDDPVersionNegotiationFailure?: (description: string) => void;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  npmFayeOptions?: Record<string, any>;
  reloadWithOutstanding?: boolean;
  supportedDDPVersions?: string[];
  retry?: boolean;
  respondToPings?: boolean;
  bufferedWritesInterval?: number;
  bufferedWritesMaxAge?: number;
  headers?: Record<string, string>;
  _sockjsOptions?: any;
  _dontPrintErrors?: boolean;
  connectTimeoutMs?: number;
};

export class Connection {
  public options: ConnectionOptions;
  public onReconnect: (() => void) | null;
  
  private _stream: any;
  private _lastSessionId: string | null = null;
  private _versionSuggestion: string | null = null;
  private _version: string | null = null;
  private _stores: Record<string, any> = Object.create(null);
  private _methodHandlers: Record<string, Function> = Object.create(null);
  private _nextMethodId: number = 1;
  private _supportedDDPVersions: string[];
  private _heartbeatInterval: number;
  private _heartbeatTimeout: number;
  private _heartbeat: Heartbeat | null = null;

  public _methodInvokers: Record<string, MethodInvoker> = Object.create(null);
  private _outstandingMethodBlocks: Array<{ wait: boolean; methods: MethodInvoker[] }> = [];
  private _documentsWrittenByStub: Record<string, any[]> = {};
  private _serverDocuments: Record<string, any> = {};
  private _afterUpdateCallbacks: Array<() => void> = [];
  
  private _messagesBufferedUntilQuiescence: any[] = [];
  public _methodsBlockingQuiescence: Record<string, boolean> = {};
  private _subsBeingRevived: Record<string, boolean> = {};
  private _resetStores: boolean = false;
  private _updatesForUnknownStores: Record<string, any[]> = {};
  
  private _retryMigrate: (() => void) | null = null;
  private _bufferedWrites: Record<string, any[]> = {};
  private _bufferedWritesFlushAt: number | null = null;
  private _bufferedWritesFlushHandle: ReturnType<typeof setTimeout> | null = null;
  private _bufferedWritesInterval: number;
  private _bufferedWritesMaxAge: number;
  
  public _subscriptions: Record<string, any> = {};
  private _userId: string | null = null;
  private _userIdDeps: Tracker.Dependency = new Tracker.Dependency();
  private _liveDataWritesPromise?: Promise<void>;

  constructor(url: string | object, options?: ConnectionOptions) {
    this.options = {
      onConnected: () => {},
      onDDPVersionNegotiationFailure: (description: string) => console.debug(description),
      heartbeatInterval: 17500,
      heartbeatTimeout: 15000,
      npmFayeOptions: Object.create(null),
      reloadWithOutstanding: false,
      supportedDDPVersions: SUPPORTED_DDP_VERSIONS,
      retry: true,
      respondToPings: true,
      bufferedWritesInterval: 5,
      bufferedWritesMaxAge: 500,
      ...options
    };

    this.onReconnect = null;
    this._supportedDDPVersions = this.options.supportedDDPVersions!;
    this._heartbeatInterval = this.options.heartbeatInterval!;
    this._heartbeatTimeout = this.options.heartbeatTimeout!;
    this._bufferedWritesInterval = this.options.bufferedWritesInterval!;
    this._bufferedWritesMaxAge = this.options.bufferedWritesMaxAge!;

    if (typeof url === 'object') {
      this._stream = url;
    } else {
      this._stream = new ClientStream(url, {
        retry: this.options.retry,
        headers: this.options.headers,
        _sockjsOptions: this.options._sockjsOptions,
        _dontPrintErrors: this.options._dontPrintErrors,
        connectTimeoutMs: this.options.connectTimeoutMs,
        npmFayeOptions: this.options.npmFayeOptions
      });
    }

    const onDisconnect = () => {
      if (this._heartbeat) {
        this._heartbeat.stop();
        this._heartbeat = null;
      }
    };

    this._stream.on('message', (msg: string) => this.onMessage(msg));
    this._stream.on('reset', () => this.onReset());
    this._stream.on('disconnect', onDisconnect);
  }

  // --- External API ---

  status(...args: any[]): any { return this._stream.status(...args); }
  reconnect(...args: any[]): void { return this._stream.reconnect(...args); }
  disconnect(...args: any[]): void { return this._stream.disconnect(...args); }
  close(): void { return this._stream.disconnect({ _permanent: true }); }

  userId(): string | null {
    this._userIdDeps.depend();
    return this._userId;
  }

  setUserId(userId: string | null): void {
    if (this._userId === userId) return;
    this._userId = userId;
    this._userIdDeps.changed();
  }

  // --- Store Management ---

  createStoreMethods(name: string, wrappedStore: any) {
    if (name in this._stores) return false;

    const store: any = Object.create(null);
    const keysOfStore = [
      'update', 'beginUpdate', 'endUpdate',
      'saveOriginals', 'retrieveOriginals',
      'getDoc', '_getCollection'
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

  registerStoreClient(name: string, wrappedStore: any) {
    const store = this.createStoreMethods(name, wrappedStore);
    if (!store) return false;

    const queued = this._updatesForUnknownStores[name];
    if (Array.isArray(queued)) {
      store.beginUpdate(queued.length, false);
      queued.forEach(msg => store.update(msg));
      store.endUpdate();
      delete this._updatesForUnknownStores[name];
    }
    return true;
  }

  async registerStoreServer(name: string, wrappedStore: any) {
    const store = this.createStoreMethods(name, wrappedStore);
    if (!store) return false;

    const queued = this._updatesForUnknownStores[name];
    if (Array.isArray(queued)) {
      await store.beginUpdate(queued.length, false);
      for (const msg of queued) {
        await store.update(msg);
      }
      await store.endUpdate();
      delete this._updatesForUnknownStores[name];
    }
    return true;
  }

  // --- Pub/Sub ---

  subscribe(name: string, ...args: any[]) {
    const params = args.slice();
    let callbacks: any = Object.create(null);
    
    if (params.length) {
      const lastParam = params[params.length - 1];
      if (typeof lastParam === 'function') {
        callbacks.onReady = params.pop();
      } else if (lastParam && [lastParam.onReady, lastParam.onError, lastParam.onStop].some(f => typeof f === 'function')) {
        callbacks = params.pop();
      }
    }

    const existing = Object.values(this._subscriptions).find(
      (sub: any) => sub.inactive && sub.name === name && EJSON.equals(sub.params, params)
    );

    let id: string;
    if (existing) {
      id = existing.id;
      existing.inactive = false;

      if (callbacks.onReady) {
        if (existing.ready) callbacks.onReady();
        else existing.readyCallback = callbacks.onReady;
      }
      if (callbacks.onError) existing.errorCallback = callbacks.onError;
      if (callbacks.onStop) existing.stopCallback = callbacks.onStop;
    } else {
      id = Random.id();
      this._subscriptions[id] = {
        id,
        name,
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
          if (this.ready) this.readyDeps.changed();
        },
        stop() {
          this.connection._sendQueued({ msg: 'unsub', id });
          this.remove();
          if (callbacks.onStop) callbacks.onStop();
        }
      };
      this._send({ msg: 'sub', id, name, params });
    }

    const handle = {
      stop: () => {
        if (hasOwn.call(this._subscriptions, id)) {
          this._subscriptions[id].stop();
        }
      },
      ready: () => {
        if (!hasOwn.call(this._subscriptions, id)) return false;
        const record = this._subscriptions[id];
        record.readyDeps.depend();
        return record.ready;
      },
      subscriptionId: id
    };

    if (Tracker.active) {
      Tracker.onInvalidate(() => {
        if (hasOwn.call(this._subscriptions, id)) {
          this._subscriptions[id].inactive = true;
        }
        Tracker.afterFlush(() => {
          if (hasOwn.call(this._subscriptions, id) && this._subscriptions[id].inactive) {
            handle.stop();
          }
        });
      });
    }

    return handle;
  }

  // --- Methods ---

  methods(methods: Record<string, Function>) {
    Object.entries(methods).forEach(([name, func]) => {
      if (typeof func !== 'function') throw new Error(`Method '${name}' must be a function`);
      if (this._methodHandlers[name]) throw new Error(`A method named '${name}' is already defined`);
      this._methodHandlers[name] = func;
    });
  }

  call(name: string, ...args: any[]) {
    let callback;
    if (args.length && typeof args[args.length - 1] === 'function') {
      callback = args.pop();
    }
    return this.apply(name, args, undefined, callback);
  }

  callAsync(name: string, ...args: any[]) {
    if (args.length && typeof args[args.length - 1] === 'function') {
      throw new Error("callAsync() does not accept a callback. You should 'await' the result, or use .then().");
    }
    return this.applyAsync(name, args, { returnServerResultPromise: true });
  }

  apply(name: string, args: any[], options?: any, callback?: Function) {
    if (!callback && typeof options === 'function') {
      callback = options;
      options = Object.create(null);
    }
    options = options || Object.create(null);

    const stubCallValue = this._stubCall(name, EJSON.clone(args), options);
    let { stubInvocation, hasStub, exception, stubReturnValue, alreadyInSimulation } = stubCallValue as any;

    if (hasStub) {
      if (!this._getIsSimulation({ alreadyInSimulation, isFromCallAsync: options.isFromCallAsync })) {
        this._saveOriginals();
      }
      try {
        stubReturnValue = stubInvocation();
      } catch (e) {
        exception = e;
      }
    }
    
    stubCallValue.exception = exception;
    stubCallValue.stubReturnValue = stubReturnValue;

    return this._apply(name, stubCallValue, args, options, callback);
  }

  applyAsync(name: string, args: any[], options?: any, callback: Function | null = null) {
    const stubPromise = this._applyAsyncStubInvocation(name, args, options);
    
    const promise: any = stubPromise.then(stubOptions => {
       return this._apply(name, stubOptions, args, options, callback || undefined);
    });

    promise.stubPromise = stubPromise.then((o: any) => {
      if (o.exception) throw o.exception;
      return o.stubReturnValue;
    });
    promise.serverPromise = new Promise((resolve, reject) => promise.then(resolve).catch(reject));

    return promise;
  }

  private async _applyAsyncStubInvocation(name: string, args: any[], options?: any) {
    const stubOptions: any = this._stubCall(name, EJSON.clone(args), options);
    if (stubOptions.hasStub) {
      if (!this._getIsSimulation({ alreadyInSimulation: stubOptions.alreadyInSimulation, isFromCallAsync: stubOptions.isFromCallAsync })) {
        this._saveOriginals();
      }
      try {
        stubOptions.stubReturnValue = await stubOptions.stubInvocation();
      } catch(e) {
        stubOptions.exception = e;
      }
    }
    return stubOptions;
  }

  private _apply(name: string, stubCallValue: any, args: any[], options: any, callback?: Function) {
    const { hasStub, exception, stubReturnValue, alreadyInSimulation, randomSeed } = stubCallValue;
    args = EJSON.clone(args);

    if (this._getIsSimulation({ alreadyInSimulation, isFromCallAsync: stubCallValue.isFromCallAsync })) {
      let result;
      if (callback) {
        callback(exception, stubReturnValue);
      } else {
        if (exception) throw exception;
        result = stubReturnValue;
      }
      return options._returnMethodInvoker ? { result } : result;
    }

    const methodId = '' + (this._nextMethodId++);
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
      if (options.throwStubExceptions) throw exception;
      else if (!exception._expectedByTest) console.debug(`Exception while simulating ${name}`, exception);
    }

    let promise: Promise<any> | undefined;
    if (!callback) {
      if (!options.returnServerResultPromise && (!options.isFromCallAsync || options.returnStubValue)) {
        callback = (err: any) => {
          if (err) console.debug(`Error invoking Method '${name}'`, err);
        };
      } else {
        promise = new Promise((resolve, reject) => {
          callback = (err: any, ...resArgs: any[]) => {
            if (err) return reject(err);
            resolve(resArgs.length > 1 ? resArgs : resArgs[0]);
          };
        });
      }
    }

    if (randomSeed && randomSeed.value !== null) {
      message.randomSeed = randomSeed.value;
    }

    const methodInvoker = new MethodInvoker({
      methodId,
      callback: callback,
      connection: this,
      onResultReceived: options.onResultReceived,
      wait: !!options.wait,
      message,
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

  private _stubCall(name: string, args: any[], options?: any) {
    const stub = this._methodHandlers[name];
    const alreadyInSimulation = false; 
    const isFromCallAsync = options?.isFromCallAsync;
    const randomSeed = { value: null };

    const defaultReturn = { alreadyInSimulation, randomSeed, isFromCallAsync };

    if (!stub) return { ...defaultReturn, hasStub: false };

    const invocation = new MethodInvocation({
      name,
      isSimulation: true,
      userId: this.userId(),
      isFromCallAsync,
      setUserId: (id) => this.setUserId(id),
      randomSeed: () => null
    });

    const stubInvocation = () => stub.apply(invocation, EJSON.clone(args));

    return { ...defaultReturn, hasStub: true, stubInvocation, invocation };
  }

  private _getIsSimulation(options: { isFromCallAsync?: boolean, alreadyInSimulation?: boolean }) {
    if (!options.isFromCallAsync) return options.alreadyInSimulation;
    return options.alreadyInSimulation; 
  }

  private _saveOriginals() {
    if (!this._waitingForQuiescence()) {
      this._flushBufferedWrites();
    }
    Object.values(this._stores).forEach(store => {
      if (store.saveOriginals) store.saveOriginals();
    });
  }

  private _retrieveAndStoreOriginals(methodId: string) {
    if (this._documentsWrittenByStub[methodId]) throw new Error('Duplicate methodId');
    
    const docsWritten: any[] = [];
    
    Object.entries(this._stores).forEach(([collection, store]) => {
      const originals = store.retrieveOriginals ? store.retrieveOriginals() : undefined;
      if (!originals) return;
      
      originals.forEach((doc: any, id: string) => {
        docsWritten.push({ collection, id });
        if (!hasOwn.call(this._serverDocuments, collection)) {
          this._serverDocuments[collection] = new Map(); 
        }
        let serverDoc = this._serverDocuments[collection].get(id);
        if (!serverDoc) {
           serverDoc = Object.create(null);
           this._serverDocuments[collection].set(id, serverDoc);
        }

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

    if (!isEmpty(docsWritten)) {
      this._documentsWrittenByStub[methodId] = docsWritten;
    }
  }


  // --- Network Handlers ---

  async onMessage(raw_msg: string): Promise<void> {
    let msg: any;
    try {
      msg = parseDDP(raw_msg);
    } catch (e) {
      console.debug('Exception while parsing DDP', e);
      return;
    }

    if (this._heartbeat) {
      this._heartbeat.messageReceived();
    }

    if (msg === null || !msg.msg) {
      if (!msg || !msg.testMessageOnConnect) {
        if (Object.keys(msg).length === 1 && msg.server_id) return;
        console.debug('discarding invalid livedata message', msg);
      }
      return;
    }

    if (msg.msg === 'connected') {
      this._version = this._versionSuggestion;
    }

    await this._routeMessage(msg);
  }

  private async _routeMessage(msg: any): Promise<void> {
    switch (msg.msg) {
      case 'connected':
        await this._livedata_connected(msg);
        this.options.onConnected!();
        break;
      case 'failed':
        this._handleFailedMessage(msg);
        break;
      case 'ping':
        if (this.options.respondToPings) {
          this._send({ msg: 'pong', id: msg.id });
        }
        break;
      case 'pong':
        break;
      case 'added':
      case 'changed':
      case 'removed':
      case 'ready':
      case 'updated':
        await this._livedata_data(msg);
        break;
      case 'nosub':
        await this._livedata_nosub(msg);
        break;
      case 'result':
        await this._livedata_result(msg);
        break;
      case 'error':
        console.debug('Received error from server: ', msg.reason);
        break;
      default:
        console.debug('discarding unknown livedata message type', msg);
    }
  }

  onReset(): void {
    const msg: any = { msg: 'connect' };
    if (this._lastSessionId) {
      msg.session = this._lastSessionId;
    }
    msg.version = this._versionSuggestion || this._supportedDDPVersions[0];
    this._versionSuggestion = msg.version;
    msg.support = this._supportedDDPVersions;
    
    this._send(msg);

    const blocks = this._outstandingMethodBlocks;
    if (blocks.length > 0) {
      blocks[0].methods = blocks[0].methods.filter(methodInvoker => {
        if (methodInvoker.sentMessage && methodInvoker.noRetry) {
          methodInvoker.receiveResult(new Error('invocation-failed'));
        }
        return !(methodInvoker.sentMessage && methodInvoker.noRetry);
      });
      if (blocks[0].methods.length === 0) blocks.shift();
    }

    Object.values(this._methodInvokers).forEach(invoker => {
      invoker.sentMessage = false;
    });

    this._callOnReconnectAndSendAppropriateOutstandingMethods();

    Object.entries(this._subscriptions).forEach(([id, sub]) => {
      this._sendQueued({
        msg: 'sub',
        id: id,
        name: sub.name,
        params: sub.params
      });
    });
  }

  public _send(obj: any, queued: boolean = false): void {
    this._stream.send(stringifyDDP(obj));
  }

  public _sendQueued(obj: any): void {
    this._send(obj, true);
  }

  private _handleFailedMessage(msg: any): void {
    if (this._supportedDDPVersions.indexOf(msg.version) >= 0) {
      this._versionSuggestion = msg.version;
      this._stream.reconnect({ _force: true });
    } else {
      const description = `DDP version negotiation failed; server requested version ${msg.version}`;
      this._stream.disconnect({ _permanent: true, _error: description });
      this.options.onDDPVersionNegotiationFailure!(description);
    }
  }

  // --- Livedata Processors ---

  private async _livedata_connected(msg: any): Promise<void> {
    if (this._version !== 'pre1' && this._heartbeatInterval !== 0) {
      this._heartbeat = new Heartbeat({
        heartbeatInterval: this._heartbeatInterval,
        heartbeatTimeout: this._heartbeatTimeout,
        onTimeout: () => {
          this._stream._lostConnection(new Error('DDP heartbeat timed out'));
        },
        sendPing: () => this._send({ msg: 'ping' })
      });
      this._heartbeat.start();
    }

    if (this._lastSessionId) this._resetStores = true;

    let reconnectedToPreviousSession = false;
    if (typeof msg.session === 'string') {
      reconnectedToPreviousSession = this._lastSessionId === msg.session;
      this._lastSessionId = msg.session;
    }

    if (reconnectedToPreviousSession) return;

    this._updatesForUnknownStores = Object.create(null);

    if (this._resetStores) {
      this._documentsWrittenByStub = Object.create(null);
      this._serverDocuments = Object.create(null);
    }

    this._afterUpdateCallbacks = [];
    this._subsBeingRevived = Object.create(null);
    Object.entries(this._subscriptions).forEach(([id, sub]) => {
      if (sub.ready) this._subsBeingRevived[id] = true;
    });

    this._methodsBlockingQuiescence = Object.create(null);
    if (this._resetStores) {
      Object.values(this._methodInvokers).forEach(invoker => {
        if (invoker.gotResult()) {
          this._afterUpdateCallbacks.push(() => invoker.dataVisible());
        } else if (invoker.sentMessage) {
          this._methodsBlockingQuiescence[invoker.methodId] = true;
        }
      });
    }

    this._messagesBufferedUntilQuiescence = [];

    if (!this._waitingForQuiescence()) {
      if (this._resetStores) {
        for (const store of Object.values(this._stores)) {
          await store.beginUpdate(0, true);
          await store.endUpdate();
        }
        this._resetStores = false;
      }
      this._runAfterUpdateCallbacks();
    }
  }

  private async _livedata_data(msg: any): Promise<void> {
    if (this._waitingForQuiescence()) {
      this._messagesBufferedUntilQuiescence.push(msg);

      if (msg.msg === 'nosub') delete this._subsBeingRevived[msg.id];
      if (msg.subs) msg.subs.forEach((subId: string) => delete this._subsBeingRevived[subId]);
      if (msg.methods) msg.methods.forEach((mId: string) => delete this._methodsBlockingQuiescence[mId]);

      if (this._waitingForQuiescence()) return;

      const bufferedMessages = this._messagesBufferedUntilQuiescence;
      for (const bufferedMessage of bufferedMessages) {
        await this._processOneDataMessage(bufferedMessage, this._bufferedWrites);
      }
      this._messagesBufferedUntilQuiescence = [];
    } else {
      await this._processOneDataMessage(msg, this._bufferedWrites);
    }

    const standardWrite = ['added', 'changed', 'removed'].includes(msg.msg);
    if (this._bufferedWritesInterval === 0 || !standardWrite) {
      await this._flushBufferedWrites();
      return;
    }

    const now = Date.now();
    if (this._bufferedWritesFlushAt === null) {
      this._bufferedWritesFlushAt = now + this._bufferedWritesMaxAge;
    } else if (this._bufferedWritesFlushAt < now) {
      await this._flushBufferedWrites();
      return;
    }

    if (this._bufferedWritesFlushHandle) clearTimeout(this._bufferedWritesFlushHandle);
    this._bufferedWritesFlushHandle = setTimeout(() => {
      this._liveDataWritesPromise = this._flushBufferedWrites();
      this._liveDataWritesPromise.finally(() => (this._liveDataWritesPromise = undefined));
    }, this._bufferedWritesInterval);
  }

  private async _livedata_nosub(msg: any): Promise<void> {
    await this._livedata_data(msg);
    if (!hasOwn.call(this._subscriptions, msg.id)) return;

    const sub = this._subscriptions[msg.id];
    sub.remove();

    const err = msg.error ? new Error(msg.error.reason) : undefined;
    if (sub.errorCallback && err) sub.errorCallback(err);
    if (sub.stopCallback) sub.stopCallback(err);
  }

  private async _livedata_result(msg: any): Promise<void> {
    if (!isEmpty(this._bufferedWrites)) await this._flushBufferedWrites();

    if (isEmpty(this._outstandingMethodBlocks)) return;

    const currentBlock = this._outstandingMethodBlocks[0].methods;
    const index = currentBlock.findIndex(m => m.methodId === msg.id);
    
    if (index === -1) return;

    const m = currentBlock[index];
    currentBlock.splice(index, 1);

    if (hasOwn.call(msg, 'error')) {
      m.receiveResult(new Error(msg.error.reason));
    } else {
      m.receiveResult(undefined, msg.result);
    }
  }

  // --- Internal Data Processing ---

  private async _processOneDataMessage(msg: any, updates: any): Promise<void> {
    switch (msg.msg) {
      case 'added':
        await this._process_added(msg, updates);
        break;
      case 'changed':
        this._process_changed(msg, updates);
        break;
      case 'removed':
        this._process_removed(msg, updates);
        break;
      case 'ready':
        this._process_ready(msg, updates);
        break;
      case 'updated':
        this._process_updated(msg, updates);
        break;
    }
  }

  private async _process_added(msg: any, updates: any): Promise<void> {
    const serverDoc = this._getServerDoc(msg.collection, msg.id);
    if (serverDoc) {
      const isExisting = serverDoc.document !== undefined;
      serverDoc.document = msg.fields || {};
      serverDoc.document._id = msg.id;

      if (this._resetStores) {
        const currentDoc = await this._stores[msg.collection].getDoc(msg.id);
        if (currentDoc !== undefined) msg.fields = currentDoc;
        this._pushUpdate(updates, msg.collection, msg);
      } else if (isExisting) {
        throw new Error('Server sent add for existing id: ' + msg.id);
      }
    } else {
      this._pushUpdate(updates, msg.collection, msg);
    }
  }

  private _process_changed(msg: any, updates: any): void {
    const serverDoc = this._getServerDoc(msg.collection, msg.id);
    if (serverDoc) {
      if (serverDoc.document === undefined) throw new Error('Server sent changed for nonexisting id');
      applyChanges(serverDoc.document, msg.fields);
    } else {
      this._pushUpdate(updates, msg.collection, msg);
    }
  }

  private _process_removed(msg: any, updates: any): void {
    const serverDoc = this._getServerDoc(msg.collection, msg.id);
    if (serverDoc) {
      serverDoc.document = undefined;
    } else {
      this._pushUpdate(updates, msg.collection, msg);
    }
  }

  private _process_ready(msg: any, updates: any): void {
    msg.subs.forEach((subId: string) => {
      this._runWhenAllServerDocsAreFlushed(() => {
        const subRecord = this._subscriptions[subId];
        if (!subRecord || subRecord.ready) return;
        subRecord.ready = true;
        if (subRecord.readyCallback) subRecord.readyCallback();
        subRecord.readyDeps.changed();
      });
    });
  }

  private _process_updated(msg: any, updates: any): void {
    msg.methods.forEach((methodId: string) => {
      const docs = this._documentsWrittenByStub[methodId] || {};
      Object.values(docs).forEach((written: any) => {
        const serverDoc = this._getServerDoc(written.collection, written.id);
        if (serverDoc && serverDoc.writtenByStubs[methodId]) {
          delete serverDoc.writtenByStubs[methodId];
          if (isEmpty(serverDoc.writtenByStubs)) {
            this._pushUpdate(updates, written.collection, {
              msg: 'replace',
              id: written.id,
              replace: serverDoc.document
            });
            serverDoc.flushCallbacks.forEach((c: any) => c());
            this._serverDocuments[written.collection].delete(written.id);
          }
        }
      });
      delete this._documentsWrittenByStub[methodId];

      const callbackInvoker = this._methodInvokers[methodId];
      if (callbackInvoker) {
        this._runWhenAllServerDocsAreFlushed(() => callbackInvoker.dataVisible());
      }
    });
  }

  private _pushUpdate(updates: any, collection: string, msg: any): void {
    if (!hasOwn.call(updates, collection)) updates[collection] = [];
    updates[collection].push(msg);
  }

  private _getServerDoc(collection: string, id: string): any {
    if (!hasOwn.call(this._serverDocuments, collection)) return null;
    return this._serverDocuments[collection].get(id) || null;
  }

  private async _flushBufferedWrites(): Promise<void> {
    if (this._bufferedWritesFlushHandle) {
      clearTimeout(this._bufferedWritesFlushHandle);
      this._bufferedWritesFlushHandle = null;
    }
    this._bufferedWritesFlushAt = null;
    const writes = this._bufferedWrites;
    this._bufferedWrites = Object.create(null);

    // Simplistic write execution
    if (this._resetStores || !isEmpty(writes)) {
      Object.values(this._stores).forEach(store => store.beginUpdate(0, this._resetStores));
      this._resetStores = false;

      Object.entries(writes).forEach(([storeName, messages]) => {
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

  private _runAfterUpdateCallbacks(): void {
    const callbacks = this._afterUpdateCallbacks;
    this._afterUpdateCallbacks = [];
    callbacks.forEach(c => c());
  }

  private _runWhenAllServerDocsAreFlushed(f: () => void): void {
    let unflushedCount = 0;
    const onFlush = () => {
      if (--unflushedCount === 0) this._afterUpdateCallbacks.push(f);
    };

    Object.values(this._serverDocuments).forEach(serverDocuments => {
      serverDocuments.forEach((serverDoc: any) => {
        const hasActiveStub = Object.keys(serverDoc.writtenByStubs).some(mId => {
          return this._methodInvokers[mId] && this._methodInvokers[mId].sentMessage;
        });

        if (hasActiveStub) {
          unflushedCount++;
          serverDoc.flushCallbacks.push(onFlush);
        }
      });
    });

    if (unflushedCount === 0) this._afterUpdateCallbacks.push(f);
  }

  private _waitingForQuiescence(): boolean {
    return !isEmpty(this._subsBeingRevived) || !isEmpty(this._methodsBlockingQuiescence);
  }

  public _addOutstandingMethod(methodInvoker: MethodInvoker, options: any) {
    if (options?.wait) {
      this._outstandingMethodBlocks.push({
        wait: true,
        methods: [methodInvoker]
      });
    } else {
      if (isEmpty(this._outstandingMethodBlocks) || last(this._outstandingMethodBlocks)!.wait) {
        this._outstandingMethodBlocks.push({
          wait: false,
          methods: [],
        });
      }
      last(this._outstandingMethodBlocks)!.methods.push(methodInvoker);
    }

    if (this._outstandingMethodBlocks.length === 1) {
      methodInvoker.sendMessage();
    }
  }

  public _outstandingMethodFinished(): void {
    if (Object.values(this._methodInvokers).some(m => m.sentMessage)) return;

    if (!isEmpty(this._outstandingMethodBlocks)) {
      this._outstandingMethodBlocks.shift();
      if (!isEmpty(this._outstandingMethodBlocks)) {
        this._outstandingMethodBlocks[0].methods.forEach(m => m.sendMessage());
      }
    }
    
    if (this._retryMigrate && isEmpty(this._methodInvokers)) {
      this._retryMigrate();
      this._retryMigrate = null;
    }
  }

  private _callOnReconnectAndSendAppropriateOutstandingMethods(): void {
    const oldBlocks = this._outstandingMethodBlocks;
    this._outstandingMethodBlocks = [];

    if (this.onReconnect) this.onReconnect();

    if (isEmpty(oldBlocks)) return;

    if (isEmpty(this._outstandingMethodBlocks)) {
      this._outstandingMethodBlocks = oldBlocks;
      this._outstandingMethodBlocks[0].methods.forEach(m => m.sendMessage());
      return;
    }

    if (!last(this._outstandingMethodBlocks)!.wait && !oldBlocks[0].wait) {
      oldBlocks[0].methods.forEach(m => {
        last(this._outstandingMethodBlocks)!.methods.push(m);
        if (this._outstandingMethodBlocks.length === 1) m.sendMessage();
      });
      oldBlocks.shift();
    }

    this._outstandingMethodBlocks.push(...oldBlocks);
  }
}