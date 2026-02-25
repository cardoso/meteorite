import { EJSON } from 'meteor/ejson';
import { Random } from 'meteor/random';

export const _looksLikeObjectID = (str: string): boolean => {
    return str.length === 24 && /^[0-9a-f]*$/.test(str);
};

export class ObjectID {
    _str: string;

    constructor(hexString?: string) {
        if (hexString) {
            hexString = hexString.toLowerCase();
            if (!_looksLikeObjectID(hexString)) {
                throw new Error('Invalid hexadecimal string for creating an ObjectID');
            }
            this._str = hexString;
        } else {
            this._str = Random.hexString(24);
        }
    }

    equals(other: unknown): boolean {
        return other instanceof ObjectID && this.valueOf() === (other as ObjectID).valueOf();
    }

    toString(): string {
        return `ObjectID("${this._str}")`;
    }

    clone(): ObjectID {
        return new ObjectID(this._str);
    }

    typeName(): string {
        return 'oid';
    }

    getTimestamp(): number {
        return Number.parseInt(this._str.substring(0, 8), 16);
    }

    valueOf(): string {
        return this._str;
    }

    toJSONValue(): string {
        return this.valueOf();
    }

    toHexString(): string {
        return this.valueOf();
    }
}

// Register the custom type with EJSON
EJSON.addType('oid', (str: string) => new ObjectID(str));

export const idStringify = (id: unknown): string => {
    if (id instanceof ObjectID) {
        return id.valueOf();
    } else if (typeof id === 'string') {
        const firstChar = id.charAt(0);
        if (id === '') {
            return id;
        } else if (
            firstChar === '-' || // escape previously dashed strings
            firstChar === '~' || // escape escaped numbers, true, false
            _looksLikeObjectID(id) || // escape object-id-form strings
            firstChar === '{' // escape object-form strings, for maybe implementing later
        ) {
            return `-${id}`;
        } else {
            return id; // other strings go through unchanged.
        }
    } else if (id === undefined) {
        return '-';
    } else if (typeof id === 'object' && id !== null) {
        throw new Error('Meteor does not currently support objects other than ObjectID as ids');
    } else {
        // Numbers, true, false, null
        return `~${JSON.stringify(id)}`;
    }
};

export const idParse = (id: string): unknown => {
    const firstChar = id.charAt(0);
    if (id === '') {
        return id;
    } else if (id === '-') {
        return undefined;
    } else if (firstChar === '-') {
        return id.substring(1);
    } else if (firstChar === '~') {
        return JSON.parse(id.substring(1));
    } else if (_looksLikeObjectID(id)) {
        return new ObjectID(id);
    } else {
        return id;
    }
};