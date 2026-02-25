import { DDPCommon } from 'meteor/ddp-common';
import { Meteor } from 'meteor/meteor';
import { Hook } from 'meteor/callback-hook';
import { Connection } from './livedata-connection.ts';

// This array allows the `_allSubscriptionsReady` method below to keep track
// of whether all data is ready.
const allConnections: Connection[] = [];

export type DDPNamespace = {
    _CurrentMethodInvocation: any;
    _CurrentPublicationInvocation: any;
    _CurrentInvocation: any;
    _CurrentCallAsyncInvocation: any;
    ConnectionError: new (message: string) => Error;
    ForcedReconnectError: new (message?: string) => Error;
    randomStream: (name?: string) => any;
    connect: (url: string, options?: Record<string, any>) => Connection;
    onReconnect: (callback: (connection: Connection) => void) => any;
    _allSubscriptionsReady: () => boolean;
    _reconnectHook: any;
};

export const DDP: DDPNamespace = {} as DDPNamespace;

DDP._CurrentMethodInvocation = new Meteor.EnvironmentVariable();
DDP._CurrentPublicationInvocation = new Meteor.EnvironmentVariable();
DDP._CurrentInvocation = DDP._CurrentMethodInvocation;
DDP._CurrentCallAsyncInvocation = new Meteor.EnvironmentVariable();


DDP.ConnectionError = class ConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DDP.ConnectionError';
    }
}

DDP.ForcedReconnectError = class ForcedReconnectError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'DDP.ForcedReconnectError';
    }
}

DDP.randomStream = (name?: string) => {
    const scope = DDP._CurrentMethodInvocation.get();
    return DDPCommon.RandomStream.get(scope, name);
};

DDP.connect = (url: string, options?: Record<string, any>): Connection => {
    const ret = new Connection(url, options);
    allConnections.push(ret);
    return ret;
};

DDP._reconnectHook = new Hook({ bindEnvironment: false });

DDP.onReconnect = (callback: (connection: Connection) => void) => {
    return DDP._reconnectHook.register(callback);
};

DDP._allSubscriptionsReady = (): boolean => {
    return allConnections.every((conn: Connection) => {
        return Object.values(conn._subscriptions).every((sub: any) => sub.ready);
    });
};