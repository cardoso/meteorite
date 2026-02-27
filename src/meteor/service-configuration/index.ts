import { Mongo } from 'meteor/mongo';

// Generic Constructor type for Mixins
export type Constructor<T = {}> = new (...args: any[]) => T;

export type Configuration = {
  service: string;
  appId?: string;
  clientId?: string;
  secret?: string;
  [key: string]: any; // Extensible for specific OAuth providers
};

export interface ServiceConfigurationRequirements {
  connection?: any; // The DDP connection instance
  loginServicesConfigured?(): boolean;
}

export class ConfigError extends Error {
  constructor(serviceName?: string, isConfigured: boolean = true) {
    super();
    this.name = 'ServiceConfiguration.ConfigError';
    
    if (!isConfigured) {
      this.message = 'Login service configuration not yet loaded';
    } else if (serviceName) {
      this.message = `Service ${serviceName} not configured`;
    } else {
      this.message = 'Service not configured';
    }
  }
}

/**
 * The Service Configuration Mixin
 */
export function ServiceConfigurationMixin<TBase extends Constructor<ServiceConfigurationRequirements>>(Base: TBase) {
  return class extends Base {
    
    private _loginServiceConfiguration?: Mongo.Collection<Configuration>;

    // LAZY INITIALIZATION: Prevents accessing `this.connection` synchronously 
    // during class instantiation, avoiding ESM Temporal Dead Zone crashes.
    public get loginServiceConfiguration(): Mongo.Collection<Configuration> {
      if (!this._loginServiceConfiguration) {
        this._loginServiceConfiguration = new Mongo.Collection<Configuration>(
          'meteor_accounts_loginServiceConfiguration',
          {
            _preventAutopublish: true,
            connection: this.connection,
          }
        );
      }
      return this._loginServiceConfiguration;
    }

    /**
     * Helper to instantiate and throw a ConfigError using the current instance's state.
     */
    public throwConfigError(serviceName?: string): never {
      const isConfigured = this.loginServicesConfigured ? this.loginServicesConfigured() : true;
      throw new ConfigError(serviceName, isConfigured);
    }
  };
}