/* ============================================================
   What a plan is allowed to spend.

   The numbers below are the whole business model in one object, so
   they live somewhere you can argue about them rather than scattered
   through the request handlers.

   Why there is a free ceiling at all: ad revenue does not pay for
   speech. A single page view earns roughly $0.002 at a realistic ad
   rate, and one thirty-second voiceover costs about $0.0075 to
   generate. Caption Studio is one page, so a visitor produces one page
   view however many videos they make in it — five videos in a sitting
   earns about $0.002 and costs about $0.037. Ads are a supplement and
   a reason to upgrade, not a way to fund an open tap.
   ============================================================ */

/* Speaking runs near 15 characters a second; Gemini's speech models
   emit about 25 tokens a second; Flash speech output is $10 per
   million tokens. Multiply it out and a character costs ~16.7
   millionths of a dollar. Kept as a formula so a price change is a
   one-line edit rather than a hunt. */
const CHARS_PER_SEC = 15, TOKENS_PER_SEC = 25, USD_PER_MTOKEN = 10;

function ttsCostMicros(chars) {
  const seconds = chars / CHARS_PER_SEC;
  const tokens = seconds * TOKENS_PER_SEC;
  return (tokens / 1e6) * USD_PER_MTOKEN * 1e6;
}

/* Text generation is small enough to be noise next to speech, but it
   is not free and an unbounded loop is still an unbounded bill. */
const TEXT_COST_MICROS = 300;      // ~$0.0003 for a short script

const PLANS = {
  free: {
    label: 'Free',
    ttsCallsPerMonth: 10,
    ttsCharsPerCall: 1500,
    ttsCharsPerMonth: 9000,
    textCallsPerMonth: 60,
    projects: 3
  },
  pro: {
    label: 'Pro',
    ttsCallsPerMonth: 300,
    ttsCharsPerCall: 5000,
    ttsCharsPerMonth: 400000,
    textCallsPerMonth: 2000,
    projects: 200
  }
};

const planFor = user => PLANS[(user && user.plan) || 'free'] || PLANS.free;

/* Answers "may this call happen", and says why not in words a customer can
   act on.

   The wording deliberately names no plan. While advertising is the only
   revenue there is nothing to upgrade to, so "the Free limit" would be
   pointing at a door that does not exist and inviting a question — what
   does the paid one cost? — with no answer. These read as a monthly
   allowance instead, which is what they are. Put the plan name back when
   there is something to sell. */
function checkAllowance(user, used, kind, chars) {
  const p = planFor(user);

  if (kind === 'text') {
    if (used.textCalls >= p.textCallsPerMonth) {
      return {
        ok: false,
        code: 'quota_text',
        reason: `That is ${p.textCallsPerMonth} scripts this month, which is the monthly limit. It resets at the start of next month.`
      };
    }
    return { ok: true };
  }

  if (chars > p.ttsCharsPerCall) {
    return {
      ok: false,
      code: 'too_long',
      reason: `That script is ${chars} characters and up to ${p.ttsCharsPerCall} can be spoken at a time. Shorten it, or make it in two parts.`
    };
  }
  if (used.ttsCalls >= p.ttsCallsPerMonth) {
    return {
      ok: false,
      code: 'quota_tts',
      reason: `That is ${p.ttsCallsPerMonth} voiceovers this month, which is the monthly limit. It resets at the start of next month.`
    };
  }
  if (used.ttsChars + chars > p.ttsCharsPerMonth) {
    return {
      ok: false,
      code: 'quota_tts_chars',
      reason: `This would pass the ${p.ttsCharsPerMonth.toLocaleString()} characters of speech allowed per month. It resets at the start of next month.`
    };
  }
  return { ok: true };
}

/* What the page needs to draw the allowance meter. */
function allowanceSummary(user, used) {
  const p = planFor(user);
  return {
    plan: (user && user.plan) || 'free',
    planLabel: p.label,
    voiceovers: { used: used.ttsCalls, limit: p.ttsCallsPerMonth },
    characters: { used: used.ttsChars, limit: p.ttsCharsPerMonth },
    scripts: { used: used.textCalls, limit: p.textCallsPerMonth },
    charsPerVoiceover: p.ttsCharsPerCall,
    resetsAt: used.since
  };
}

module.exports = { PLANS, planFor, checkAllowance, allowanceSummary, ttsCostMicros, TEXT_COST_MICROS };
