export class StubStream {
  public sent: any[] = [];
  public callbacks: Record<string, Function[]> = Object.create(null);
  public _isStub: boolean = true;
  public _neverQueued: boolean = true;

  on(name: string, callback: Function): void {
    if (!this.callbacks[name]) {
      this.callbacks[name] = [callback];
    } else {
      this.callbacks[name].push(callback);
    }
  }

  send(data: any): void {
    this.sent.push(data);
  }

  status(): { status: string; fake: boolean } {
    return { status: 'connected', fake: true };
  }

  reconnect(): void {
    // no-op
  }

  _lostConnection(): void {
    // no-op
  }

  async receive(data: any): Promise<void> {
    let message = data;
    if (typeof data === 'object') {
      message = JSON.stringify(data);
    }

    if (this.callbacks['message']) {
      for (const cb of this.callbacks['message']) {
        await cb(message);
      }
    }
  }

  async reset(): Promise<void> {
    if (this.callbacks['reset']) {
      for (const cb of this.callbacks['reset']) {
        await cb();
      }
    }
  }
}