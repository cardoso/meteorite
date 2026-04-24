import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('meteor/reload', () => ({
  Reload: {
    _onMigrate: vi.fn(),
    _migrate: vi.fn(),
    _migrationData: vi.fn(),
  },
}));

import { Reload } from 'meteor/reload';
import {
  _loginStyle,
  _redirectUri,
  _retrieveCredentialSecret,
  _stateParam,
  STORAGE_TOKEN_PREFIX,
  generateStateParam,
  getDataAfterRedirect,
  handleCredentialSecret,
  launchLogin,
  saveDataForRedirect,
  showPopup,
} from './oauth';

describe('oauth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('chooses popup by default and validates loginStyle', () => {
    expect(_loginStyle('google', {})).toBe('popup');
    expect(() => _loginStyle('google', {}, { loginStyle: 'invalid' })).toThrow(/Invalid login style/);
  });

  it('falls back from redirect to popup when sessionStorage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    });

    expect(_loginStyle('google', { loginStyle: 'redirect' })).toBe('popup');
  });

  it('encodes state parameters and includes redirect URL only when required', () => {
    const redirectState = JSON.parse(atob(generateStateParam('redirect', 'token-a', 'https://app.example/after')));
    expect(redirectState).toMatchObject({
      loginStyle: 'redirect',
      credentialToken: 'token-a',
      isCordova: false,
      redirectUrl: 'https://app.example/after',
    });

    const popupState = JSON.parse(atob(generateStateParam('popup', 'token-b')));
    expect(popupState).toMatchObject({
      loginStyle: 'popup',
      credentialToken: 'token-b',
      isCordova: false,
    });
    expect(popupState.redirectUrl).toBeUndefined();

    const popupWithRedirect = JSON.parse(
      atob(_stateParam('popup', 'token-c', 'https://app.example/popup', true))
    );
    expect(popupWithRedirect.redirectUrl).toBe('https://app.example/popup');
  });

  it('saves redirect migration data using Reload hooks', () => {
    saveDataForRedirect('google', 'cred-token');

    expect(Reload._onMigrate).toHaveBeenCalledWith('oauth', expect.any(Function));
    expect(Reload._migrate).toHaveBeenCalledWith(null, { immediateMigration: true });

    const migrateCallback = (Reload._onMigrate as unknown as { mock: { calls: Array<Array<any>> } }).mock.calls[0][1];
    expect(migrateCallback()).toEqual([true, { loginService: 'google', credentialToken: 'cred-token' }]);
  });

  it('returns null from getDataAfterRedirect when no migration data exists', () => {
    (Reload._migrationData as unknown as { mockReturnValueOnce: (value: unknown) => void }).mockReturnValueOnce(null);
    expect(getDataAfterRedirect()).toBeNull();
  });

  it('loads and removes credentialSecret from sessionStorage after redirect', () => {
    const token = 'redir-token';
    const key = STORAGE_TOKEN_PREFIX + token;

    (Reload._migrationData as unknown as { mockReturnValueOnce: (value: unknown) => void }).mockReturnValueOnce({
      loginService: 'google',
      credentialToken: token,
    });
    window.sessionStorage.setItem(key, 'redir-secret');

    const result = getDataAfterRedirect();

    expect(result).toEqual({
      loginService: 'google',
      credentialToken: token,
      credentialSecret: 'redir-secret',
    });
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('handles sessionStorage access errors in getDataAfterRedirect', () => {
    const token = 'redir-token-error';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    (Reload._migrationData as unknown as { mockReturnValueOnce: (value: unknown) => void }).mockReturnValueOnce({
      loginService: 'github',
      credentialToken: token,
    });

    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('storage denied');
      },
      removeItem: () => {},
    });

    const result = getDataAfterRedirect();

    expect(result).toEqual({
      loginService: 'github',
      credentialToken: token,
      credentialSecret: null,
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('showPopup throws when the popup is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    expect(() => showPopup('https://example.com/login', () => {})).toThrow(/popup was blocked/);
  });

  it('showPopup invokes callback when popup closes', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const popup = { closed: false, focus: vi.fn() } as unknown as Window;

    vi.spyOn(window, 'open').mockReturnValue(popup);

    showPopup('https://example.com/login', callback);
    (popup as unknown as { closed: boolean }).closed = true;

    vi.advanceTimersByTime(100);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('launchLogin popup flow completes with credential token', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const popup = { closed: false, focus: vi.fn() } as unknown as Window;

    vi.spyOn(window, 'open').mockReturnValue(popup);

    launchLogin({
      loginService: 'google',
      loginStyle: 'popup',
      loginUrl: 'https://example.com/login',
      credentialToken: 'popup-token',
      credentialRequestCompleteCallback: callback,
    });

    (popup as unknown as { closed: boolean }).closed = true;
    vi.advanceTimersByTime(100);

    expect(callback).toHaveBeenCalledWith('popup-token');
  });

  it('launchLogin validates required fields and styles', () => {
    expect(() =>
      launchLogin({
        loginService: '',
        loginStyle: 'popup',
        loginUrl: 'https://example.com/login',
        credentialToken: 'token',
      })
    ).toThrow(/loginService required/);

    expect(() =>
      launchLogin({
        loginService: 'google',
        loginStyle: 'invalid' as never,
        loginUrl: 'https://example.com/login',
        credentialToken: 'token',
      })
    ).toThrow(/Invalid login style/);
  });

  it('stores and retrieves credential secrets from memory and localStorage', () => {
    const token = 'token-memory';
    handleCredentialSecret(token, 'secret-memory');

    expect(_retrieveCredentialSecret(token)).toBe('secret-memory');
    expect(_retrieveCredentialSecret(token)).toBeNull();

    const tokenFromStorage = 'token-storage';
    window.localStorage.setItem(STORAGE_TOKEN_PREFIX + tokenFromStorage, 'secret-storage');

    expect(_retrieveCredentialSecret(tokenFromStorage)).toBe('secret-storage');
    expect(window.localStorage.getItem(STORAGE_TOKEN_PREFIX + tokenFromStorage)).toBeNull();
  });

  it('prevents duplicate credential tokens and validates token/secret types', () => {
    const token = 'dup-token';
    handleCredentialSecret(token, 'secret-1');

    expect(() => handleCredentialSecret(token, 'secret-2')).toThrow(/Duplicate credential token/);
    expect(() => handleCredentialSecret(1 as never, 'secret')).toThrow(/Invalid token or secret types/);
    expect(() => handleCredentialSecret('token', 1 as never)).toThrow(/Invalid token or secret types/);
  });

  it('builds redirect URI and filters legacy mobile parameters', () => {
    const uri = _redirectUri(
      'google',
      undefined,
      {
        state: 'abc',
        cordova: 'true',
        android: 'true',
        foo: 'bar',
      },
      { rootUrl: 'https://app.example' }
    );

    expect(uri).toBe('https://app.example/_oauth/google?state=abc&foo=bar');
  });
});
