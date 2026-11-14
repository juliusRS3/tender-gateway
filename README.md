# Tender Gateway

An independent web app (PWA) that lists open tenders for free and offers paid
help to prepare proposals. Anyone can browse and send a consultancy request —
no account needed. Email is the only channel used to contact people.

This guide is written for someone new to coding. Take it one step at a time.

---

## What's in this folder

- `public/` — the website people see (pages, styles, icons, offline support).
- `src/` — the server and database code.
- `seed/tenders.json` — the ~146 tenders loaded the first time the app runs.
- `.env.example` — the list of settings you'll add on Railway (do not put real secrets in GitHub).

---

## Step 1 — Put this code on GitHub

You already created the empty repository `tender-gateway`.

1. Open it on github.com.
2. Click **Add file → Upload files**.
3. Drag in **everything in this folder EXCEPT the `node_modules` folder** (if you see one). Keep the folder structure (`public`, `src`, `seed`).
4. At the bottom, write a short message like "first upload" and click **Commit changes**.

---

## Step 2 — Create the app on Railway

1. Go to railway.app and click **New Project → Deploy from GitHub repo**.
2. Choose your `tender-gateway` repository. Railway builds and starts it automatically.
3. In the project, click **New → Database → Add PostgreSQL**. Railway connects it to your app on its own (it provides `DATABASE_URL`).

---

## Step 3 — Add your settings

In Railway, open your app service → **Variables** tab, and add:

- `ADMIN_PASSWORD` — the password you'll type to open the Admin page. Pick a strong one.
- `SESSION_SECRET` — any long random text (30+ characters). It keeps admin sign-in secure.
- `NODE_ENV` — set to `production`.

Leave the email settings for later (the app runs fine without them; it just
logs emails instead of sending them). When you're ready, add `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, and `ADMIN_EMAIL`
(see `.env.example` for what each one means).

After adding variables, Railway restarts the app.

---

## Step 4 — Open it

1. In the app service → **Settings → Networking**, click **Generate Domain**.
2. Railway gives you a web address like `tender-gateway.up.railway.app`.
3. Copy that address into the `SITE_URL` variable (Step 3's tab) so email links point to the right place.
4. Open the address. You should see the tenders.

You can add your own domain (like `tendergateway.my`) later in that same
Networking section.

---

## Step 5 — Sign in as admin

Go to `your-address/#admin`, type your `ADMIN_PASSWORD`, and you can:

- Add, edit, and delete tenders.
- See consultancy requests and send fixed-fee quotes.
- Mark the links as checked.

---

## How people use it

1. Browse tenders and click **Get tender document** to go to the official source.
2. Click **Request consultancy**, confirm they have the document, accept the terms, and send the request with their email.
3. You send a quote from Admin; they accept or decline on their **My requests** page (and by email once email is set up).

---

## Running it on your own computer (optional)

You don't need this to launch, but if you want to try it locally:

1. Install Node.js (version 18 or newer).
2. In a terminal, run `npm install` inside this folder.
3. Set `DATABASE_URL` to a Postgres database and `ADMIN_PASSWORD` to any value.
4. Run `npm start` and open `http://localhost:3000`.

---

## Notes

- The tender list starts from `seed/tenders.json`. After the first run the
  database is the source of truth; add or remove tenders from the Admin page.
- This app is independent. It does not link to any other website or project.
