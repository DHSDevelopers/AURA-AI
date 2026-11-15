# AURA AI

Personal AI assistant — static frontend + Python backend proxy. **No API keys live in this repo.**

## Layout

```
index.html          frontend shell (rename a copy to aura.html when packing the APK)
styles.css          all styling
app.js              app logic + Firebase auth/Firestore  → calls the backend, never Groq directly
backend/main.py     FastAPI proxy that holds the Groq keys and rotates them
backend/requirements.txt
backend/.env.example   copy to backend/.env locally and fill in real keys
backend/Procfile    start command for Render/Railway
```

## How it fits together

The browser never sees a Groq key. It calls:

- `POST /api/chat` — text
- `POST /api/chat/vision` — image analysis
- `GET  /health` — key/model status

The backend reads keys from environment variables and rotates across them on 429/401/403.

## 1. Publish the frontend (GitHub Pages, free)

Repo must be **public**. Then: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**

Live at `https://<username>.github.io/<repo>/` about 2 minutes later.

## 2. Publish the backend (Render, free)

1. New → Web Service → connect this repo
2. Root Directory: `backend`
3. Build: `pip install -r requirements.txt` — Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Environment variables:
   - `GROQ_KEY_1` … `GROQ_KEY_4` — create at https://console.groq.com/keys
   - `ALLOWED_ORIGINS` — e.g. `https://<username>.github.io,https://appassets.androidplatform.net`
5. Copy the `https://….onrender.com` URL into `BACKEND_URL` at the top of `app.js`, commit, done.

## Notes

- The backend sleeps after 15 minutes idle on the free tier; the first message takes ~1 minute to wake.
- `.env` is gitignored. Never commit keys — GitHub blocks them and Groq revokes them automatically.
- Firebase config in `app.js` is public by design; it is protected by Firebase Security Rules, not secrecy.
