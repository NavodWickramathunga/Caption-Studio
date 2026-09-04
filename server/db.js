/* ============================================================
   The store — Firestore.

   This was SQLite, which was the wrong shape for where it is going.
   SQLite is a file on a disk, and Cloud Run has no disk that survives
   a restart and runs several copies at once that could not share one
   file anyway. Firestore has no server to run, no disk to mount and no
   connection pool to size.

   Two collections, and the second is the interesting one:

     users/{uid}                      who they are and what they pay
     users/{uid}/months/{YYYY-MM}     running totals for the month
     users/{uid}/calls/{autoId}       one row per billable call

   The month document exists so that checking an allowance is a single
   read rather than a query that adds up every call ever made. Reads
   cost money and time here; summing a year of history on every button
   press would be both. The per-call rows are still written, because a
   customer disputing a bill deserves the actual list rather than a
   total, but nothing on the hot path ever reads them.
   ============================================================ */
const { Firestore, FieldValue } = require('@google-cloud/firestore');

/* On Cloud Run the service account is picked up automatically. Locally
   it would come from GOOGLE_APPLICATION_CREDENTIALS, but nothing about
   this project needs to run locally any more. */
const store = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE || '(default)',
  ignoreUndefinedProperties: true
});

const users = () => store.collection('users');

/* A month in UTC, so a user near midnight in Colombo and one in London
   are counted against the same window as each other. */
function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthStart(d = new Date()) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

const shape = (id, data) => data ? ({
  id,
  email: data.email || '',
  name: data.name || null,
  picture: data.picture || null,
  plan: data.plan || 'free',
  createdAt: data.createdAt || 0,
  lastSeenAt: data.lastSeenAt || 0
}) : null;

/* Google is the source of truth for a name and a picture, so a sign-in
   refreshes them. The plan is ours, and a merge must never overwrite
   it — which is why it is only written when the document is new. */
async function upsertUser(profile) {
  const ref = users().doc(profile.id);
  const now = Date.now();
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      email: profile.email, name: profile.name || null, picture: profile.picture || null,
      plan: 'free', createdAt: now, lastSeenAt: now
    });
  } else {
    await ref.update({
      email: profile.email, name: profile.name || null,
      picture: profile.picture || null, lastSeenAt: now
    });
  }
  return shape(profile.id, (await ref.get()).data());
}

async function getUser(id) {
  if (!id) return null;
  const snap = await users().doc(id).get();
  return snap.exists ? shape(id, snap.data()) : null;
}

async function setPlan(id, plan) {
  await users().doc(id).update({ plan });
  return getUser(id);
}

/* The counters move with increment() rather than read-modify-write, so
   two calls landing at the same moment cannot lose one of the two. */
async function recordUsage(userId, kind, chars, costMicros) {
  const now = Date.now();
  const month = users().doc(userId).collection('months').doc(monthKey());
  const call = users().doc(userId).collection('calls').doc();

  const bump = {
    updatedAt: now,
    costMicros: FieldValue.increment(Math.round(costMicros))
  };
  if (kind === 'tts') {
    bump.ttsCalls = FieldValue.increment(1);
    bump.ttsChars = FieldValue.increment(chars | 0);
  } else {
    bump.textCalls = FieldValue.increment(1);
  }

  const batch = store.batch();
  batch.set(month, bump, { merge: true });
  batch.set(call, { kind, chars: chars | 0, costMicros: Math.round(costMicros), at: now });
  await batch.commit();
}

async function usageThisMonth(userId) {
  const snap = await users().doc(userId).collection('months').doc(monthKey()).get();
  const d = snap.exists ? snap.data() : {};
  return {
    ttsCalls: d.ttsCalls || 0,
    ttsChars: d.ttsChars || 0,
    textCalls: d.textCalls || 0,
    costMicros: d.costMicros || 0,
    since: monthStart()
  };
}

module.exports = {
  store, upsertUser, getUser, setPlan, recordUsage, usageThisMonth, monthStart, monthKey
};
