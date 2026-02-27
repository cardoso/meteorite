import { Reload } from 'meteor/reload'; // Assumed to be provided or mocked in the modern stack

export const STORAGE_TOKEN_PREFIX = "Meteor.oauth.credentialSecret-";

const credentialSecrets: Record<string, string> = {};

export type LoginStyle = 'popup' | 'redirect';

export type OAuthConfig = {
  loginStyle?: LoginStyle;
};

export type PopupDimensions = {
  width?: number;
  height?: number;
};

export type LaunchLoginOptions = {
  loginService: string;
  loginStyle: LoginStyle;
  loginUrl: string;
  credentialRequestCompleteCallback: (credentialToken: string) => void;
  credentialToken: string;
  popupOptions?: PopupDimensions;
};

export type RedirectData = {
  loginService: string;
  credentialToken: string;
  credentialSecret: string | null;
};

/**
 * Determines the login style (popup or redirect) for this login flow.
 */
export const _loginStyle = (
  _service: string,
  config: OAuthConfig,
  options?: { loginStyle?: LoginStyle }
): LoginStyle => {
  let loginStyle = options?.loginStyle || config.loginStyle || 'popup';

  if (loginStyle !== 'popup' && loginStyle !== 'redirect') {
    throw new Error(`Invalid login style: ${loginStyle}`);
  }

  // Fallback to popup if session storage is unavailable (e.g., Safari Private Mode)
  if (loginStyle === 'redirect') {
    try {
      sessionStorage.setItem('Meteor.oauth.test', 'test');
      sessionStorage.removeItem('Meteor.oauth.test');
    } catch (e) {
      loginStyle = 'popup';
    }
  }

  return loginStyle;
};

/**
 * Generates the state parameter for the OAuth request.
 */
export const generateStateParam = (
  loginStyle: LoginStyle,
  credentialToken: string,
  redirectUrl?: string,
  setRedirectUrlWhenLoginStyleIsPopup?: boolean
): string => {
  const state: Record<string, unknown> = {
    loginStyle,
    credentialToken,
    isCordova: false, // Hardcoded to false for modern web
  };

  if (loginStyle === 'redirect' || (setRedirectUrlWhenLoginStyleIsPopup && loginStyle === 'popup')) {
    state.redirectUrl = redirectUrl || window.location.toString();
  }

  // Modern browsers support btoa directly
  return btoa(JSON.stringify(state));
};

/**
 * Saves migration data for the redirect flow.
 */
export const saveDataForRedirect = (loginService: string, credentialToken: string): void => {
  Reload._onMigrate('oauth', () => [true, { loginService, credentialToken }]);
  Reload._migrate(null, { immediateMigration: true });
};

/**
 * Retrieves the credential data after returning from a redirect flow.
 */
export const getDataAfterRedirect = (): RedirectData | null => {
  const migrationData = Reload._migrationData('oauth') as { loginService?: string; credentialToken?: string } | null;

  if (!migrationData || !migrationData.credentialToken) {
    return null;
  }

  const { credentialToken } = migrationData;
  const key = STORAGE_TOKEN_PREFIX + credentialToken;
  let credentialSecret: string | null = null;

  try {
    credentialSecret = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
  } catch (e) {
    console.error('Error retrieving credentialSecret', e);
  }

  return {
    loginService: migrationData.loginService as string,
    credentialToken,
    credentialSecret,
  };
};

/**
 * Opens a centered popup for the OAuth login flow.
 */
export const showPopup = (url: string, callback: () => void, dimensions?: PopupDimensions): void => {
  const width = dimensions?.width || 650;
  const height = dimensions?.height || 331;

  const screenX = typeof window.screenX !== 'undefined' ? window.screenX : window.screenLeft;
  const screenY = typeof window.screenY !== 'undefined' ? window.screenY : window.screenTop;
  const outerWidth = typeof window.outerWidth !== 'undefined' ? window.outerWidth : document.body.clientWidth;
  const outerHeight = typeof window.outerHeight !== 'undefined' ? window.outerHeight : (document.body.clientHeight - 22);

  const left = screenX + (outerWidth - width) / 2;
  const top = screenY + (outerHeight - height) / 2;
  const features = `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`;

  const newwindow = window.open(url, 'Login', features);

  if (!newwindow || newwindow.closed) {
    const err = new Error("The login popup was blocked by the browser") as Error & { attemptedUrl: string };
    err.attemptedUrl = url;
    throw err;
  }

  if (newwindow.focus) {
    newwindow.focus();
  }

  const checkPopupOpen = setInterval(() => {
    let popupClosed = false;
    try {
      popupClosed = newwindow.closed || newwindow.closed === undefined;
    } catch (e) {
      // IE9/Edge legacy compatibility where accessing properties throws errors
      return;
    }

    if (popupClosed) {
      clearInterval(checkPopupOpen);
      callback();
    }
  }, 100);
};

/**
 * Launches an OAuth login flow.
 */
export const launchLogin = (options: LaunchLoginOptions): void => {
  if (!options.loginService) {
    throw new Error('loginService required');
  }

  if (options.loginStyle === 'popup') {
    showPopup(
      options.loginUrl,
      () => options.credentialRequestCompleteCallback(options.credentialToken),
      options.popupOptions
    );
  } else if (options.loginStyle === 'redirect') {
    saveDataForRedirect(options.loginService, options.credentialToken);
    window.location.href = options.loginUrl;
  } else {
    throw new Error('Invalid login style');
  }
};

/**
 * Called by the popup when the OAuth flow is completed, before it closes.
 */
export const handleCredentialSecret = (credentialToken: string, secret: string): void => {
  if (typeof credentialToken !== 'string' || typeof secret !== 'string') {
    throw new Error('Invalid token or secret types');
  }

  if (!Object.prototype.hasOwnProperty.call(credentialSecrets, credentialToken)) {
    credentialSecrets[credentialToken] = secret;
  } else {
    throw new Error("Duplicate credential token from OAuth login");
  }
};

/**
 * Retrieves the credential secret (used by accounts-oauth to call the DDP login method).
 */
export const _retrieveCredentialSecret = (credentialToken: string): string | null => {
  let secret = credentialSecrets[credentialToken];
  
  if (!secret) {
    const localStorageKey = STORAGE_TOKEN_PREFIX + credentialToken;
    secret = window.localStorage.getItem(localStorageKey) || '';
    window.localStorage.removeItem(localStorageKey);
  } else {
    delete credentialSecrets[credentialToken];
  }
  
  return secret || null;
};