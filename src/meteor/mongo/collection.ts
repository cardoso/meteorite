import { LocalCollection } from "meteor/minimongo";
import { EJSON } from "meteor/ejson";
import { Random } from "meteor/random";
// Note: Adjust import paths to match where you extracted/hosted these packages
// If using standard MongoDB object IDs, you can replace MongoID with a bson ObjectId
import { MongoID } from "meteor/mongo-id";

export type Document = { _id: string;[key: string]: any };
export type Selector = Partial<Document> | string;
export type Modifier = { $set?: Record<string, any>; $unset?: Record<string, any>; [key: string]: any };

export type CollectionOptions<T, U = T> = {
  connection: DDPConnection;
  idGeneration?: "STRING" | "MONGO";
  transform?: ((doc: T) => U) | null;
  defineMutationMethods?: boolean;
};

export type DDPConnection = {
  apply: (name: string, args: any[], options?: any, callback?: Function) => void;
  applyAsync?: (name: string, args: any[], options?: any) => Promise<any>;
  registerStore?: (name: string, store: any) => void;
  registerStoreClient?: (name: string, store: any) => void; // Add this
};

export type UpdateOptions = {
  multi?: boolean;
  upsert?: boolean;
  arrayFilters?: Record<string, any>[];
  insertedId?: string | any;
};

export class Collection<T extends Document = Document, U = T> {
  private _name: string | null;
  private _localCollection: LocalCollection;
  private _connection: DDPConnection;
  private _transform: ((doc: T) => U) | null;
  private _idGeneration: "STRING" | "MONGO";

  constructor(name: string | null, options: CollectionOptions<T, U>) {
    this._name = name;
    this._connection = options.connection;
    this._idGeneration = options.idGeneration || "STRING";

    // In Meteor, LocalCollection handles the actual caching and Minimongo queries
    this._localCollection = new LocalCollection(name);

    // Wrap transform to safely ignore non-objects
    this._transform = options.transform
      ? (doc: T) => (doc && typeof doc === "object" ? options.transform!(doc) : doc as any)
      : null;

    if (this._isRemote()) {
      this._registerReplicationStore();
    }
  }

  private _isRemote(): boolean {
    return !!(this._name && this._connection);
  }

  private _generateId(): any {
    if (this._idGeneration === "MONGO") {
      return new MongoID.ObjectID();
    }
    return Random.id();
  }

  private _parseMongoId(id: string | any): any {
    return typeof id === "string" && id.startsWith("-") ? MongoID.idParse(id) : id;
  }

  /**
   * REPLICATION: Hooks up the DDP connection to the local Minimongo cache.
   * Equivalent to `methods_replication.js`.
   */
  private _registerReplicationStore() {
    // Support both the legacy Meteor name and a clean modern name
    const registerFn = this._connection.registerStoreClient || this._connection!.registerStore;
    if (!registerFn) return;

    const self = this;
    const store = {
      beginUpdate(batchSize: number, reset: boolean) {
        if (batchSize > 1 || reset) self._localCollection.pauseObservers();
        if (reset) self._localCollection.remove({});
      },

      update(msg: { msg: string; id: string; fields?: any; replace?: any }) {
        const mongoId = self._parseMongoId(msg.id);
        const doc = self._localCollection._docs.get(mongoId);

        if (msg.msg === "replace") {
          if (!msg.replace) {
            if (doc) self._localCollection.remove(mongoId);
          } else if (!doc) {
            self._localCollection.insert(msg.replace);
          } else {
            self._localCollection.update(mongoId, msg.replace);
          }
          return;
        }

        // Handle DDP Mergebox edge cases
        if (msg.msg === "added" && doc) msg.msg = "changed";
        else if (msg.msg === "removed" && !doc) return;
        else if (msg.msg === "changed" && !doc) {
          msg.msg = "added";
          if (msg.fields) {
            for (const field in msg.fields) {
              if (msg.fields[field] === undefined) delete msg.fields[field];
            }
          }
        }

        if (msg.msg === "added") {
          self._localCollection.insert({ _id: mongoId, ...msg.fields });
        } else if (msg.msg === "removed") {
          self._localCollection.remove(mongoId);
        } else if (msg.msg === "changed") {
          const keys = Object.keys(msg.fields || {});
          if (keys.length > 0) {
            const modifier: any = {};
            keys.forEach((key) => {
              const value = msg.fields![key];
              if (EJSON.equals(doc[key], value)) return;
              if (value === undefined) {
                if (!modifier.$unset) modifier.$unset = {};
                modifier.$unset[key] = 1;
              } else {
                if (!modifier.$set) modifier.$set = {};
                modifier.$set[key] = value;
              }
            });
            if (Object.keys(modifier).length > 0) {
              self._localCollection.update(mongoId, modifier);
            }
          }
        }
      },

      endUpdate() {
        self._localCollection.resumeObserversClient();
      },

      getDoc(id: string) {
        return self._localCollection.findOne(id);
      },

      saveOriginals() {
        self._localCollection.saveOriginals();
      },

      retrieveOriginals() {
        return self._localCollection.retrieveOriginals();
      },

      // The legacy DDP client relies on this existing to fetch the parent collection
      _getCollection() {
        return self;
      }
    };

    // Apply the registration
    registerFn.call(this._connection, this._name!, store);
  }

