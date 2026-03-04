export type HeartbeatOptions = {
  heartbeatInterval: number;
  heartbeatTimeout: number;
  sendPing: () => void;
  onTimeout: () => void;
};

export class Heartbeat {
  private heartbeatInterval: number;
  private heartbeatTimeout: number;
  private _sendPing: () => void;
  private _onTimeout: () => void;
  private _seenPacket: boolean = false;

  private _heartbeatIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private _heartbeatTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(options: HeartbeatOptions) {
    this.heartbeatInterval = options.heartbeatInterval;
    this.heartbeatTimeout = options.heartbeatTimeout;
    this._sendPing = options.sendPing;
    this._onTimeout = options.onTimeout;
  }

  public stop(): void {
    this._clearHeartbeatIntervalTimer();
    this._clearHeartbeatTimeoutTimer();
  }

  public start(): void {
    this.stop();
    this._startHeartbeatIntervalTimer();
  }

  private _startHeartbeatIntervalTimer(): void {
    this._heartbeatIntervalHandle = setInterval(
      () => this._heartbeatIntervalFired(),
      this.heartbeatInterval
    );
  }

  private _startHeartbeatTimeoutTimer(): void {
    this._heartbeatTimeoutHandle = setTimeout(
      () => this._heartbeatTimeoutFired(),
      this.heartbeatTimeout
    );
  }

  private _clearHeartbeatIntervalTimer(): void {
    if (this._heartbeatIntervalHandle) {
      clearInterval(this._heartbeatIntervalHandle);
      this._heartbeatIntervalHandle = null;
    }
  }

  private _clearHeartbeatTimeoutTimer(): void {
    if (this._heartbeatTimeoutHandle) {
      clearTimeout(this._heartbeatTimeoutHandle);
      this._heartbeatTimeoutHandle = null;
    }
  }

  private _heartbeatIntervalFired(): void {
    // don't send ping if we've seen a packet since we last checked,
    // *or* if we have already sent a ping and are awaiting a timeout.
    if (!this._seenPacket && !this._heartbeatTimeoutHandle) {
      this._sendPing();
      this._startHeartbeatTimeoutTimer();
    }
    this._seenPacket = false;
  }

  private _heartbeatTimeoutFired(): void {
    this._heartbeatTimeoutHandle = null;
    this._onTimeout();
  }

  public messageReceived(): void {
    // Tell periodic checkin that we have seen a packet
    this._seenPacket = true;
    if (this._heartbeatTimeoutHandle) {
      this._clearHeartbeatTimeoutTimer();
    }
  }
}