# Safety App: Backend API

A personal-safety app. When a user starts an alert, the server saves their live location and short audio recordings, and creates a private tracking link that emergency contacts can open **without an account**. Users can also look up the nearest hospitals, pharmacies and police stations.

The backend is built and tested (Python, FastAPI, SQLite). **This README is for the frontend developer**: it explains how to run the API, what every endpoint does, and which screens to build.

## Quick start (run the API on your computer)

You need Python 3.10 or newer and Git.

```bash
# 1. Get the code
git clone https://github.com/tulipsinha/safety-app.git
cd safety-app

# 2. Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

# 3. Install packages
pip install -r requirements.txt
# If something is missing:
# pip install "fastapi[standard]" pyjwt "pwdlib[argon2]"

# 4. (Optional) set an email used by the map lookup
export CONTACT_EMAIL="you@example.com"     # Windows: set CONTACT_EMAIL=you@example.com

# 5. Start the server
fastapi dev main.py
```

- API: `http://127.0.0.1:8000`
- **Interactive docs (try every endpoint in the browser):** `http://127.0.0.1:8000/docs`
- Machine-readable spec (you can generate a client from it): `http://127.0.0.1:8000/openapi.json`

The first run creates `safety.db` (database) and a `recordings/` folder automatically. Both are ignored by git, so your test accounts stay on your own computer.

If the port is busy, use `fastapi dev main.py --port 8001`.

### Try it in 2 minutes

1. Open `/docs`, run **POST /register** with a test username and password.
2. Run **POST /login** and copy the `token` from the response.
3. Click **Authorize** (top right of the docs page), paste the token, and click Authorize.
4. Now every 🔒 endpoint works from the docs page.

### Environment variables

| Name | Purpose | Default |
|---|---|---|
| `SECRET_KEY` | Signs login tokens. **Must be a long random string when hosted.** | A local-testing placeholder |
| `DATA_DIR` | Folder for `safety.db` and `recordings/` | Current folder |
| `CONTACT_EMAIL` | Identifies the app to the OpenStreetMap map service used by `/nearby` | `not-set` |

Never commit real secrets. The hosted API address will be shared privately: **Base URL: `<to be provided>`**.

## Conventions

- Request and response bodies are JSON, except audio upload (multipart form) and audio download (binary file).
- Endpoints marked 🔒 need the header `Authorization: Bearer <token>`.
- Errors return `{"detail": "message"}`. For invalid input (status 422), `detail` is a **list** of problems, so handle both a string and a list.
- Login tokens last **12 hours**. If a 🔒 call returns **401 or 403**, clear the saved token and send the user to the login screen.
- **Tokens stop working** after a password change, a password reset, or account deletion. Send the user to the login screen after they change their password.
- **429** means too many failed attempts (5 wrong logins or reset attempts lock that username for 10 minutes). Show the message from `detail` and let the user wait.
- New passwords must be 8 to 128 characters (change and reset).
- CORS is currently open to every origin for development. It will be restricted to the real front-end address before launch. Tell us your final address.

## Endpoints

### Account

| Method | Path | Body | Success response | Errors |
|---|---|---|---|---|
| POST | `/register` | `{"username","password"}` | `{"message":"User registered"}` | 400 "Username already taken" |
| POST | `/login` | `{"username","password"}` | `{"message":"Login successful","token":"..."}` | 401 wrong username or password, 429 too many attempts |
| GET 🔒 | `/me` | none | `{"username":"..."}` | 401/403 |
| POST 🔒 | `/account/change-password` | `{"old_password","new_password"}` | `{"message":"Password changed"}` | 401 if the current password is wrong |
| POST 🔒 | `/account/recovery-code` | `{"password"}` | `{"recovery_code","message"}` | 401 wrong password |
| POST | `/password/reset` | `{"username","recovery_code","new_password"}` | `{"message":"Password reset..."}` | 401 wrong username or code, 429 too many attempts |
| POST 🔒 | `/account/delete` | `{"password"}` | `{"message":"Account and all data deleted"}` | 401 wrong password |

How password recovery works (there are no emails in this app):
1. While logged in, the user calls `/account/recovery-code` with their password. The code is shown **once**, and it replaces any older code. The screen must tell the user to save it somewhere safe and wait for an "I've saved it" tap.
2. If they forget the password, they use `/password/reset` with their username, the code and a new password. The code works once.
3. Account deletion is **permanent**: it removes the user, contacts, locations, alerts and recordings (including the audio files). Ask the user to confirm clearly before calling it.

### Location

| Method | Path | Body | Success response | Errors |
|---|---|---|---|---|
| POST 🔒 | `/location` | `{"latitude":number,"longitude":number}` | `{"message":"Location saved"}` | |
| GET 🔒 | `/location/latest` | none | `{"latitude","longitude","time"}` | 404 if none saved |

### Emergency contacts

| Method | Path | Body | Success response |
|---|---|---|---|
| POST 🔒 | `/contacts` | `{"name","phone"}` | `{"message":"Contact added"}` |
| GET 🔒 | `/contacts` | none | `[{"id","name","phone"}, ...]` |
| DELETE 🔒 | `/contacts/{id}` | none | `{"message":"Contact deleted"}` (404 if not found) |

