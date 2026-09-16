import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyState, extractError, ERROR_RE } from '../lib/google-state.js';

const base = {
  url: 'https://accounts.google.com/v3/signin/identifier?hl=en',
  hasIdentifier: false,
  hasPassword: false,
  hasTotpPin: false,
  hasCodeInput: false,
  hasCaptcha: false,
  heading: '',
  bodyText: '',
  buttons: [],
  errorText: '',
};

test('identifier screen -> email', () => {
  const r = classifyState({ ...base, hasIdentifier: true, heading: 'Sign in' });
  assert.equal(r.state, 'email');
  assert.equal(r.status, 'new');
});

test('password screen -> password', () => {
  const r = classifyState({ ...base, hasPassword: true, url: 'https://accounts.google.com/v3/signin/checkout?hl=en' });
  assert.equal(r.state, 'password');
});

test('/signin/rejected url -> error with rejected code', () => {
  const r = classifyState({ ...base, url: 'https://accounts.google.com/v3/signin/rejected' });
  assert.equal(r.state, 'error');
  assert.equal(r.status, 'error');
  assert.equal(r.code, 'rejected');
});

test('myaccount.google.com url -> logged-in', () => {
  const r = classifyState({ ...base, url: 'https://myaccount.google.com/' });
  assert.equal(r.state, 'logged-in');
  assert.equal(r.status, 'logged-in');
});

test('gds.google.com/web url -> logged-in', () => {
  const r = classifyState({ ...base, url: 'https://gds.google.com/web/u/0/account' });
  assert.equal(r.state, 'logged-in');
});

test('totp pin field -> totp (authenticator)', () => {
  const r = classifyState({ ...base, hasTotpPin: true });
  assert.equal(r.state, 'totp');
  assert.equal(r.codeKind, 'authenticator');
});

test('code input with "we sent" text -> totp (sms)', () => {
  const r = classifyState({ ...base, hasCodeInput: true, heading: "Verify it's you", bodyText: 'Enter the code we sent to +1 415 555 01 •• 34' });
  assert.equal(r.state, 'totp');
  assert.equal(r.codeKind, 'sms');
});

test('code input with authenticator text -> totp (authenticator)', () => {
  const r = classifyState({
    ...base,
    hasCodeInput: true,
    heading: "Verify it's you",
    bodyText: 'Enter the 6-digit code from your authenticator app',
  });
  assert.equal(r.state, 'totp');
  assert.equal(r.codeKind, 'authenticator');
});

test('code input never wins over a visible password field', () => {
  const r = classifyState({ ...base, hasCodeInput: true, hasPassword: true });
  assert.equal(r.state, 'password');
});

test('recaptcha iframe -> captcha', () => {
  const r = classifyState({ ...base, hasCaptcha: true });
  assert.equal(r.state, 'captcha');
  assert.equal(r.status, 'pending');
});

test('"choose how to confirm" heading + option buttons -> choice with choices', () => {
  const r = classifyState({
    ...base,
    heading: "Choose how to confirm it's you",
    buttons: ['Text me a code', 'Call me instead', 'Use passkey', 'Try another way'],
  });
  assert.equal(r.state, 'choice');
  assert.ok(r.choices.includes('Text me a code'));
  assert.ok(r.choices.includes('Use passkey'));
  assert.ok(!r.choices.includes('Try another way'));
});

test('two option buttons alone also -> choice', () => {
  const r = classifyState({ ...base, buttons: ['Text me a code', 'Use passkey'] });
  assert.equal(r.state, 'choice');
});

test('passkey heading -> passkey', () => {
  const r = classifyState({ ...base, heading: "Use your passkey to confirm it's you" });
  assert.equal(r.state, 'passkey');
});

test('we\'ll text you a code number screen -> sms with phone extracted', () => {
  const r = classifyState({
    ...base,
    heading: "We'll text you a code",
    bodyText: "We'll text +1 415 555 01 •• 34 a verification code",
    buttons: ['Send code'],
  });
  assert.equal(r.state, 'sms');
  assert.match(r.phone, /\+1 415/);
});

test('push notification prompt heading -> prompt', () => {
  const r = classifyState({ ...base, heading: "Confirm it's you", bodyText: 'Check your phone' });
  assert.equal(r.state, 'prompt');
});

test('visible Google error text -> error with the message', () => {
  const r = classifyState({ ...base, hasIdentifier: true, errorText: "Wrong password. Try again or click Forgot password to reset it." });
  assert.equal(r.state, 'error');
  assert.match(r.message, /wrong password/i);
});

test('unrecognized screen -> unknown, NOT logged-in', () => {
  const r = classifyState({ ...base, heading: 'Something new from Google', bodyText: '...redesign...' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.status, 'pending');
});

test('extractError matches known Google error phrases', () => {
  assert.match(extractError('Wrong password. Try again.'), /wrong password/i);
  assert.match(extractError("Couldn't find your Google Account. Try another email"), /couldn't find/i);
  assert.equal(extractError('To continue to your Google Account'), null);
});

test('ERROR_RE does not match harmless form text', () => {
  assert.equal('Sign in Use your Google Account'.match(ERROR_RE), null);
});
