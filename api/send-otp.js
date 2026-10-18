import crypto from "node:crypto";
import {
  admin, sha, hmac, validEmail, validMobile, validPassword, hashPassword, findAccount,
  maskEmail, send, readBody, sendEmail
} from "./_lib.js";

const COOLDOWN_MS = 60 * 1000;
const EXPIRY_MS = 10 * 60 * 1000;
const DAILY_LIMIT = 10;

// Modes:
//   register — new account: name, phone, email, password. Code confirms the email.
//   reset    — forgot password: id = mobile number or email.
//   pin      — forgot PIN inside the app: id = the user's email.
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const body = readBody(req);
  const { auth, db } = admin();
  const mode = body.mode;

  let email, name = "", phone = "", uid = null, passHash = null;

  try {
    if (mode === "register") {
      name = String(body.name || "").trim().replace(/\s+/g, " ");
      const digits = String(body.phone || "").replace(/\D/g, "");
      email = String(body.email || "").trim().toLowerCase();
      if (name.length < 2 || name.length > 40) return send(res, 400, { error: "Enter your name (2 to 40 letters)." });
      if (!validMobile(digits)) return send(res, 400, { error: "Enter a 10-digit mobile number starting with 6, 7, 8 or 9." });
      if (!validEmail(email)) return send(res, 400, { error: "Enter a valid email address." });
      if (!validPassword(body.password)) return send(res, 400, { error: "Password must be at least 8 characters." });
      phone = "+91" + digits;
      if ((await db.doc(`phoneIndex/${phone}`).get()).exists) return send(res, 409, { error: "This mobile number is already registered. Use Log in." });
      try { await auth.getUserByEmail(email); return send(res, 409, { error: "This email is already registered. Use Log in." }); }
      catch (e) { if (e.code !== "auth/user-not-found") throw e; }
      passHash = await hashPassword(body.password);
    } else if (mode === "reset" || mode === "pin") {
      const acc = await findAccount(auth, db, body.id);
      if (acc === undefined) return send(res, 400, { error: "Enter your 10-digit mobile number or your email." });
      if (acc === null) return send(res, 404, { error: "No account found. Register first." });
      ({ uid, email, name } = acc);
    } else {
      return send(res, 400, { error: "Unknown request." });
    }

    const ticket = sha("otp:" + email);
    const ref = db.doc(`otps/${ticket}`);
    const prev = (await ref.get()).data();
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    if (prev && now - prev.sentAt < COOLDOWN_MS) {
      return send(res, 429, { error: `Wait ${Math.ceil((COOLDOWN_MS - (now - prev.sentAt)) / 1000)} seconds before asking for another code.` });
    }
    const dayCount = prev && prev.day === today ? prev.dayCount : 0;
    if (dayCount >= DAILY_LIMIT) return send(res, 429, { error: "Too many codes today. Try again tomorrow." });

    const code = String(crypto.randomInt(100000, 1000000));
    await ref.set({
      email, mode, name, phone, uid, passHash, codeHash: hmac(ticket + ":" + code),
      expiresAt: now + EXPIRY_MS, attempts: 0, sentAt: now, day: today, dayCount: dayCount + 1
    });
    await sendEmail(email, name, code);
    return send(res, 200, { ticket, to: maskEmail(email) });
  } catch (e) {
    console.error(e);
    if (String(e.message).startsWith("brevo")) return send(res, 502, { error: "Couldn't send the email. Check the Brevo settings (see README)." });
    return send(res, 500, { error: "Server error. Try again in a minute." });
  }
}
