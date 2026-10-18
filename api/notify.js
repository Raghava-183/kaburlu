import { getMessaging } from "firebase-admin/messaging";
import { FieldValue } from "firebase-admin/firestore";
import { admin, send, readBody } from "./_lib.js";

const DEAD = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument"
]);

// Sends a push notification to the other person in a chat, about the chat's latest message.
// The text comes from the database, never from the request, so it can't be faked.
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const body = readBody(req);
  const chatId = String(body.chatId || "");
  if (!/^[A-Za-z0-9]{10,128}_[A-Za-z0-9]{10,128}$/.test(chatId)) return send(res, 400, { error: "Unknown chat." });

  const { auth, db } = admin();
  let uid;
  try { uid = (await auth.verifyIdToken(String(body.idToken || ""))).uid; }
  catch { return send(res, 401, { error: "Please log in again." }); }

  try {
    const chatRef = db.doc(`chats/${chatId}`);
    const chat = (await chatRef.get()).data();
    if (!chat || !chat.members?.includes(uid)) return send(res, 403, { error: "You're not part of this chat." });
    if (chat.lastFrom !== uid) return send(res, 200, { skipped: "not your message" });
    const lastAt = chat.lastAt?.toMillis?.() || 0;
    if ((chat.notifiedAt || 0) >= lastAt) return send(res, 200, { skipped: "already sent" });
    await chatRef.update({ notifiedAt: lastAt });

    const other = chat.members.find(m => m !== uid);
    const [tokSnap, setSnap, senderSnap] = await Promise.all([
      db.doc(`pushTokens/${other}`).get(),
      db.doc(`users/${other}/private/settings`).get(),
      db.doc(`users/${uid}`).get()
    ]);
    const tokens = tokSnap.data()?.tokens || [];
    if (!tokens.length) return send(res, 200, { skipped: "no devices" });

    // If the receiver hid this chat, don't reveal who wrote or what they said.
    const st = setSnap.data() || {};
    const hidden = (st.hidden || []).includes(chatId);
    const title = hidden ? "Kaburlu" : (st.nicknames?.[uid] || senderSnap.data()?.name || "New message");
    const text = hidden ? "You have a new message" : String(chat.lastText || "New message").slice(0, 140);

    const r = await getMessaging().sendEachForMulticast({
      tokens,
      data: { title, body: text, chatId: hidden ? "" : chatId },
      webpush: { headers: { Urgency: "high", TTL: "86400" } }
    });
    const dead = tokens.filter((_, i) => DEAD.has(r.responses[i]?.error?.code));
    if (dead.length) await db.doc(`pushTokens/${other}`).update({ tokens: FieldValue.arrayRemove(...dead) });
    return send(res, 200, { sent: r.successCount });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "Couldn't send the notification." });
  }
}
