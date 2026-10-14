/**
 * Cognito Authentication — PKCE Authorization Code Flow
 *
 * Implements browser-side authentication against a Cognito User Pool hosted UI
 * using the OAuth 2.0 authorization code grant with PKCE (no client secret).
 *
 * Reads runtime configuration from `window.__CONFIG__.cognito`, which is
 * generated at deploy time by the WebUiConstruct and served as config.js:
 *   {
 *     userPoolId, clientId, domain, redirectUri, logoutUri
 *   }
 *
 * Exposes the following functions on `window`, consumed by app.js:
 *   initAuth()        -> Promise<boolean>  true if authenticated, false if redirecting
 *   getIdToken()      -> Promise<string|null>  valid ID token (refreshed if needed)
 *   refreshTokens()   -> Promise<boolean>  attempt silent refresh, true on success
 *   redirectToLogin() -> void  send the browser to the hosted UI login page
 *   logout()          -> void  clear tokens and hit the Cognito logout endpoint
 *   getUserEmail()    -> string|null  email claim from the stored ID token
 */

/* global window, document, fetch, localStorage, sessionStorage, crypto, TextEncoder, atob */

(function () {
  'use strict';

  var CONFIG = (window.__CONFIG__ && window.__CONFIG__.cognito) || {};

  // Storage keys
  var STORAGE_PREFIX = 'glacier_restore_';
  var KEY_ID_TOKEN = STORAGE_PREFIX + 'id_token';
  var KEY_ACCESS_TOKEN = STORAGE_PREFIX + 'access_token';
  var KEY_REFRESH_TOKEN = STORAGE_PREFIX + 'refresh_token';
  var KEY_EXPIRES_AT = STORAGE_PREFIX + 'expires_at';
  var KEY_PKCE_VERIFIER = STORAGE_PREFIX + 'pkce_verifier';
  var KEY_OAUTH_STATE = STORAGE_PREFIX + 'oauth_state';

  // Refresh the token when it's within this window of expiry (ms)
  var EXPIRY_SKEW_MS = 60 * 1000; // 60 seconds

  // The OAuth scopes requested, matching the User Pool Client configuration
  var SCOPES = 'openid email profile';

  // --- PKCE Helpers ---

  /**
   * Generate a cryptographically random URL-safe string for use as a PKCE
   * code verifier or OAuth state value.
   */
  function randomUrlSafeString(byteLength) {
    var bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64UrlEncodeBytes(bytes);
  }

  /**
   * Base64url-encode a Uint8Array (no padding).
   */
  function base64UrlEncodeBytes(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Derive a PKCE code challenge (S256) from a code verifier.
   */
  async function deriveCodeChallenge(verifier) {
    var encoder = new TextEncoder();
    var data = encoder.encode(verifier);
    var digest = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncodeBytes(new Uint8Array(digest));
  }

  // --- Token Storage ---

  function storeTokens(tokens) {
    if (tokens.id_token) localStorage.setItem(KEY_ID_TOKEN, tokens.id_token);
    if (tokens.access_token) localStorage.setItem(KEY_ACCESS_TOKEN, tokens.access_token);
    // Cognito omits refresh_token on refresh-grant responses; keep the existing one.
    if (tokens.refresh_token) localStorage.setItem(KEY_REFRESH_TOKEN, tokens.refresh_token);
    if (tokens.expires_in) {
      var expiresAt = Date.now() + (parseInt(tokens.expires_in, 10) * 1000);
      localStorage.setItem(KEY_EXPIRES_AT, String(expiresAt));
    }
  }

  function clearTokens() {
    localStorage.removeItem(KEY_ID_TOKEN);
    localStorage.removeItem(KEY_ACCESS_TOKEN);
    localStorage.removeItem(KEY_REFRESH_TOKEN);
    localStorage.removeItem(KEY_EXPIRES_AT);
  }

  function getStoredIdToken() {
    return localStorage.getItem(KEY_ID_TOKEN);
  }

  function getStoredRefreshToken() {
    return localStorage.getItem(KEY_REFRESH_TOKEN);
  }

  function isTokenExpired() {
    var expiresAt = parseInt(localStorage.getItem(KEY_EXPIRES_AT) || '0', 10);
    if (!expiresAt) return true;
    return Date.now() >= (expiresAt - EXPIRY_SKEW_MS);
  }

  // --- JWT Decoding ---

  /**
   * Decode the payload of a JWT. Returns null on any parsing failure.
   * This does NOT verify the signature — verification is enforced server-side
   * by the API Gateway Cognito authorizer.
   */
  function decodeJwtPayload(token) {
    if (!token) return null;
    try {
      var parts = token.split('.');
      if (parts.length !== 3) return null;
      var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      // Pad to a multiple of 4 for atob
      while (payload.length % 4 !== 0) {
        payload += '=';
      }
      var json = window.atob(payload);
      return JSON.parse(json);
    } catch (err) {
      return null;
    }
  }

  // --- Configuration Validation ---

  function configIsValid() {
    return Boolean(CONFIG && CONFIG.clientId && CONFIG.domain && CONFIG.redirectUri);
  }

  function normalizedDomain() {
    // CONFIG.domain is the full URL, e.g. https://auth-xxx.auth.us-east-1.amazoncognito.com
    return (CONFIG.domain || '').replace(/\/+$/, '');
  }

  // --- Authorization Code Flow ---

  /**
   * Begin the login flow: generate PKCE values, persist them, and redirect the
   * browser to the Cognito hosted UI authorize endpoint.
   */
  async function redirectToLogin() {
    if (!configIsValid()) {
      // Surface a clear console error rather than silently failing.
      // eslint-disable-next-line no-console
      console.error('[auth] Cognito configuration is missing or incomplete. Cannot redirect to login.');
      return;
    }

    var verifier = randomUrlSafeString(32);
    var state = randomUrlSafeString(16);
    var challenge = await deriveCodeChallenge(verifier);

    // Persist verifier/state across the redirect round-trip.
    sessionStorage.setItem(KEY_PKCE_VERIFIER, verifier);
    sessionStorage.setItem(KEY_OAUTH_STATE, state);

    var params = new window.URLSearchParams({
      response_type: 'code',
      client_id: CONFIG.clientId,
      redirect_uri: CONFIG.redirectUri,
      scope: SCOPES,
      state: state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    window.location.assign(normalizedDomain() + '/oauth2/authorize?' + params.toString());
  }

  /**
   * Exchange an authorization code for tokens at the Cognito token endpoint.
   * Returns true on success.
   */
  async function exchangeCodeForTokens(code) {
    var verifier = sessionStorage.getItem(KEY_PKCE_VERIFIER);
    if (!verifier) {
      // eslint-disable-next-line no-console
      console.error('[auth] Missing PKCE verifier — cannot complete token exchange.');
      return false;
    }

    var body = new window.URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CONFIG.clientId,
      code: code,
      redirect_uri: CONFIG.redirectUri,
      code_verifier: verifier,
    });

    try {
      var response = await fetch(normalizedDomain() + '/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        // eslint-disable-next-line no-console
        console.error('[auth] Token exchange failed with status ' + response.status);
        return false;
      }

      var tokens = await response.json();
      storeTokens(tokens);
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] Token exchange error:', err.message);
      return false;
    } finally {
      sessionStorage.removeItem(KEY_PKCE_VERIFIER);
      sessionStorage.removeItem(KEY_OAUTH_STATE);
    }
  }

  /**
   * Attempt to silently refresh tokens using the stored refresh token.
   * Returns true on success, false if no refresh token or the request fails.
   */
  async function refreshTokens() {
    if (!configIsValid()) return false;

    var refreshToken = getStoredRefreshToken();
    if (!refreshToken) return false;

    var body = new window.URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CONFIG.clientId,
      refresh_token: refreshToken,
    });

    try {
      var response = await fetch(normalizedDomain() + '/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        clearTokens();
        return false;
      }

      var tokens = await response.json();
      storeTokens(tokens);
      return Boolean(getStoredIdToken());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] Token refresh error:', err.message);
      return false;
    }
  }

  /**
   * Return a valid ID token, refreshing it if it is expired or near expiry.
   * Returns null if no valid token can be obtained.
   */
  async function getIdToken() {
    var token = getStoredIdToken();
    if (!token) return null;

    if (isTokenExpired()) {
      var refreshed = await refreshTokens();
      if (!refreshed) return null;
      return getStoredIdToken();
    }

    return token;
  }

  /**
   * Return the email claim from the stored ID token, or null.
   */
  function getUserEmail() {
    var claims = decodeJwtPayload(getStoredIdToken());
    if (!claims) return null;
    return claims.email || claims['cognito:username'] || null;
  }

  /**
   * Clear tokens and redirect to the Cognito logout endpoint, which clears the
   * hosted UI session and returns the browser to the configured logout URI.
   */
  function logout() {
    clearTokens();

    if (!configIsValid()) {
      // Fall back to a local reload if config is unavailable.
      window.location.reload();
      return;
    }

    var logoutUri = CONFIG.logoutUri || CONFIG.redirectUri;
    var params = new window.URLSearchParams({
      client_id: CONFIG.clientId,
      logout_uri: logoutUri,
    });

    window.location.assign(normalizedDomain() + '/logout?' + params.toString());
  }

  /**
   * Strip OAuth query parameters (code, state, error) from the current URL
   * without reloading the page, so the address bar is clean after login.
   */
  function cleanUpUrl() {
    if (window.history && window.history.replaceState) {
      var cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }

  /**
   * Initialize authentication on page load.
   *
   * Flow:
   *   1. If the URL carries an OAuth error, clear it and redirect to login.
   *   2. If the URL carries an authorization code, validate state and exchange
   *      it for tokens.
   *   3. If a valid (or refreshable) token is already stored, continue.
   *   4. Otherwise, redirect to the hosted UI login page.
   *
   * Returns true if the caller may proceed as authenticated, or false if the
   * browser is being redirected (login or callback handling).
   */
  async function initAuth() {
    if (!configIsValid()) {
      // eslint-disable-next-line no-console
      console.error('[auth] Cognito configuration missing. Ensure config.js is deployed with cognito settings.');
      return false;
    }

    var query = new window.URLSearchParams(window.location.search);

    // Handle an error returned from the hosted UI.
    if (query.has('error')) {
      // eslint-disable-next-line no-console
      console.error('[auth] OAuth error:', query.get('error'), query.get('error_description') || '');
      cleanUpUrl();
      await redirectToLogin();
      return false;
    }

    // Handle the authorization code callback.
    if (query.has('code')) {
      var returnedState = query.get('state');
      var expectedState = sessionStorage.getItem(KEY_OAUTH_STATE);

      if (expectedState && returnedState !== expectedState) {
        // eslint-disable-next-line no-console
        console.error('[auth] OAuth state mismatch — possible CSRF. Restarting login.');
        cleanUpUrl();
        await redirectToLogin();
        return false;
      }

      var exchanged = await exchangeCodeForTokens(query.get('code'));
      cleanUpUrl();

      if (!exchanged) {
        await redirectToLogin();
        return false;
      }
      return true;
    }

    // No callback params — check for an existing session.
    var token = await getIdToken();
    if (token) {
      return true;
    }

    // Not authenticated — start the login flow.
    await redirectToLogin();
    return false;
  }

  // --- Expose the public API on window for app.js ---
  window.initAuth = initAuth;
  window.getIdToken = getIdToken;
  window.refreshTokens = refreshTokens;
  window.redirectToLogin = redirectToLogin;
  window.logout = logout;
  window.getUserEmail = getUserEmail;
})();
