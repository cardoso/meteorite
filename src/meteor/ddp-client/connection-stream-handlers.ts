import { DDPCommon } from 'meteor/ddp-common';

export type DDPMessage = {
  msg: string;
  id?: string;
  version?: string;
  session?: string;
  support?: string[];
  testMessageOnConnect?: boolean;
  server_id?: string;
  [key: string]: any;
};

export class ConnectionStreamHandlers {
  protected _connection: any;

  constructor(connection: any) {
    this._connection = connection;
  }

  public async onMessage(raw_msg: string): Promise<void> {
    let msg: DDPMessage;
    try {
      msg = DDPCommon.parseDDP(raw_msg);
    } catch (e) {
      console.error('Exception while parsing DDP', e);
      return;
    }

    if (this._connection._heartbeat) {
      this._connection._heartbeat.messageReceived();
    }

    if (msg === null || !msg.msg) {
      if (!msg || !msg.testMessageOnConnect) {
        if (Object.keys(msg || {}).length === 1 && msg.server_id) return;
        console.warn('discarding invalid livedata message', msg);
      }
      return;
    }

    if (msg.msg === 'connected') {
      this._connection._version = this._connection._versionSuggestion;
    }

    await this._routeMessage(msg);
  }

  protected async _routeMessage(msg: DDPMessage): Promise<void> {
    switch (msg.msg) {
      case 'connected':
        await this._connection._livedata_connected(msg);
        this._connection.options.onConnected();
        break;
      case 'failed':
        await this._handleFailedMessage(msg);
        break;
      case 'ping':
        if (this._connection.options.respondToPings) {
          this._connection._send({ msg: 'pong', id: msg.id });
        }
        break;
      case 'pong':
        break;
      case 'added':
      case 'changed':
      case 'removed':
      case 'ready':
      case 'updated':
        await this._connection._livedata_data(msg);
        break;
      case 'nosub':
        await this._connection._livedata_nosub(msg);
        break;
      case 'result':
        await this._connection._livedata_result(msg);
        break;
      case 'error':
        this._connection._livedata_error(msg);
        break;
      default:
        console.warn('discarding unknown livedata message type', msg);
    }
  }

  protected _handleFailedMessage(msg: DDPMessage): void {
    if (this._connection._supportedDDPVersions.includes(msg.version)) {
      this._connection._versionSuggestion = msg.version;
      this._connection._stream.reconnect({ _force: true });
    } else {
      const description = `DDP version negotiation failed; server requested version ${msg.version}`;
      this._connection._stream.disconnect({ _permanent: true, _error: description });
      this._connection.options.onDDPVersionNegotiationFailure(description);
    }
  }

  public onReset(): void {
    const msg = this._buildConnectMessage();
    this._connection._send(msg);

    this._handleOutstandingMethodsOnReset();

    this._connection._callOnReconnectAndSendAppropriateOutstandingMethods();
    this._resendSubscriptions();
  }

  protected _buildConnectMessage(): DDPMessage {
    const msg: DDPMessage = { msg: 'connect' };
    if (this._connection._lastSessionId) {
      msg.session = this._connection._lastSessionId;
    }
    msg.version = this._connection._versionSuggestion || this._connection._supportedDDPVersions[0];
    this._connection._versionSuggestion = msg.version;
    msg.support = this._connection._supportedDDPVersions;
    return msg;
  }

  protected _handleOutstandingMethodsOnReset(): void {
    const blocks = this._connection._outstandingMethodBlocks;
    if (blocks.length === 0) return;

    const currentMethodBlock = blocks[0].methods;
    blocks[0].methods = currentMethodBlock.filter((methodInvoker: any) => {
      if (methodInvoker.sentMessage && methodInvoker.noRetry) {
        methodInvoker.receiveResult(
          new Error(
            'invocation-failed: Method invocation might have failed due to dropped connection. ' +
            'Failing because `noRetry` option was passed to apply.'
          )
        );
      }
      return !(methodInvoker.sentMessage && methodInvoker.noRetry);
    });

    if (blocks.length > 0 && blocks[0].methods.length === 0) {
      blocks.shift();
    }

    Object.values(this._connection._methodInvokers).forEach((invoker: any) => {
      invoker.sentMessage = false;
    });
  }

  protected _resendSubscriptions(): void {
    Object.entries(this._connection._subscriptions).forEach(([id, sub]: [string, any]) => {
      this._connection._sendQueued({
        msg: 'sub',
        id,
        name: sub.name,
        params: sub.params
      });
    });
  }
}