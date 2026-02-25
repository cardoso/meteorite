import { DDPCommon } from 'meteor/ddp-common';
import { Meteor } from 'meteor/meteor';
import { DDP } from './namespace.ts';
import { isEmpty, hasOwn } from "meteor/ddp-common/utils";

export type MessagePayload = {
  msg: string;
  session?: string;
  id?: string;
  subs?: string[];
  methods?: string[];
  error?: {
    error: string | number;
    reason?: string;
    details?: string;
  };
  result?: any;
  reason?: string;
  offendingMessage?: any;
  [key: string]: any;
};

export class MessageProcessors {
  protected _connection: any;

  constructor(connection: any) {
    this._connection = connection;
  }

  public async _livedata_connected(msg: MessagePayload): Promise<void> {
    const self = this._connection;

    if (self._version !== 'pre1' && self._heartbeatInterval !== 0) {
      self._heartbeat = new DDPCommon.Heartbeat({
        heartbeatInterval: self._heartbeatInterval,
        heartbeatTimeout: self._heartbeatTimeout,
        onTimeout() {
          self._lostConnection(
            new DDP.ConnectionError('DDP heartbeat timed out')
          );
        },
        sendPing() {
          self._send({ msg: 'ping' });
        }
      });
      self._heartbeat.start();
    }

    if (self._lastSessionId) self._resetStores = true;

    let reconnectedToPreviousSession = false;
    if (typeof msg.session === 'string') {
      reconnectedToPreviousSession = self._lastSessionId === msg.session;
      self._lastSessionId = msg.session;
    }

    if (reconnectedToPreviousSession) {
      return;
    }

    self._updatesForUnknownStores = Object.create(null);

    if (self._resetStores) {
      self._documentsWrittenByStub = Object.create(null);
      self._serverDocuments = Object.create(null);
    }

    self._afterUpdateCallbacks = [];
    self._subsBeingRevived = Object.create(null);
    
    Object.entries(self._subscriptions).forEach(([id, sub]: [string, any]) => {
      if (sub.ready) {
        self._subsBeingRevived[id] = true;
      }
    });

    self._methodsBlockingQuiescence = Object.create(null);
    if (self._resetStores) {
      const invokers = self._methodInvokers;
      Object.keys(invokers).forEach(id => {
        const invoker = invokers[id];
        if (invoker.gotResult()) {
          self._afterUpdateCallbacks.push(
            (...args: any[]) => invoker.dataVisible(...args)
          );
        } else if (invoker.sentMessage) {
          self._methodsBlockingQuiescence[invoker.methodId] = true;
        }
      });
    }

    self._messagesBufferedUntilQuiescence = [];

    if (!self._waitingForQuiescence()) {
      if (self._resetStores) {
        for (const store of Object.values(self._stores as Record<string, any>)) {
          await store.beginUpdate(0, true);
          await store.endUpdate();
        }
        self._resetStores = false;
      }
      self._runAfterUpdateCallbacks();
    }
  }

