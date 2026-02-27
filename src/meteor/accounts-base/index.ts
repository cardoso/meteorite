import { AccountsClient } from "./accounts-client.ts";

export interface Accounts extends AccountsClient {

}

export const Accounts: Accounts = new AccountsClient();