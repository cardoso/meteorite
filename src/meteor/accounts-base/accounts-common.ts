import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Hook } from 'meteor/callback-hook';
import { Connection, DDP } from 'meteor/ddp-client';

const VALID_CONFIG_KEYS = [
    'forbidClientAccountCreation',
    'loginExpiration',
    'loginExpirationInDays',
    'ambiguousErrorMessages',
    'defaultFieldSelector',
    'collection',
    'clientStorage',
    'ddpUrl',
    'connection',
];

export const DEFAULT_LOGIN_EXPIRATION_DAYS = 90;
export const MIN_TOKEN_LIFETIME_CAP_SECS = 3600; // one hour
export const LOGIN_UNEXPIRING_TOKEN_DAYS = 365 * 100;

export type AccountsConfigOptions = {
    connection?: Connection;
    ddpUrl?: string;
    collection?: string | Mongo.Collection<Meteor.User>;
    defaultFieldSelector?: Record<string, 0 | 1>;
    loginExpiration?: number;
    loginExpirationInDays?: number | null;
    clientStorage?: 'session' | 'local';
    [key: string]: any;
};

class LoginCancelledError extends Error {
    override name = 'Accounts.LoginCancelledError';
    numericError = 0x8acdc2f;
    constructor(message?: string | undefined) {
        super(message);
    }
};

export class AccountsCommon {
    protected _options: AccountsConfigOptions;
    public connection?: Connection;
    public users: Mongo.Collection<Meteor.User>;

    protected _onLoginHook: Hook;
    protected _onLoginFailureHook: Hook;
    protected _onLogoutHook: Hook;

    LoginCancelledError = LoginCancelledError;

    constructor(options: AccountsConfigOptions = {}) {
        for (const key of Object.keys(options)) {
            if (!VALID_CONFIG_KEYS.includes(key)) {
                console.error(`Accounts.config: Invalid key: ${key}`);
            }
        }

        this._options = options;
        this._initConnection(options);
        this.users = this._initializeCollection(options);

        this._onLoginHook = new Hook({ debugPrintExceptions: 'onLogin callback' });
        this._onLoginFailureHook = new Hook({ debugPrintExceptions: 'onLoginFailure callback' });
        this._onLogoutHook = new Hook({ debugPrintExceptions: 'onLogout callback' });
    }

    protected _initializeCollection(options: AccountsConfigOptions): Mongo.Collection<Meteor.User> {
        if (options.collection instanceof Mongo.Collection) {
            return options.collection as Mongo.Collection<Meteor.User>;
        }

        const collectionName = typeof options.collection === 'string' ? options.collection : 'users';

        return new Mongo.Collection<Meteor.User>(collectionName, {
            connection: this.connection,
        });
    }

    public userId(): string | null {
        throw new Error('userId method not implemented');
    }

    protected _addDefaultFieldSelector(options: { fields?: Record<string, 0 | 1> } = {}): any {
        if (!this._options.defaultFieldSelector) return options;

        if (!options.fields) {
            return { ...options, fields: this._options.defaultFieldSelector };
        }

        const keys = Object.keys(options.fields);
        if (!keys.length) return options;

        if (!!options.fields[keys[0]]) return options;

        const keys2 = Object.keys(this._options.defaultFieldSelector);
        return this._options.defaultFieldSelector[keys2[0]]
            ? options
            : {
                ...options,
                fields: {
                    ...options.fields,
                    ...this._options.defaultFieldSelector,
                },
            };
    }

    public user(options?: { fields?: Record<string, 0 | 1> }): Meteor.User | null {
        const userId = this.userId();
        return userId ? this.users.findOne(userId, this._addDefaultFieldSelector(options)) ?? null : null;
    }

    public async userAsync(options?: { fields?: Record<string, 0 | 1> }): Promise<Meteor.User | null> {
        const userId = this.userId();
        return userId ? this.users.findOneAsync(userId, this._addDefaultFieldSelector(options)).then(user => user ?? null) : null;
    }

    public config(options: AccountsConfigOptions): void {
        for (const key of Object.keys(options)) {
            if (!VALID_CONFIG_KEYS.includes(key)) {
                console.error(`Accounts.config: Invalid key: ${key}`);
            }
        }

        for (const key of VALID_CONFIG_KEYS) {
            if (key in options) {
                if (key in this._options && key !== 'collection' && key !== 'clientStorage') {
                    throw new Meteor.Error(`Can't set \`${key}\` more than once`);
                }
                this._options[key] = options[key];
            }
        }

        if (options.collection && options.collection !== this.users) {
            this.users = this._initializeCollection(options);
        }
    }

    public onLogin(func: (info: any) => void) {
        const ret = this._onLoginHook.register(func);
        this._startupCallback(ret.callback);
        return ret;
    }

    public onLoginFailure(func: (info: any) => void) {
        return this._onLoginFailureHook.register(func);
    }

    public onLogout(func: (info: any) => void) {
        return this._onLogoutHook.register(func);
    }

    protected _initConnection(options: AccountsConfigOptions): void {
        if (options.connection) {
            this.connection = options.connection;
        } else if (options.ddpUrl) {
            this.connection = DDP.connect(options.ddpUrl);
        } else {
            this.connection = Meteor.connection;
        }
    }

    protected _getTokenLifetimeMs(): number {
        const loginExpirationInDays = this._options.loginExpirationInDays === null
            ? LOGIN_UNEXPIRING_TOKEN_DAYS
            : this._options.loginExpirationInDays;

        return (
            this._options.loginExpiration ||
            (loginExpirationInDays || DEFAULT_LOGIN_EXPIRATION_DAYS) * 86400000
        );
    }

    protected _tokenExpiration(when: string | number | Date): Date {
        return new Date(new Date(when).getTime() + this._getTokenLifetimeMs());
    }

    protected _tokenExpiresSoon(when: string | number | Date): boolean {
        let minLifetimeMs = 0.1 * this._getTokenLifetimeMs();
        const minLifetimeCapMs = MIN_TOKEN_LIFETIME_CAP_SECS * 1000;
        if (minLifetimeMs > minLifetimeCapMs) {
            minLifetimeMs = minLifetimeCapMs;
        }
        return new Date().getTime() > new Date(when).getTime() - minLifetimeMs;
    }

    protected _startupCallback(_callback: Function): void { }
}