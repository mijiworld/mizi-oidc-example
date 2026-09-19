/** Safe log categories: never attach URLs, tokens, provider responses or original errors. */
export type LoginStage = 'callback' | 'discovery' | 'attempt_store' | 'attempt_consume' |
  'oidc_validation' | 'token_exchange' | 'id_token_validation' | 'userinfo' | 'session_write';

export class LoginFailure extends Error {
  constructor(readonly stage: LoginStage) {
    super('Login validation failed.');
    this.name = 'LoginFailure';
  }
}
