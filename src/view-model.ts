import type { MemberApiResult, ProjectGoal } from './service.js';
import type { ProfileDetailsResult, SkillsApiResult } from './extra-api-model.js';

/** Only verified profile data reaches the page. Tokens never enter this model. */
export interface Verification {
  issuer: string;
  audience: string;
  sub: string;
  algorithm: 'RS256';
  nonce: true;
  pkce: 'S256';
  state: true;
  issuerResponse: true;
  signature: true;
  userInfoSubject: true;
  authenticatedAt: string;
  checkedAt: string;
}

export interface Identity {
  profile: { sub: string; nickname?: string };
  verification: Verification;
  memberApi?: MemberApiResult;
  profileDetails?: ProfileDetailsResult;
  skillsApi?: SkillsApiResult;
}

export interface HomeViewModel {
  page?: 'home' | 'profile' | 'skills' | 'projects';
  skillsVisibleCount?: number;
  issuer: string;
  clientId: string;
  baseUrl: string;
  loginAction: '/login';
  logoutAction: '/logout';
  authenticated: boolean;
  profile?: Identity['profile'];
  verification?: Verification;
  memberApi?: MemberApiResult;
  profileDetails?: ProfileDetailsResult;
  skillsApi?: SkillsApiResult;
  projectGoal?: ProjectGoal;
  serviceError?: string;
  error?: string;
}
