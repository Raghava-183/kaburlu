# Kaburlu Chat — setup guide

**How sign-up works:** a new user enters name, mobile number and email. A 6-digit code arrives by email (sent through Brevo), and after they type it in, their account is ready.

**What it costs: ₹0.** Vercel hosts the website, Brevo sends the emails (free up to 300 a day), and Firebase stores the chats (free plan).

You'll set up 3 free accounts, copy a few keys into Vercel, and deploy. Follow the steps in order.

---

## Step 1 — Brevo (sends the code emails)

1. Sign up at https://www.brevo.com (free).
2. **Add a sender:** click your name (top right) → **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender**.
   - Name: `Kaburlu`
   - Email: your Gmail (for example `raghavakande183@gmail.com`)
   - Brevo emails you a link. Click it to confirm.
3. **Get the API key:** click your name → **SMTP & API** → **API Keys** tab → **Generate a new API key** → name it `kaburlu` → copy the key (starts with `xkeysib-`).
   Save it in Notepad for now.

## Step 2 — Firebase (stores users and chats)

You already have the project **kaburlu-9c280**.

1. **Create the database:**
   - Left menu → **Databases & Storage** → **Firestore** → **Create database**.
   - Choose **Production mode**.
   - Location: **asia-south1 (Mumbai)**.
   - Skip this if you already did it.
2. **Get the server key:** ⚙️ **Settings** → **Project settings** → **Service accounts** tab → **Generate new private key** → **Generate key**.
   A `.json` file downloads. Open it with Notepad: you need 3 values from it in Step 4 — `project_id`, `client_email` and `private_key`.
   **Keep this file private. Never share it or put it inside the project folder.**
3. **Upload the security rules:** open a terminal in the `kaburlu` folder and run:
   ```
   firebase deploy --only firestore
   ```

You don't need Phone sign-in or the Blaze plan any more.

## Step 3 — Put the site on Vercel

1. Sign up at https://vercel.com (free, "Hobby").
2. In the terminal, inside the `kaburlu` folder:
   ```
   npm install -g vercel
   vercel login
   vercel
   ```
   Press **Enter** to accept every question (set up and deploy: yes, project name: kaburlu, directory: `./`, change settings: no).

## Step 4 — Add your keys to Vercel

1. Go to https://vercel.com/dashboard → open the **kaburlu** project.
2. Open **Settings** → **Environment Variables**.
3. Add these 6, one by one:

| Name | Value |
|------|-------|
| `BREVO_API_KEY` | the key from Step 1 (`xkeysib-…`) |
| `BREVO_SENDER_EMAIL` | the sender email you confirmed in Step 1 |
| `FIREBASE_PROJECT_ID` | `kaburlu-9c280` |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the .json file |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the .json file — copy everything between the quotes, starting with `-----BEGIN PRIVATE KEY-----` and ending with `-----END PRIVATE KEY-----\n` |
| `OTP_SECRET` | any long random text, for example `kaburlu-8f3k29dk3m2s9q7x` |

## Step 5 — Go live

In the terminal:
```
vercel --prod
```
It prints your link, like **https://kaburlu.vercel.app**. Open it, click **Register**, and the code will come to your email.

Whenever you change files, run `vercel --prod` again.

---

## If something goes wrong

| Message on the site | Fix |
|---|---|
| "Couldn't send the email. Check the Brevo settings" | The API key is wrong, or the sender email isn't confirmed in Brevo. Fix it in Vercel → Settings → Environment Variables, then run `vercel --prod`. |
| "Server error" | One of the Firebase keys in Step 4 is wrong. The most common mistake is the private key: copy it again, carefully. Then run `vercel --prod`. |
| "Couldn't load your account" | Run `firebase deploy --only firestore` (Step 2.3). |
| The code email doesn't arrive | Check the **Spam** folder. If you set up a custom domain in Brevo later, emails will land in the inbox more reliably. |

You can see the server errors in Vercel → your project → **Logs**.

---

## What's inside

```
kaburlu/
├── public/              the website (what users see)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── firebase-config.js
├── api/                 runs on Vercel's server
│   ├── send-otp.js      makes a 6-digit code and emails it with Brevo
│   ├── verify-otp.js    checks the code, creates the account, logs the user in
│   └── _lib.js
├── firestore.rules      who can read what in the database
├── firestore.indexes.json
├── firebase.json        used only for "firebase deploy --only firestore"
├── vercel.json
└── package.json
```

**Safety built in**

- **Codes:** each code expires in 10 minutes. After 5 wrong tries, the user needs a new code. Each email can get one code a minute and 10 a day.
- **Chats:** only the two people in a chat can read it.
- **PIN:** the PIN is stored scrambled (salted hash), never as plain digits.
- **Forgot PIN:** a fresh email code is needed before a new PIN can be set.
