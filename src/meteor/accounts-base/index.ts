import { AccountsClient } from './accounts-client.ts';
import { ServiceConfigurationMixin } from 'meteor/service-configuration';
import { PasswordAuthMixin } from 'meteor/accounts-password';
import { OAuthAuthMixin } from 'meteor/accounts-oauth';

// 1. Compose the classes. Order matters based on interface requirements!
// AccountsClient -> ServiceConfiguration -> Password -> OAuth
export class AppAccountsClient extends OAuthAuthMixin(
  PasswordAuthMixin(
    ServiceConfigurationMixin(AccountsClient)
  )
) {}

// 2. Instantiate the singleton
export const Accounts = new AppAccountsClient();