  // --- READ METHODS --- //

  find(selector: Selector = {}, options: any = {}) {
    return this._localCollection.find(selector, {
      transform: this._transform,
      ...options
    });
  }

  findOne(selector: Selector = {}, options: any = {}): U | undefined {
    return this._localCollection.findOne(selector, {
      transform: this._transform,
      ...options
    });
  }

  async findOneAsync(selector: Selector = {}, options: any = {}): Promise<U | undefined> {
    return this.findOne(selector, options);
  }

  async countDocuments(selector: Selector = {}, options: any = {}): Promise<number> {
    return this.find(selector, options).count();
  }

  async estimatedDocumentCount(): Promise<number> {
    return this.find().count();
  }

  // --- MUTATION METHODS (Optimistic UI + RPC) --- //

  private _applyRPC(methodName: string, args: any[], callback?: Function): void {
    if (!this._isRemote()) {
      if (callback) callback(null, null);
      return;
    }
    this._connection!.apply(methodName, args, {}, callback);
  }

  private _applyRPCAsync(methodName: string, args: any[]): Promise<any> {
    if (!this._isRemote()) return Promise.resolve(null);
    if (this._connection!.applyAsync) {
      return this._connection!.applyAsync(methodName, args);
    }
    return new Promise((resolve, reject) => {
      this._connection!.apply(methodName, args, {}, (err: any, res: any) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

  private _normalizeSelector(selector: Selector): any {
    if (typeof selector === "string" || selector instanceof MongoID.ObjectID) {
      return { _id: selector };
    }
    return selector;
  }

  insert(doc: Partial<T>, callback?: Function): any {
    const clonedDoc = EJSON.clone(doc) as T;
    if (!clonedDoc._id) clonedDoc._id = this._generateId();

    // Optimistic UI local stub application
    try {
      this._localCollection.insert(clonedDoc);
    } catch (e) {
      if (callback) return callback(e);
      throw e;
    }

    this._applyRPC(`/${this._name}/insert`, [clonedDoc], (err: any, res: any) => {
      if (callback) callback(err, res || clonedDoc._id);
    });

    return clonedDoc._id;
  }

  async insertAsync(doc: Partial<T>): Promise<any> {
    const clonedDoc = EJSON.clone(doc);
    if (!clonedDoc._id) clonedDoc._id = this._generateId();

    this._localCollection.insert(clonedDoc);
    const res = await this._applyRPCAsync(`/${this._name}/insertAsync`, [clonedDoc]);
    return res || clonedDoc._id;
  }

  update(selector: Selector, modifier: Modifier, options: UpdateOptions = {}, callback?: Function): number {
    selector = this._normalizeSelector(selector);
    let insertedId = options.insertedId;

    if (options.upsert) {
      if (!insertedId && (!selector || !(selector as any)._id)) {
        insertedId = this._generateId();
        options.insertedId = insertedId;
      }
    }

    let affected = 0;
    try {
      affected = this._localCollection.update(selector, modifier, options);
    } catch (e) {
      if (callback) return callback(e);
      throw e;
    }

    this._applyRPC(`/${this._name}/update`, [selector, modifier, options], callback);
    return affected;
  }

  async updateAsync(selector: Selector, modifier: Modifier, options: UpdateOptions = {}): Promise<number> {
    selector = this._normalizeSelector(selector);
    let insertedId = options.insertedId;

    if (options.upsert) {
      if (!insertedId && (!selector || !(selector as any)._id)) {
        insertedId = this._generateId();
        options.insertedId = insertedId;
      }
    }

    const affected = this._localCollection.update(selector, modifier, options);
    await this._applyRPCAsync(`/${this._name}/updateAsync`, [selector, modifier, options]);
    return affected;
  }

  remove(selector: Selector, callback?: Function): number {
    selector = this._normalizeSelector(selector);

    let affected = 0;
    try {
      affected = this._localCollection.remove(selector);
    } catch (e) {
      if (callback) return callback(e);
      throw e;
    }

    this._applyRPC(`/${this._name}/remove`, [selector], callback);
    return affected;
  }

  async removeAsync(selector: Selector): Promise<number> {
    selector = this._normalizeSelector(selector);
    const affected = this._localCollection.remove(selector);
    await this._applyRPCAsync(`/${this._name}/removeAsync`, [selector]);
    return affected;
  }

  upsert(selector: Selector, modifier: Modifier, options: UpdateOptions = {}, callback?: Function) {
    return this.update(selector, modifier, { ...options, upsert: true }, callback);
  }

  async upsertAsync(selector: Selector, modifier: Modifier, options: UpdateOptions = {}): Promise<any> {
    return this.updateAsync(selector, modifier, { ...options, upsert: true });
  }
}