import { promisify } from "node:util";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import crypto from "node:crypto";

export function admin() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
      })
    });
  }
  return { auth: getAuth(), db: getFirestore() };
}

export const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const hmac = (s) => crypto.createHmac("sha256", process.env.OTP_SECRET || "change-me").update(s).digest("hex");
export const validEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 80;
export const validMobile = (d) => /^[6-9]\d{9}$/.test(d);
export const maskEmail = (e) => e.replace(/^(.)(.*)(.@.*)$/, (_, a, b, c) => a + "•".repeat(Math.min(b.length, 6)) + c);

export function send(res, status, body) {
  res.status(status).setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

export async function sendEmail(to, name, code) {
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "Kaburlu", email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: to, name: name || to }],
      subject: `${code} is your Kaburlu code`,
      textContent: `Your Kaburlu verification code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #DAE3DF;border-radius:16px">
        <h2 style="margin:0 0 8px;color:#0E7C66">Kaburlu</h2>
        <p style="color:#13221E">Your verification code is:</p>
        <p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#13221E;margin:8px 0">${code}</p>
        <p style="color:#5B6E68;font-size:13px">It expires in 10 minutes. If you didn't ask for it, ignore this email.</p></div>`
    })
  });
  if (!r.ok) throw new Error("brevo " + r.status + " " + (await r.text()));
}

/* ---------- passwords (scrypt, stored server-only in secrets/{uid}) ---------- */
const scryptAsync = promisify(crypto.scrypt);
export const validPassword = (p) => typeof p === "string" && p.length >= 8 && p.length <= 72;
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = (await scryptAsync(pw, salt, 64)).toString("hex");
  return `scrypt$${salt}$${h}`;
}
export async function checkPassword(pw, stored) {
  const [, salt, h] = String(stored || "").split("$");
  if (!salt || !h) return false;
  const c = await scryptAsync(pw, salt, 64);
  return crypto.timingSafeEqual(c, Buffer.from(h, "hex"));
}

/* Find an existing account by 10-digit mobile number or email. Returns {uid, email, name} or null. */
export async function findAccount(auth, db, raw) {
  const id = String(raw || "").trim().toLowerCase();
  const digits = id.replace(/\D/g, "").slice(-10);
  try {
    if (!id.includes("@") && validMobile(digits)) {
      const idx = await db.doc(`phoneIndex/+91${digits}`).get();
      if (!idx.exists) return null;
      const u = await auth.getUser(idx.data().uid);
      return { uid: u.uid, email: u.email, name: u.displayName || "" };
    }
    if (validEmail(id)) {
      const u = await auth.getUserByEmail(id);
      return { uid: u.uid, email: u.email, name: u.displayName || "" };
    }
  } catch (e) {
    if (e.code === "auth/user-not-found") return null;
    throw e;
  }
  return undefined; // input was neither a phone number nor an email
}
