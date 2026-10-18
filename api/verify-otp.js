import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { admin, hmac, send, readBody, validPassword, hashPassword } from "./_lib.js";

const MAX_ATTEMPTS = 5;

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const body = readBody(req);
  const ticket = String(body.ticket || "");
  const code = String(body.code || "").replace(/\D/g, "");
  if (!/^[a-f0-9]{64}$/.test(ticket) || code.length !== 6) return send(res, 400, { error: "Enter all 6 digits." });

  const { auth, db } = admin();
  try {
    const ref = db.doc(`otps/${ticket}`);
    const o = (await ref.get()).data();
    if (!o || !o.codeHash || Date.now() > o.expiresAt) return send(res, 400, { error: "This code has expired. Tap Resend code." });
    if (o.attempts >= MAX_ATTEMPTS) return send(res, 429, { error: "Too many wrong tries. Tap Resend code." });
    // Check the new password before using up the code.
    if (o.mode === "reset" && !validPassword(body.newPassword)) return send(res, 400, { error: "New password must be at least 8 characters." });

    const good = crypto.timingSafeEqual(Buffer.from(hmac(ticket + ":" + code)), Buffer.from(o.codeHash));
    if (!good) {
      await ref.update({ attempts: FieldValue.increment(1) });
      const left = MAX_ATTEMPTS - o.attempts - 1;
      return send(res, 400, { error: left > 0 ? `That code doesn't match. ${left} tries left.` : "Too many wrong tries. Tap Resend code." });
    }
    // Code used: keep cooldown info, remove the code and any stored password hash.
    await ref.update({ codeHash: FieldValue.delete(), passHash: FieldValue.delete() });

    let uid = o.uid;
    if (o.mode === "register") {
      const user = await auth.createUser({ email: o.email, emailVerified: true, displayName: o.name });
      uid = user.uid;
      try {
        const b = db.batch();
        b.create(db.doc(`phoneIndex/${o.phone}`), { uid });
        b.set(db.doc(`users/${uid}`), { name: o.name, phone: o.phone, createdAt: FieldValue.serverTimestamp() });
        b.set(db.doc(`users/${uid}/private/settings`), { email: o.email, pinHash: null, salt: null, hidden: [] });
        b.set(db.doc(`secrets/${uid}`), { passHash: o.passHash, fails: 0, lockUntil: 0 });
        await b.commit();
      } catch (e) {
        await auth.deleteUser(uid).catch(() => {});
        if (e.code === 6 || /already exists/i.test(e.message)) return send(res, 409, { error: "This mobile number was just registered by someone else." });
        throw e;
      }
    } else if (o.mode === "reset") {
      await db.doc(`secrets/${uid}`).set({ passHash: await hashPassword(body.newPassword), fails: 0, lockUntil: 0 });
    }
    if (!uid) return send(res, 400, { error: "Account not found. Register first." });
    const token = await auth.createCustomToken(uid);
    return send(res, 200, { token });
  } catch (e) {
    console.error(e);
    if (e.code === "auth/email-already-exists") return send(res, 409, { error: "This email is already registered. Use Log in." });
    return send(res, 500, { error: "Server error. Try again in a minute." });
  }
}
