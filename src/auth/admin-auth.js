import { safeEqual } from './application-auth.js';

export function isAdminAuthorized(bearerToken, configuredAdminToken) {
  return Boolean(configuredAdminToken) && safeEqual(bearerToken, configuredAdminToken);
}
