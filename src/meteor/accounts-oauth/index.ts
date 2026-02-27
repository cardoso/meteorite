import { Meteor } from 'meteor/meteor';
import { OAuth } from 'meteor/oauth';
import { Accounts } from 'meteor/accounts-base';
import { ServiceConfiguration } from 'meteor/service-configuration';

const services: Record<string, boolean> = {};

// Helper to map numeric error codes to the specific LoginCancelledError
const convertError = (err: Error | Meteor.Error | undefined): Error | undefined => {
    if (
        err &&
        err instanceof Meteor.Error &&
        err.error === new Accounts.LoginCancelledError().numericError
    ) {
        return new Accounts.LoginCancelledError(err.reason);
    }
    return err;
};

export const AccountsOAuth = {
    /**
     * Registers an OAuth based accounts service.
     */
    registerService(name: string): void {
        if (Object.prototype.hasOwnProperty.call(services, name)) {
            throw new Error(`Duplicate service: ${name}`);
        }
        services[name] = true;
    },

    /**
     * Removes a previously registered service.
     */
    unregisterService(name: string): void {
        if (!Object.prototype.hasOwnProperty.call(services, name)) {
            throw new Error(`Service not found: ${name}`);
        }
        delete services[name];
    },

    /**
     * Returns a list of all registered OAuth service names.
     */
    serviceNames(): string[] {
        return Object.keys(services);
    },

    /**
     * Polls local storage for the credential secret after an OAuth popup closes.
     */
    tryLoginAfterPopupClosed(
        credentialToken: string,
        callback?: (err?: Error | Meteor.Error) => void,
        timeout: number = 1000
    ): void {
        const startTime = Date.now();
        let calledOnce = false;
        let intervalId: ReturnType<typeof setInterval>;

        const checkForCredentialSecret = (clearIntervalFlag = false) => {
            // @ts-expect-error - _retrieveCredentialSecret is an internal OAuth method
            const credentialSecret = OAuth._retrieveCredentialSecret(credentialToken);

            if (!calledOnce && (credentialSecret || clearIntervalFlag)) {
                calledOnce = true;
                clearInterval(intervalId);
                Accounts.callLoginMethod({
                    methodArguments: [{ oauth: { credentialToken, credentialSecret } }],
                    userCallback: callback ? (err) => callback(convertError(err)) : () => { },
                });
            } else if (clearIntervalFlag) {
                clearInterval(intervalId);
            }
        };

        // Check immediately
        checkForCredentialSecret();

        // Then check on an interval (local storage might not be immediately ready)
        intervalId = setInterval(() => {
            if (Date.now() - startTime > timeout) {
                checkForCredentialSecret(true);
            } else {
                checkForCredentialSecret();
            }
        }, 250);
    },

    /**
     * Handles the completion of an OAuth credential request.
     */
    credentialRequestCompleteHandler(callback?: (err?: Error | Meteor.Error) => void) {
        return (credentialTokenOrError: string | Error) => {
            if (credentialTokenOrError && credentialTokenOrError instanceof Error) {
                if (callback) callback(credentialTokenOrError);
            } else {
                this.tryLoginAfterPopupClosed(credentialTokenOrError as string, callback);
            }
        };
    }
};

/**
 * Initializes the OAuth handling mechanisms. 
 * This should be called once at application startup.
 */
export const initAccountsOAuth = (): void => {
    // 1. Maintain backwards compatibility by attaching properties to the global Accounts instance
    Accounts.oauth = AccountsOAuth;
    Accounts.loginServiceConfiguration = ServiceConfiguration.configurations;
    Accounts.ConfigError = ServiceConfiguration.ConfigError;

    // 2. Process OAuth redirect flow (if the app was just redirected back from an OAuth provider)
    const oauthData = OAuth.getDataAfterRedirect();
    if (!oauthData) return;

    const methodName = 'login';
    const { credentialToken, credentialSecret, loginService } = oauthData;
    const methodArguments = [{ oauth: { credentialToken, credentialSecret } }];

    // Call the login method with the retrieved secret
    Accounts.callLoginMethod({
        methodArguments,
        userCallback: (err: any) => {
            const convertedErr = convertError(err);

            // Register the page load login attempt info
            Accounts._pageLoadLogin({
                type: loginService,
                allowed: !convertedErr,
                error: convertedErr,
                methodName,
                methodArguments,
            });
        }
    });
};