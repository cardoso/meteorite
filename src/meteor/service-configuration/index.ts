import { Mongo } from 'meteor/mongo';
import { Accounts } from 'meteor/accounts-base';

export type Configuration = {
  _id: string;
  service: string;
  appId?: string;
  clientId?: string;
  secret?: string;
  [key: string]: any; // Extensible for specific OAuth providers
};

export class ConfigError extends Error {
  constructor(serviceName?: string) {
    super();
    this.name = 'ServiceConfiguration.ConfigError';
    
    if (!Accounts.loginServicesConfigured()) {
      this.message = 'Login service configuration not yet loaded';
    } else if (serviceName) {
      this.message = `Service ${serviceName} not configured`;
    } else {
      this.message = 'Service not configured';
    }
  }
}

export const configurations = new Mongo.Collection<Configuration>(
  'meteor_accounts_loginServiceConfiguration',
  {
    _preventAutopublish: true,
    connection: Accounts.connection,
  }
);

// Grouped export for backwards compatibility with the legacy global API
export const ServiceConfiguration = {
  configurations,
  ConfigError,
};