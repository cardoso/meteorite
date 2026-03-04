export type MethodInvocationOptions = {
  name: string;
  isSimulation?: boolean;
  unblock?: () => void;
  isFromCallAsync?: boolean;
  userId?: string | null;
  setUserId?: (userId: string | null) => Promise<void> | void;
  connection?: any;
  randomSeed?: any;
  fence?: any;
};

export class MethodInvocation {
  public name: string;
  public isSimulation: boolean;
  public userId: string | null;
  public connection: any;
  public randomSeed: any;
  public randomStream: any = null;
  public fence: any;

  private _unblock: () => void;
  private _calledUnblock: boolean = false;
  public _isFromCallAsync: boolean;
  private _setUserId: (userId: string | null) => Promise<void> | void;

  constructor(options: MethodInvocationOptions) {
    this.name = options.name;
    this.isSimulation = !!options.isSimulation;
    this._unblock = options.unblock || (() => {});
    this._isFromCallAsync = !!options.isFromCallAsync;
    this.userId = options.userId || null;
    this._setUserId = options.setUserId || (() => {});
    this.connection = options.connection;
    this.randomSeed = options.randomSeed;
    this.fence = options.fence;
  }

  public unblock(): void {
    this._calledUnblock = true;
    this._unblock();
  }

  public async setUserId(userId: string | null): Promise<void> {
    if (this._calledUnblock) {
      throw new Error("Can't call setUserId in a method after calling unblock");
    }
    this.userId = userId;
    await this._setUserId(userId);
  }
}