#!/usr/bin/env node
'use strict';

/**
 * Deploy Realtime Database rules using a Google service-account JSON.
 *
 * firebase-tools `deploy --only database` first calls the Database Admin
 * Management API (instances.get). The GitHub Hosting service account often
 * lacks that permission even though it can authenticate, which produces:
 *   Failed to get instance details for instance: four-fruits-fun-default-rtdb
 *
 * This script skips that lookup and tries, in order:
 *   1) RTDB REST  PUT /.settings/rules.json
 *   2) Firebase Rules API create-ruleset + release
 *
 * Usage (CI):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node scripts/ci-deploy-database-rules.js
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const PROJECT_ID = process.env.FIREBASE_PROJECT || 'four-fruits-fun';
const INSTANCE = process.env.FIREBASE_DATABASE_INSTANCE || `${PROJECT_ID}-default-rtdb`;
const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  `https://${INSTANCE}.firebaseio.com`;
const REPO_ROOT = path.resolve(__dirname, '..');
const RULES_PATH = path.join(REPO_ROOT, 'database.rules.json');

const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/firebase',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function loadServiceAccount() {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    return JSON.parse(fs.readFileSync(credPath, 'utf8'));
  }
  const inline = process.env.FIREBASE_SA || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) return JSON.parse(inline);
  throw new Error('No service account: set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SA');
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64url');
}

function mintJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(sa.private_key);
  return `${header}.${claim}.${b64url(sig)}`;
}

function request(method, urlStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(sa) {
  const jwt = mintJwt(sa);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();
  const res = await request('POST', 'https://oauth2.googleapis.com/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`OAuth token exchange failed (${res.status}): ${res.text.slice(0, 400)}`);
  }
  const json = JSON.parse(res.text);
  if (!json.access_token) throw new Error('OAuth response missing access_token');
  return json.access_token;
}

function summarizeBody(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function putRulesViaRtdb(token, rulesRaw) {
  const url = `${DATABASE_URL}/.settings/rules.json`;
  const res = await request('PUT', url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: rulesRaw,
  });
  console.log(`[rtdb-rest] PUT ${url} → HTTP ${res.status} ${summarizeBody(res.text)}`);
  return res.status >= 200 && res.status < 300;
}

async function releaseViaRulesApi(token, rulesRaw) {
  const create = await request(
    'POST',
    `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/rulesets`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: {
          files: [{ name: 'database.rules.json', content: rulesRaw }],
        },
      }),
    }
  );
  console.log(`[rules-api] create ruleset → HTTP ${create.status} ${summarizeBody(create.text)}`);
  if (create.status < 200 || create.status >= 300) return false;

  const created = JSON.parse(create.text);
  const rulesetName = created.name;
  if (!rulesetName) {
    console.log('[rules-api] create response missing name');
    return false;
  }

  const releaseNames = [
    `projects/${PROJECT_ID}/releases/cloud.realtimeDatabase/${INSTANCE}`,
    `projects/${PROJECT_ID}/releases/cloud.realtimeDatabase`,
  ];

  for (const name of releaseNames) {
    const rel = await request(
      'PATCH',
      `https://firebaserules.googleapis.com/v1/${name}?updateMask=rulesetName`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, rulesetName }),
      }
    );
    console.log(`[rules-api] PATCH ${name} → HTTP ${rel.status} ${summarizeBody(rel.text)}`);
    if (rel.status >= 200 && rel.status < 300) return true;

    if (rel.status === 404) {
      const createdRel = await request(
        'POST',
        `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/releases`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name, rulesetName }),
        }
      );
      console.log(`[rules-api] POST release ${name} → HTTP ${createdRel.status} ${summarizeBody(createdRel.text)}`);
      if (createdRel.status >= 200 && createdRel.status < 300) return true;
    }
  }
  return false;
}

async function main() {
  if (!fs.existsSync(RULES_PATH)) {
    throw new Error(`Missing ${RULES_PATH}`);
  }
  const rulesRaw = fs.readFileSync(RULES_PATH, 'utf8');
  JSON.parse(rulesRaw); // syntax check

  const sa = loadServiceAccount();
  console.log(`[ci-deploy-database-rules] project=${PROJECT_ID} instance=${INSTANCE}`);
  console.log(`[ci-deploy-database-rules] sa=${sa.client_email || '(unknown)'}`);

  const token = await getAccessToken(sa);

  if (await putRulesViaRtdb(token, rulesRaw)) {
    console.log('[ci-deploy-database-rules] OK via RTDB REST');
    return;
  }
  if (await releaseViaRulesApi(token, rulesRaw)) {
    console.log('[ci-deploy-database-rules] OK via Firebase Rules API');
    return;
  }
  throw new Error(
    'Database rules deploy failed via RTDB REST and Rules API. ' +
    'Grant the GitHub Firebase service account "Firebase Realtime Database Admin" ' +
    'and "Firebase Rules Admin" in Google Cloud IAM, or run locally: ' +
    'firebase deploy --only database --project four-fruits-fun'
  );
}

main().catch((err) => {
  console.error('[ci-deploy-database-rules] FAILED:', err.message || err);
  process.exit(1);
});
