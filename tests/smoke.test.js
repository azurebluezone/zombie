import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiKey, hashSecret, authenticateApiKey } from '../src/auth/application-auth.js';
test('api key hash authenticates active non-expired application', () => { const key=createApiKey(); const app={id:'app_1',apiKeyHash:hashSecret(key),status:'active',expiresAt:null}; assert.equal(authenticateApiKey(key,[app]).id,'app_1'); });
test('expired application is rejected', () => { const key=createApiKey(); const app={id:'app_1',apiKeyHash:hashSecret(key),status:'active',expiresAt:'2020-01-01T00:00:00Z'}; assert.equal(authenticateApiKey(key,[app]),null); });
