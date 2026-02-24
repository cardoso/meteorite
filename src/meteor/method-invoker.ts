export type MethodInvokerOptions = {
  methodId: string;
  callback?: (err?: any, result?: any) => void;
  connection: any; // Will be typed to Connection
  message: any;
  onResultReceived?: (err: any, result: any) => void;
  wait?: boolean;
  noRetry?: boolean;
};

export class MethodInvoker {
  public methodId: string;
  public sentMessage: boolean;
  public noRetry: boolean;

  private _callback: (err?: any, result?: any) => void;
  private _connection: any;
  private _message: any;
  private _onResultReceived: (err: any, result: any) => void;
  private _wait: boolean;
  private _methodResult: [any, any] | null;
  private _dataVisible: boolean;

  constructor(options: MethodInvokerOptions) {
    this.methodId = options.methodId;
    this.sentMessage = false;

    this._callback = options.callback || (() => {});
    this._connection = options.connection;
    this._message = options.message;
    this._onResultReceived = options.onResultReceived || (() => {});
    this._wait = !!options.wait;
    this.noRetry = !!options.noRetry;
    this._methodResult = null;
    this._dataVisible = false;

    this._connection._methodInvokers[this.methodId] = this;
  }

  sendMessage(): void {
    if (this.gotResult()) {
      throw new Error('sendMessage is called on method with result');
    }

    this._dataVisible = false;
    this.sentMessage = true;

    if (this._wait) {
      this._connection._methodsBlockingQuiescence[this.methodId] = true;
    }

    this._connection._send(this._message);
  }

  private _maybeInvokeCallback(): void {
    if (this._methodResult && this._dataVisible) {
      this._callback(this._methodResult[0], this._methodResult[1]);
      delete this._connection._methodInvokers[this.methodId];
      this._connection._outstandingMethodFinished();
    }
  }

  receiveResult(err: any, result?: any): void {
    if (this.gotResult()) {
      throw new Error('Methods should only receive results once');
    }
    this._methodResult = [err, result];
    this._onResultReceived(err, result);
    this._maybeInvokeCallback();
  }

  dataVisible(): void {
    this._dataVisible = true;
    this._maybeInvokeCallback();
  }

  gotResult(): boolean {
    return !!this._methodResult;
  }
}