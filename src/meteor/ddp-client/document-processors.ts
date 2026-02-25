import { MongoID } from 'meteor/mongo-id';
import { DiffSequence } from 'meteor/diff-sequence';
import type { Mongo } from 'meteor/mongo';

type MessageHeader<T extends string> = {
  msg: T;
  id: string;
}

type MessageBodyMap = {
  replace: { replace: Mongo.Document };
  removed: { collection: string };
  added: { collection: string; fields: Partial<Document>; };
  changed: { collection: string; fields: Partial<Document>; };
  ready: { subs: string[] };
  updated: { methods: string[] };
}

export type DocumentMessage<TMsg extends keyof MessageBodyMap = keyof MessageBodyMap> = MessageHeader<TMsg> & MessageBodyMap[TMsg];

export class DocumentProcessors {
  protected _connection: any;

  constructor(connection: any) {
    this._connection = connection;
  }

  public async _process_added(msg: DocumentMessage<'added'>, updates: Record<string, any[]>): Promise<void> {
    const self = this._connection;
    const id = MongoID.idParse(msg.id);
    const serverDoc = self._getServerDoc(msg.collection, id);

    if (serverDoc) {
      const isExisting = serverDoc.document !== undefined;

      serverDoc.document = msg.fields || Object.create(null);
      serverDoc.document._id = id;

      if (self._resetStores) {
        const currentDoc = await self._stores[msg.collection].getDoc(msg.id);
        if (currentDoc !== undefined) msg.fields = currentDoc;

        this._pushUpdate(updates, msg.collection, msg);
      } else if (isExisting) {
        throw new Error(`Server sent add for existing id: ${msg.id}`);
      }
    } else {
      this._pushUpdate(updates, msg.collection, msg);
    }
  }

  public _process_changed(msg: DocumentMessage<'changed'>, updates: Record<string, DocumentMessage[]>): void {
    const self = this._connection;
    const serverDoc = self._getServerDoc(msg.collection, MongoID.idParse(msg.id));

    if (serverDoc) {
      if (serverDoc.document === undefined) {
        throw new Error(`Server sent changed for nonexisting id: ${msg.id}`);
      }
      DiffSequence.applyChanges(serverDoc.document, msg.fields);
    } else {
      this._pushUpdate(updates, msg.collection, msg);
    }
  }

  public _process_removed(msg: DocumentMessage<'removed'>, updates: Record<string, DocumentMessage[]>): void {
    const self = this._connection;
    const serverDoc = self._getServerDoc(msg.collection, MongoID.idParse(msg.id));

    if (serverDoc) {
      if (serverDoc.document === undefined) {
        throw new Error(`Server sent removed for nonexisting id: ${msg.id}`);
      }
      serverDoc.document = undefined;
    } else {
      this._pushUpdate(updates, msg.collection, {
        msg: 'removed',
        collection: msg.collection,
        id: msg.id
      });
    }
  }

  public _process_ready(msg: DocumentMessage<'ready'>, _updates: Record<string, DocumentMessage[]>): void {
    const self = this._connection;

    if (!msg.subs) return;

    msg.subs.forEach((subId) => {
      self._runWhenAllServerDocsAreFlushed(() => {
        const subRecord = self._subscriptions[subId];
        if (!subRecord) return;
        if (subRecord.ready) return;

        subRecord.ready = true;
        if (subRecord.readyCallback) {
          subRecord.readyCallback();
        }
        subRecord.readyDeps.changed();
      });
    });
  }

  public _process_updated(msg: DocumentMessage<'updated'>, updates: Record<string, any[]>): void {
    const self = this._connection;

    if (!msg.methods) return;

    msg.methods.forEach((methodId) => {
      const docs = self._documentsWrittenByStub[methodId] || {};
      Object.values(docs).forEach((written: any) => {
        const serverDoc = self._getServerDoc(written.collection, written.id);

        if (!serverDoc) {
          throw new Error(`Lost serverDoc for ${JSON.stringify(written)}`);
        }
        if (!serverDoc.writtenByStubs[methodId]) {
          throw new Error(`Doc ${JSON.stringify(written)} not written by method ${methodId}`);
        }

        delete serverDoc.writtenByStubs[methodId];

        if (Object.keys(serverDoc.writtenByStubs).length === 0) {
          this._pushUpdate(updates, written.collection, {
            msg: 'replace',
            id: MongoID.idStringify(written.id),
            replace: serverDoc.document
          });

          serverDoc.flushCallbacks.forEach((c: () => void) => c());
          self._serverDocuments[written.collection].remove(written.id);
        }
      });

      delete self._documentsWrittenByStub[methodId];

      const callbackInvoker = self._methodInvokers[methodId];
      if (!callbackInvoker) {
        throw new Error(`No callback invoker for method ${methodId}`);
      }

      self._runWhenAllServerDocsAreFlushed((...args: any[]) => callbackInvoker.dataVisible(...args));
    });
  }

  public _pushUpdate(updates: Record<string, DocumentMessage[]>, collection: string, msg: DocumentMessage): void {
    if (!Object.prototype.hasOwnProperty.call(updates, collection)) {
      updates[collection] = [];
    }
    updates[collection].push(msg);
  }

  public _getServerDoc(collection: string, id: string): any {
    const self = this._connection;
    if (!Object.prototype.hasOwnProperty.call(self._serverDocuments, collection)) {
      return null;
    }
    const serverDocsForCollection = self._serverDocuments[collection];
    return serverDocsForCollection.get(id) || null;
  }
}