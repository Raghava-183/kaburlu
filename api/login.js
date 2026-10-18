import { admin, validMobile, checkPassword, send, readBody } from "./_lib.js";

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const WRONG = "Wrong mobile number or password.";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const body = readBody(req);
  const digits = String(body.phone || "").replace(/\D/g, "").slice(-10);
  const password = String(body.password || "");
  if (!validMobile(digits)) return send(res, 400, { error: "Enter your 10-digit mobile number." });
  if (!password) return send(res, 400, { error: "Enter your password." });

  const { auth, db } = admin();
  try {
    const idx = await db.doc(`phoneIndex/+91${digits}`).get();
    if (!idx.exists) return send(res, 401, { error: WRONG });
    const uid = idx.data().uid;

    const sref = db.doc(`secrets/${uid}`);
    const s = (await sref.get()).data();
    if (!s || !s.passHash) return send(res, 400, { error: "This account has no password yet. Tap Forgot password to set one." });

    const now = Date.now();
    if (s.lockUntil && now < s.lockUntil) {
      return send(res, 429, { error: `Too many wrong tries. Try again in ${Math.ceil((s.lockUntil - now) / 60000)} minutes, or tap Forgot password.` });
    }

    if (!(await checkPassword(password, s.passHash))) {
      const fails = (s.fails || 0) + 1;
      if (fails >= MAX_FAILS) {
        await sref.update({ fails: 0, lockUntil: now + LOCK_MS });
        return send(res, 429, { error: "Too many wrong tries. Try again in 15 minutes, or tap Forgot password." });
      }
      await sref.update({ fails });
      return send(res, 401, { error: WRONG });
    }

    if (s.fails || s.lockUntil) await sref.update({ fails: 0, lockUntil: 0 });
    const token = await auth.createCustomToken(uid);
    return send(res, 200, { token });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "Server error. Try again in a minute." });
  }
}