  public async _livedata_data(msg: MessagePayload): Promise<void> {
    const self = this._connection;

    if (self._waitingForQuiescence()) {
      self._messagesBufferedUntilQuiescence.push(msg);

      if (msg.msg === 'nosub' && msg.id) {
        delete self._subsBeingRevived[msg.id];
      }

      if (msg.subs) {
        msg.subs.forEach((subId: string) => {
          delete self._subsBeingRevived[subId];
        });
      }

      if (msg.methods) {
        msg.methods.forEach((methodId: string) => {
          delete self._methodsBlockingQuiescence[methodId];
        });
      }

      if (self._waitingForQuiescence()) {
        return;
      }

      const bufferedMessages = self._messagesBufferedUntilQuiescence;
      for (const bufferedMessage of Object.values(bufferedMessages)) {
        await this._processOneDataMessage(
          bufferedMessage as MessagePayload,
          self._bufferedWrites
        );
      }
      self._messagesBufferedUntilQuiescence = [];
    } else {
      await this._processOneDataMessage(msg, self._bufferedWrites);
    }

    const standardWrite =
      msg.msg === "added" ||
      msg.msg === "changed" ||
      msg.msg === "removed";

    if (self._bufferedWritesInterval === 0 || !standardWrite) {
      await self._flushBufferedWrites();
      return;
    }

    if (self._bufferedWritesFlushAt === null) {
      self._bufferedWritesFlushAt =
        new Date().valueOf() + self._bufferedWritesMaxAge;
    } else if (self._bufferedWritesFlushAt < new Date().valueOf()) {
      await self._flushBufferedWrites();
      return;
    }

    if (self._bufferedWritesFlushHandle) {
      clearTimeout(self._bufferedWritesFlushHandle);
    }
    self._bufferedWritesFlushHandle = setTimeout(() => {
      self._liveDataWritesPromise = self._flushBufferedWrites();
      if (self._liveDataWritesPromise instanceof Promise) {
        self._liveDataWritesPromise.finally(
          () => (self._liveDataWritesPromise = undefined)
        );
      }
    }, self._bufferedWritesInterval);
  }

  protected async _processOneDataMessage(msg: MessagePayload, updates: any): Promise<void> {
    const messageType = msg.msg;

    switch (messageType) {
      case 'added':
        await this._connection._process_added(msg, updates);
        break;
      case 'changed':
        this._connection._process_changed(msg, updates);
        break;
      case 'removed':
        this._connection._process_removed(msg, updates);
        break;
      case 'ready':
        this._connection._process_ready(msg, updates);
        break;
      case 'updated':
        this._connection._process_updated(msg, updates);
        break;
      case 'nosub':
        break;
      default:
        console.warn('discarding unknown livedata data message type', msg);
    }
  }

  public async _livedata_result(msg: MessagePayload): Promise<void> {
    const self = this._connection;

    if (!isEmpty(self._bufferedWrites)) {
      await self._flushBufferedWrites();
    }

    if (isEmpty(self._outstandingMethodBlocks)) {
      console.warn('Received method result but no methods outstanding');
      return;
    }
    
    const currentMethodBlock = self._outstandingMethodBlocks[0].methods;
    let i = -1;
    const m = currentMethodBlock.find((method: any, idx: number) => {
      const found = method.methodId === msg.id;
      if (found) i = idx;
      return found;
    });
    
    if (!m) {
      console.warn("Can't match method response to original method call", msg);
      return;
    }

    currentMethodBlock.splice(i, 1);

    if (hasOwn.call(msg, 'error') && msg.error) {
      m.receiveResult(
        new Meteor.Error(msg.error.error, msg.error.reason, msg.error.details)
      );
    } else {
      m.receiveResult(undefined, msg.result);
    }
  }

  public async _livedata_nosub(msg: MessagePayload): Promise<void> {
    const self = this._connection;

    await this._livedata_data(msg);

    if (!msg.id || !hasOwn.call(self._subscriptions, msg.id)) {
      return;
    }

    const errorCallback = self._subscriptions[msg.id].errorCallback;
    const stopCallback = self._subscriptions[msg.id].stopCallback;

    self._subscriptions[msg.id].remove();

    const meteorErrorFromMsg = (msgArg: MessagePayload) => {
      return (
        msgArg &&
        msgArg.error &&
        new Meteor.Error(
          msgArg.error.error,
          msgArg.error.reason,
          msgArg.error.details
        )
      );
    };

    if (errorCallback && msg.error) {
      errorCallback(meteorErrorFromMsg(msg));
    }

    if (stopCallback) {
      stopCallback(meteorErrorFromMsg(msg));
    }
  }

  public _livedata_error(msg: MessagePayload): void {
    console.error('Received error from server: ', msg.reason);
    if (msg.offendingMessage) {
      console.error('For: ', msg.offendingMessage);
    }
  }
}