Phone numbers should include the `+` and country code, for example `+919812345678`.

### Alert

| Method | Path | Success response | Notes |
|---|---|---|---|
| POST 🔒 | `/alert/start` | `{"message","share_token","track_path"}` | `track_path` looks like `/track/abc123`. Starting a new alert switches off any older one. |
| POST 🔒 | `/alert/stop` | `{"message":"Alert stopped"}` | The tracking link stops working immediately. |
| GET | `/track/{share_token}` | `{"latitude","longitude","time"}` | **No login.** Returns `{"message":"Waiting for first location"}` before the first point, and 404 "Tracking link is not active" once stopped. |

### Audio

| Method | Path | Body | Success response |
|---|---|---|---|
| POST 🔒 | `/audio` | multipart form, field name `file` | `{"message":"Audio saved","filename":"..."}` |
| GET 🔒 | `/audio` | none | `[{"id","filename","time"}, ...]` |
| GET 🔒 | `/audio/{id}` | none (optional `?download=true`) | The audio file. 404 if it isn't yours or is missing. |

Limits: up to 20 MB per file. Accepted types: `.webm`, `.mp4`, `.m4a`, `.wav`, `.mp3`.

A plain `<audio src="...">` tag can't send the login token, so fetch the file with the token and play it from a blob URL:

```js
const res = await fetch(API + "/audio/" + id, {
  headers: { Authorization: "Bearer " + token },
});
audioElement.src = URL.createObjectURL(await res.blob());
```

### Nearby help

`GET /nearby` 🔒

| Query parameter | Meaning |
|---|---|
| `place` | `hospital`, `pharmacy` or `police` (required) |
| `lat`, `lon` | The user's current position (required) |
| `radius` | Search radius in metres, 500 to 20000 (default 5000) |

Returns up to 5 places, nearest first:

```json
[
  {
    "name": "Example Hospital",
    "distance_m": 850,
    "latitude": 22.57,
    "longitude": 88.36,
    "phone": "+91...",
    "opening_hours": "24/7",
    "map_link": "https://www.google.com/maps/dir/?api=1&destination=22.57,88.36"
  }
]
```

- `phone` and `opening_hours` can be `null`, and some places have no name ("Unnamed hospital"). The data comes from OpenStreetMap volunteers, so coverage varies.
- Status 502 means the map service is busy or unreachable. Show "try again" and let the user retry.
- If you show these places on a map, display the credit **© OpenStreetMap contributors**.

## Screens to build

1. **Login / register**: username and password, error messages, keep the token so a refresh doesn't log the user out, and a log out button. Include "forgot password" (recovery code) and change password.
2. **Home**
   - A large, easy-to-tap **Start alert** button. On press: call `/alert/start`, show the tracking link with a copy/share button, send the current position to `/location` immediately and then **every 5 seconds**, and record audio in consecutive pieces of about **10 seconds**, uploading each one to `/audio` with no gaps between pieces.
   - A **Stop alert** button that stops sending and recording, uploads the last piece and calls `/alert/stop`.
   - If a network call fails during an alert, keep going and retry with the next piece.
   - Clear messages when location or microphone permission is denied.
3. **Contacts**: add, list and delete.
4. **Recordings**: list, play and download.
5. **Nearby help**: buttons for hospital, pharmacy and police. Call `/nearby` with the phone's GPS position and show the results with distance, phone (tap to call) and a directions button using `map_link`. A map with pins is welcome.
6. **Tracking page for contacts** (separate page, **no login, none of the main app's code**): poll `/track/{share_token}` every 5 seconds and show the latest position with "updated 12 seconds ago". A map is preferred. Show "Waiting for first location" and "This alert has ended" for the two cases above.
7. **Account**: change password, recovery code, delete account (with a clear confirmation).

`frontend/index.html` is a rough working example of the login, contacts and alert screens, useful as a reference for how the calls fit together. It does not cover the newer features. Feel free to replace it.

## Requirements

- **Mobile-first.** Most users will be on a phone, so use large buttons and small-screen layouts.
- **HTTPS.** Phones only allow location and microphone on secure pages (`localhost` is fine for testing).
- **Browsers.** Test on Safari (iPhone) and Chrome (Android). Safari records `audio/mp4` and Chrome records `audio/webm`, so upload with the matching file extension.
- **Background limits.** Browsers may pause location and recording when the screen locks or the tab goes to the background. Please report what you see on real phones. Keeping the screen awake during an alert (Screen Wake Lock API) helps.
- **Safety.** Don't put secrets in front-end code, don't log tokens, and insert text from the API (such as contact names) in a way that can't run as HTML.

## Not built yet

- Texting contacts the tracking link when an alert starts (planned, via Twilio).
- Automatic alert trigger (safe word or sound detection).

## Decisions we need to make together

- The final address of the tracking page. Today `/track/{token}` returns raw data, and the link in future text messages should point to your page.
- The hosted API address, and the final front-end address (for CORS).
- Which map library to use (Leaflet with OpenStreetMap is free and needs no account).

## Working on this repo

- Please work on a branch (for example `frontend`) and open a pull request instead of pushing to `main`.
- Put your front-end code in the `frontend/` folder.
- If the API is missing something or behaves oddly, open an **Issue** on GitHub with the request you sent and the response you got.
