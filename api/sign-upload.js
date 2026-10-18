import crypto from "node:crypto";
import { admin, send, readBody } from "./_lib.js";

// Signs a Cloudinary upload so only signed-in members of a chat can upload into it.
// The file itself goes straight from the browser to Cloudinary.
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
  if (!cloudName || !apiKey || !secret) return send(res, 500, { error: "Photo sharing isn't set up yet. Add the Cloudinary keys in Vercel (see README)." });

  const body = readBody(req);
  const chatId = String(body.chatId || "");
  if (!/^[A-Za-z0-9]{10,128}_[A-Za-z0-9]{10,128}$/.test(chatId)) return send(res, 400, { error: "Unknown chat." });

  const { auth } = admin();
  let uid;
  try { uid = (await auth.verifyIdToken(String(body.idToken || ""))).uid; }
  catch { return send(res, 401, { error: "Please log in again." }); }
  if (!chatId.split("_").includes(uid)) return send(res, 403, { error: "You're not part of this chat." });

  const timestamp = Math.round(Date.now() / 1000);
  const folder = `kaburlu/${chatId}`;
  const toSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto.createHash("sha1").update(toSign + secret).digest("hex");
  return send(res, 200, { cloudName, apiKey, timestamp, signature, folder });
}
