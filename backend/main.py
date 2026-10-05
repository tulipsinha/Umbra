import re
import time
import psycopg2
from psycopg2 import pool as pg_pool
import smtplib
from email.mime.text import MIMEText
from google import genai
from google.genai import types
from fastapi.responses import FileResponse
import math
import httpx
from fastapi import BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
import os
from fastapi import UploadFile, File
import secrets
import jwt
from datetime import datetime, timedelta, timezone
from fastapi import Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from pwdlib import PasswordHash
from dotenv import load_dotenv

load_dotenv()  # reads a local .env file if present; does nothing on Render, which uses its own env vars

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://umbra-roqr.onrender.com",
           "https://safety-app-frontend.onrender.com",
           "http://localhost:3000",
           "http://127.0.0.1:3000",],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Strict-Transport-Security"] = "max-age=31536000"
    return response

password_hasher = PasswordHash.recommended()
SECRET_KEY = os.environ.get("SECRET_KEY", "local-testing-only-not-for-real-use-1234567890")
if os.environ.get("RENDER") and "SECRET_KEY" not in os.environ:
    raise RuntimeError("SECRET_KEY must be set in production")
DATA_DIR = os.environ.get("DATA_DIR", ".")
DATABASE_URL = os.environ.get("DATABASE_URL")

DB_POOL = None

class PooledConn:
    """Wraps a pooled connection so the existing conn.close() calls
    return it to the pool instead of closing it."""
    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        if DB_POOL is None:
            self._conn.close()
            return
        try:
            self._conn.rollback()
            DB_POOL.putconn(self._conn)
        except Exception:
            DB_POOL.putconn(self._conn, close=True)

def get_conn():
    global DB_POOL
    if DB_POOL is None:
        DB_POOL = pg_pool.ThreadedConnectionPool(1, 10, DATABASE_URL)
    try:
        conn = DB_POOL.getconn()
        if conn.closed:
            DB_POOL.putconn(conn, close=True)
            conn = DB_POOL.getconn()
        return PooledConn(conn)
    except pg_pool.PoolError:
        # Pool is busy: fall back to a normal one-off connection
        return psycopg2.connect(DATABASE_URL)
RECORDINGS_DIR = os.path.join(DATA_DIR, "recordings")
bearer = HTTPBearer()

def create_token(username, version):
    payload = {"sub": username, "ver": version, "exp": datetime.now(timezone.utc) + timedelta(hours=12)}
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)):
    try:
        data = jwt.decode(creds.credentials, SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT token_version FROM users WHERE username = %s", (data["sub"],))
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None or row[0] != data.get("ver"):
        raise HTTPException(status_code=401, detail="Session is no longer valid, please log in again")
    return data["sub"]
class UserIn(BaseModel):
    username: str
    password: str

class LocationIn(BaseModel):
    latitude: float
    longitude: float

class ContactIn(BaseModel):
    name: str
    phone: str   
    email: str | None = None

def setup_database():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS locations (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS contacts (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            email TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS alerts (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            share_token TEXT UNIQUE NOT NULL,
            active INTEGER NOT NULL,
            started_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS recordings (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            filename TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS recovery_codes (
            username TEXT PRIMARY KEY,
            code_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS failed_attempts (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            first_at TEXT NOT NULL,
            locked_until TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_settings (
            username TEXT PRIMARY KEY,
            start_trigger TEXT NOT NULL DEFAULT 'did you feed the cat',
            stop_trigger TEXT NOT NULL DEFAULT 'okay talk later'
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS walks (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            destination TEXT NOT NULL,
            started_at TEXT NOT NULL,
            due_at TEXT NOT NULL,
            status TEXT NOT NULL
        )
    """)
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS first_viewed_at TEXT")
    cur.execute("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS viewed_by TEXT")
    cur.execute("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resent INTEGER DEFAULT 0")
    conn.commit()
    cur.close()
    conn.close()

setup_database()
os.makedirs(RECORDINGS_DIR, exist_ok=True)

@app.get("/")
def home():
    return {"message": "Safety app is running"}

@app.post("/register")
def register(user: UserIn):
    conn = get_conn()
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO users (username, password_hash) VALUES (%s, %s)",
            (user.username, password_hasher.hash(user.password)),
        )
        conn.commit()
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="Username already taken")
    finally:
        cur.close()
        conn.close()
    return {"message": "User registered"}
@app.post("/login")
def login(user: UserIn):
    key = "login:" + user.username[:100]
    check_locked(key)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT password_hash, token_version FROM users WHERE username = %s",
        (user.username,),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None or not password_hasher.verify(user.password, row[0]):
        record_fail(key)
        raise HTTPException(status_code=401, detail="Wrong username or password")
    clear_fails(key)
    return {"message": "Login successful", "token": create_token(user.username, row[1])}
@app.get("/me")
def me(username: str = Depends(get_current_user)):
    return {"username": username}

@app.post("/location")
def save_location(loc: LocationIn, username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO locations (username, latitude, longitude, created_at) VALUES (%s, %s, %s, %s)",
        (username, loc.latitude, loc.longitude, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Location saved"}
@app.get("/location/latest")
def latest_location(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT latitude, longitude, created_at FROM locations WHERE username = %s ORDER BY id DESC LIMIT 1",
        (username,),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="No location saved yet")
    return {"latitude": row[0], "longitude": row[1], "time": row[2]}

@app.post("/contacts")
def add_contact(contact: ContactIn, username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO contacts (username, name, phone, email) VALUES (%s, %s, %s, %s)",
        (username, contact.name, contact.phone, contact.email),
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Contact added"}

@app.get("/contacts")
def list_contacts(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, name, phone, email FROM contacts WHERE username = %s",
        (username,),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [{"id": r[0], "name": r[1], "phone": r[2], "email": r[3]} for r in rows]

@app.delete("/contacts/{contact_id}")
def delete_contact(contact_id: int, username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM contacts WHERE id = %s AND username = %s",
        (contact_id, username),
    )
    conn.commit()
    deleted = cur.rowcount
    cur.close()
    conn.close()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"message": "Contact deleted"}

def send_alert_emails(username, token, reminder=False, walk_destination=None):
    brevo_key = os.environ.get("BREVO_API_KEY")
    sender_email = os.environ.get("SENDER_EMAIL")
    if not brevo_key or not sender_email:
        print("Email skipped: BREVO_API_KEY or SENDER_EMAIL not set")
        return
    base = os.environ.get("PUBLIC_URL", "http://127.0.0.1:8000")
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, name, email FROM contacts "
        "WHERE username = %s AND email IS NOT NULL AND email <> ''",
        (username,),
    )
    contacts = cur.fetchall()
    cur.close()
    conn.close()
    headers = {
        "api-key": brevo_key,
        "accept": "application/json",
        "content-type": "application/json",
    }
    if walk_destination:
        subject = f"{username} hasn't arrived at {walk_destination}"
        intro = (
            f"{username} started a walk to {walk_destination} using the safety app "
            "but didn't check in on time."
        )
    elif reminder:
        subject = f"REMINDER: {username} still needs you"
        intro = f"{username}'s safety alert is still active and nobody has opened the tracking link yet."
    else:
        subject = f"{username} started a safety alert"
        intro = f"{username} started a safety alert."
    for (contact_id, name, email) in contacts:
        link = f"{base}/track.html?token={token}&v={contact_id}"
        body = (
            f"Hi {name},\n\n{intro} Follow their live location here:\n{link}\n\n"
            "If you cannot reach them, call 112."
        )
        try:
            res = httpx.post(
                "https://api.brevo.com/v3/smtp/email",
                headers=headers,
                json={
                    "sender": {"name": "Safety App", "email": sender_email},
                    "to": [{"email": email}],
                    "subject": subject,
                    "textContent": body,
                },
                timeout=10,
            )
            if res.status_code >= 400:
                print(f"Email to {email} rejected ({res.status_code}): {res.text}")
        except Exception as e:
            print("Email failed:", e)
@app.post("/alert/start")
def start_alert(background_tasks: BackgroundTasks, username: str = Depends(get_current_user)):
    token = secrets.token_urlsafe(16)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE alerts SET active = 0 WHERE username = %s", (username,))
    cur.execute(
        "INSERT INTO alerts (username, share_token, active, started_at) VALUES (%s, %s, 1, %s)",
        (username, token, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    cur.close()
    conn.close()
    background_tasks.add_task(send_alert_emails, username, token)
    return {"message": "Alert started", "share_token": token, "track_path": f"/track/{token}"}

@app.post("/alert/stop")
def stop_alert(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE alerts SET active = 0 WHERE username = %s", (username,))
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Alert stopped"}


RESEND_AFTER_MINUTES = 3

@app.get("/alert/status")
def alert_status(background_tasks: BackgroundTasks, username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT share_token, started_at, first_viewed_at, viewed_by, resent FROM alerts "
        "WHERE username = %s AND active = 1 ORDER BY id DESC LIMIT 1",
        (username,),
    )
    row = cur.fetchone()
    if row is None:
        cur.close()
        conn.close()
        return {"active": False, "viewed": False, "viewed_by": None, "resent": False}
    token, started_at, viewed_at, viewed_by, resent = row
    resending = False
    if viewed_at is None and not resent:
        started = datetime.fromisoformat(started_at)
        if datetime.now(timezone.utc) - started > timedelta(minutes=RESEND_AFTER_MINUTES):
            cur.execute("UPDATE alerts SET resent = 1 WHERE share_token = %s", (token,))
            conn.commit()
            background_tasks.add_task(send_alert_emails, username, token, True)
            resending = True
    cur.close()
    conn.close()
    return {
        "active": True,
        "viewed": viewed_at is not None,
        "viewed_by": viewed_by,
        "resent": bool(resent) or resending,
    }


class WalkStartIn(BaseModel):
    destination: str
    minutes: int

class WalkExtendIn(BaseModel):
    minutes: int

WALK_GRACE_MINUTES = 2

def create_alert(username):
    token = secrets.token_urlsafe(16)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE alerts SET active = 0 WHERE username = %s", (username,))
    cur.execute(
        "INSERT INTO alerts (username, share_token, active, started_at) VALUES (%s, %s, 1, %s)",
        (username, token, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    cur.close()
    conn.close()
    return token

@app.post("/walk/start")
def walk_start(data: WalkStartIn, username: str = Depends(get_current_user)):
    destination = data.destination.strip()
    if not destination or len(destination) > 100:
        raise HTTPException(status_code=400, detail="Destination must be 1 to 100 characters")
    if data.minutes < 1 or data.minutes > 180:
        raise HTTPException(status_code=400, detail="Minutes must be between 1 and 180")
    now = datetime.now(timezone.utc)
    due = now + timedelta(minutes=data.minutes)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "UPDATE walks SET status = 'cancelled' WHERE username = %s AND status = 'active'",
        (username,),
    )
    cur.execute(
        "INSERT INTO walks (username, destination, started_at, due_at, status) "
        "VALUES (%s, %s, %s, %s, 'active')",
        (username, destination, now.isoformat(), due.isoformat()),
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Walk started", "destination": destination, "due_at": due.isoformat()}

@app.post("/walk/arrived")
def walk_arrived(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "UPDATE walks SET status = 'arrived' WHERE username = %s AND status = 'active'",
        (username,),
    )
    updated = cur.rowcount
    conn.commit()
    cur.close()
    conn.close()
    if updated == 0:
        raise HTTPException(status_code=404, detail="No active walk")
    return {"message": "Glad you made it safely"}

@app.post("/walk/extend")
def walk_extend(data: WalkExtendIn, username: str = Depends(get_current_user)):
    if data.minutes < 1 or data.minutes > 60:
        raise HTTPException(status_code=400, detail="You can extend by 1 to 60 minutes")
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, due_at FROM walks WHERE username = %s AND status = 'active' "
        "ORDER BY id DESC LIMIT 1",
        (username,),
    )
    row = cur.fetchone()
    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="No active walk")
    now = datetime.now(timezone.utc)
    new_due = max(datetime.fromisoformat(row[1]), now) + timedelta(minutes=data.minutes)
    cur.execute("UPDATE walks SET due_at = %s WHERE id = %s", (new_due.isoformat(), row[0]))
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Walk extended", "due_at": new_due.isoformat()}

@app.get("/walk/status")
def walk_status(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT destination, due_at, status FROM walks WHERE username = %s "
        "ORDER BY id DESC LIMIT 1",
        (username,),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        return {"status": "none"}
    destination, due_at, status = row
    seconds_left = int((datetime.fromisoformat(due_at) - datetime.now(timezone.utc)).total_seconds())
    return {
        "status": status,
        "destination": destination,
        "due_at": due_at,
        "seconds_left": seconds_left,
    }

@app.get("/walk/check-overdue")
def walk_check_overdue(key: str, background_tasks: BackgroundTasks):
    expected = os.environ.get("CRON_SECRET")
    if not expected or not secrets.compare_digest(key, expected):
        raise HTTPException(status_code=403, detail="Forbidden")
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=WALK_GRACE_MINUTES)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id, username, destination, due_at FROM walks WHERE status = 'active'")
    rows = cur.fetchall()
    fired = 0
    for (walk_id, username, destination, due_at) in rows:
        if datetime.fromisoformat(due_at) > cutoff:
            continue
        cur.execute(
            "UPDATE walks SET status = 'alerted' WHERE id = %s AND status = 'active'",
            (walk_id,),
        )
        updated = cur.rowcount
        conn.commit()
        if updated == 1:
            token = create_alert(username)
            background_tasks.add_task(send_alert_emails, username, token, False, destination)
            fired += 1
    cur.close()
    conn.close()
    return {"checked": len(rows), "alerts_fired": fired}

@app.get("/track/{share_token}")
def track(share_token: str, v: int | None = None):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT username FROM alerts WHERE share_token = %s AND active = 1",
        (share_token,),
    )
    alert = cur.fetchone()
    if alert is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="Tracking link is not active")
    if v is not None:
        cur.execute(
            "UPDATE alerts SET first_viewed_at = %s, "
            "viewed_by = (SELECT c.name FROM contacts c "
            "             WHERE c.id = %s AND c.username = alerts.username) "
            "WHERE share_token = %s AND first_viewed_at IS NULL "
            "AND EXISTS (SELECT 1 FROM contacts c "
            "            WHERE c.id = %s AND c.username = alerts.username)",
            (datetime.now(timezone.utc).isoformat(), v, share_token, v),
        )
        conn.commit()
    cur.execute(
        "SELECT latitude, longitude, created_at FROM locations WHERE username = %s ORDER BY id DESC LIMIT 1",
        (alert[0],),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        return {"message": "Waiting for first location"}
    return {"latitude": row[0], "longitude": row[1], "time": row[2]}

@app.post("/audio")
def upload_audio(file: UploadFile = File(...), username: str = Depends(get_current_user)):
    data = file.file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large")
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".webm", ".mp4", ".m4a", ".wav", ".mp3"):
        ext = ".webm"
    filename = secrets.token_hex(8) + ext
    with open(os.path.join(RECORDINGS_DIR, filename), "wb") as f:
        f.write(data)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO recordings (username, filename, created_at) VALUES (%s, %s, %s)",
        (username, filename, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Audio saved", "filename": filename}

@app.get("/audio")
def list_audio(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, filename, created_at FROM recordings WHERE username = %s ORDER BY id DESC",
        (username,),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [{"id": r[0], "filename": r[1], "time": r[2]} for r in rows]

@app.delete("/audio")
def clear_all_audio(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()

    cur.execute(
        "SELECT filename FROM recordings WHERE username = %s",
        (username,),
    )
    rows = cur.fetchall()

    cur.execute(
        "DELETE FROM recordings WHERE username = %s",
        (username,),
    )
    deleted_count = cur.rowcount
    conn.commit()
    cur.close()
    conn.close()

    # Delete the actual audio files from disk
    for (filename,) in rows:
        safe_filename = os.path.basename(filename)
        path = os.path.join(RECORDINGS_DIR, safe_filename)

        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError as e:
            print("Could not delete recording file:", safe_filename, repr(e))

    return {
        "message": "All audio recordings cleared",
        "deleted": deleted_count,
    }

CONTACT = os.environ.get("CONTACT_EMAIL", "not-set")
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

OVERPASS_CACHE = {}
OVERPASS_CACHE_SECONDS = 600

def overpass_query(query):
    cached = OVERPASS_CACHE.get(query)
    if cached and time.time() - cached[0] < OVERPASS_CACHE_SECONDS:
        return cached[1]
    headers = {"User-Agent": f"SafetyApp/1.0 ({CONTACT})"}
    for url in OVERPASS_URLS:
        try:
            res = httpx.post(url, data={"data": query}, headers=headers, timeout=25)
            res.raise_for_status()
            elements = res.json().get("elements", [])
            OVERPASS_CACHE[query] = (time.time(), elements)
            return elements
        except Exception as e:
            print("Overpass error:", url, repr(e))
    if cached:
        return cached[1]
    return None

def distance_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

@app.get("/nearby")
def nearby(
    place: str = Query(..., pattern="^(hospital|pharmacy|police)$"),
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius: int = Query(5000, ge=500, le=20000),
    username: str = Depends(get_current_user),
):
    lat = round(lat, 3)
    lon = round(lon, 3)
    query = (
        "[out:json][timeout:25];("
        f'node["amenity"="{place}"](around:{radius},{lat},{lon});'
        f'way["amenity"="{place}"](around:{radius},{lat},{lon});'
        ");out center 50;"
    )
    elements = overpass_query(query)
    if elements is None:
        raise HTTPException(status_code=502, detail="Map service unavailable, try again")
    results = []
    for e in elements:
        elat = e.get("lat", e.get("center", {}).get("lat"))
        elon = e.get("lon", e.get("center", {}).get("lon"))
        if elat is None or elon is None:
            continue
        tags = e.get("tags", {})
        results.append({
            "name": tags.get("name", "Unnamed " + place),
            "distance_m": round(distance_m(lat, lon, elat, elon)),
            "latitude": elat,
            "longitude": elon,
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "opening_hours": tags.get("opening_hours"),
            "map_link": f"https://www.google.com/maps/dir/?api=1&destination={elat},{elon}",
        })
    results.sort(key=lambda r: r["distance_m"])
    return results[:5]

AUDIO_TYPES = {
    ".webm": "audio/webm",
    ".mp4": "audio/mp4",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
}

AREA_SCAN_LIMIT = 20          # scans allowed per visitor
AREA_SCAN_WINDOW = 3600       # per hour (seconds)
AREA_SCAN_LOG = {}

def check_area_scan_limit(request: Request):
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    now = time.time()
    recent = [t for t in AREA_SCAN_LOG.get(ip, []) if now - t < AREA_SCAN_WINDOW]
    if len(recent) >= AREA_SCAN_LIMIT:
        raise HTTPException(status_code=429, detail="Too many area scans, try again later")
    recent.append(now)
    AREA_SCAN_LOG[ip] = recent
@app.get("/area-safety")
def area_safety(
    request: Request,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
):
    lat = round(lat, 3)
    lon = round(lon, 3)
    query = (
        "[out:json][timeout:25];("
        f'way(around:200,{lat},{lon})["highway"]["lit"="yes"];'
        f'way(around:300,{lat},{lon})["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"];'
        f'node(around:1000,{lat},{lon})["amenity"="police"];'
        f'node(around:1000,{lat},{lon})["amenity"="hospital"];'
        f'node(around:300,{lat},{lon})["shop"];'
        f'node(around:300,{lat},{lon})["amenity"~"^(restaurant|cafe|pharmacy)$"];'
        ");out center;"
    )
    elements = overpass_query(query)
    if elements is None:
        raise HTTPException(status_code=502, detail="Map service unavailable, try again")

    lit_road_count = 0
    main_road_count = 0
    nearest_police_m = None
    nearest_hospital_m = None
    business_count = 0

    for e in elements:
        tags = e.get("tags", {})
        if e["type"] == "way":
            if tags.get("lit") == "yes":
                lit_road_count += 1
            if tags.get("highway") in ("motorway", "trunk", "primary", "secondary", "tertiary"):
                main_road_count += 1
        elif e["type"] == "node":
            elat = e.get("lat")
            elon = e.get("lon")
            if elat is None or elon is None:
                continue
            d = distance_m(lat, lon, elat, elon)
            if tags.get("amenity") == "police":
                if nearest_police_m is None or d < nearest_police_m:
                    nearest_police_m = round(d)
            elif tags.get("amenity") == "hospital":
                if nearest_hospital_m is None or d < nearest_hospital_m:
                    nearest_hospital_m = round(d)
            elif "shop" in tags or tags.get("amenity") in ("restaurant", "cafe", "pharmacy"):
                business_count += 1

    api_key = os.environ.get("GEMINI_API_KEY")
    summary = None
    if api_key:
        try:
            client = genai.Client(api_key=api_key)
            prompt = (
                f"Lit road segments nearby: {lit_road_count}. "
                f"Main roads nearby: {main_road_count}. "
                f"Nearest police station: {nearest_police_m if nearest_police_m is not None else 'not found within 1km'} meters. "
                f"Nearest hospital: {nearest_hospital_m if nearest_hospital_m is not None else 'not found within 1km'} meters. "
                f"Open businesses nearby: {business_count}. "
                "Note: lit-road counts come from volunteer map tags that are often missing, "
                "so a count of 0 means lighting is unknown, not that the area is dark. "
                "Never claim an area is unlit or lacks lighting based on a 0. "
                "Respond with ONLY the 1-2 sentence safety impression itself — no preamble, "
                "no 'here is', no drafting notes. Base it only on this data, in plain "
                "language for a pedestrian. Do not invent details not given. Avoid "
                "alarming language; be calm and factual."
            )
            res = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=300,
                    temperature=0.4,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
            summary = (res.text or "").strip() or None
        except Exception as e:
            print("Area safety AI error:", repr(e))

    if summary is None:
        parts = []
        if lit_road_count > 0:
            parts.append(f"{lit_road_count} lit road segment{'s' if lit_road_count > 1 else ''}")
        if main_road_count > 0:
            parts.append(f"{main_road_count} main road{'s' if main_road_count > 1 else ''}")
        if nearest_police_m is not None:
            parts.append(f"police {nearest_police_m}m away")
        if nearest_hospital_m is not None:
            parts.append(f"hospital {nearest_hospital_m}m away")
        if business_count > 0:
            parts.append(f"{business_count} active spot{'s' if business_count > 1 else ''}")
        if parts:
            summary = "Area infrastructure: " + ", ".join(parts) + " detected nearby."
        else:
            summary = "Quiet or low infrastructure density detected. Stay alert and stick to well-traveled paths."
    return {
        "lit_road_segments_nearby": lit_road_count,
        "main_road_segments_nearby": main_road_count,
        "nearest_police_m": nearest_police_m,
        "nearest_hospital_m": nearest_hospital_m,
        "businesses_nearby": business_count,
        "safety_summary": summary
    }

@app.get("/audio/{audio_id}")
def get_audio(audio_id: int, download: bool = False, username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT filename FROM recordings WHERE id = %s AND username = %s",
        (audio_id, username),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    filename = os.path.basename(row[0])
    path = os.path.join(RECORDINGS_DIR, filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Recording file is missing")
    media_type = AUDIO_TYPES.get(os.path.splitext(filename)[1].lower(), "application/octet-stream")
    if download:
        return FileResponse(path, media_type=media_type, filename=filename)
    return FileResponse(path, media_type=media_type)

class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str

class ResetIn(BaseModel):
    username: str
    recovery_code: str
    new_password: str

class PasswordIn(BaseModel):
    password: str

def check_new_password(p):
    if len(p) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if len(p) > 128:
        raise HTTPException(status_code=400, detail="Password is too long")

@app.post("/account/change-password")
def change_password(data: ChangePasswordIn, username: str = Depends(get_current_user)):
    check_new_password(data.new_password)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT password_hash FROM users WHERE username = %s", (username,))
    row = cur.fetchone()
    if row is None or not password_hasher.verify(data.old_password, row[0]):
        cur.close()
        conn.close()
        raise HTTPException(status_code=401, detail="Current password is wrong")
    cur.execute(
        "UPDATE users SET password_hash = %s, token_version = token_version + 1 WHERE username = %s",
        (password_hasher.hash(data.new_password), username),
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Password changed"}

@app.post("/account/recovery-code")
def make_recovery_code(data: PasswordIn, username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT password_hash FROM users WHERE username = %s", (username,))
    row = cur.fetchone()
    if row is None or not password_hasher.verify(data.password, row[0]):
        cur.close()
        conn.close()
        raise HTTPException(status_code=401, detail="Wrong password")
    code = secrets.token_hex(8)
    cur.execute(
        "INSERT INTO recovery_codes (username, code_hash, created_at) VALUES (%s, %s, %s) "
        "ON CONFLICT (username) DO UPDATE SET code_hash = EXCLUDED.code_hash, created_at = EXCLUDED.created_at",
        (username, password_hasher.hash(code), datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"recovery_code": code, "message": "Save this code somewhere safe. It is shown only once and replaces any older code."}

@app.post("/password/reset")
def reset_password(data: ResetIn):
    key = "reset:" + data.username[:100]
    check_locked(key)
    check_new_password(data.new_password)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT code_hash FROM recovery_codes WHERE username = %s", (data.username,))
    row = cur.fetchone()
    ok = False
    if row is not None:
        try:
            ok = password_hasher.verify(data.recovery_code.strip().lower(), row[0])
        except Exception:
            ok = False
    if not ok:
        cur.close()
        conn.close()
        record_fail(key)
        raise HTTPException(status_code=401, detail="Wrong username or recovery code")
    cur.execute(
        "UPDATE users SET password_hash = %s, token_version = token_version + 1 WHERE username = %s",
        (password_hasher.hash(data.new_password), data.username),
    )
    cur.execute("DELETE FROM recovery_codes WHERE username = %s", (data.username,))
    conn.commit()
    cur.close()
    conn.close()
    clear_fails(key)
    return {"message": "Password reset. Log in with the new password."}

@app.post("/account/delete")
def delete_account(data: PasswordIn, username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT password_hash FROM users WHERE username = %s", (username,))
    row = cur.fetchone()
    if row is None or not password_hasher.verify(data.password, row[0]):
        cur.close()
        conn.close()
        raise HTTPException(status_code=401, detail="Wrong password")
    cur.execute("SELECT filename FROM recordings WHERE username = %s", (username,))
    files = cur.fetchall()
    for (name,) in files:
        try:
            os.remove(os.path.join(RECORDINGS_DIR, os.path.basename(name)))
        except FileNotFoundError:
            pass
    for table in ("recordings", "locations", "contacts", "alerts", "recovery_codes", "chat_messages", "users", "walks"):
        cur.execute(f"DELETE FROM {table} WHERE username = %s", (username,))
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Account and all data deleted"}

MAX_FAILS = 5
LOCK_MINUTES = 10

def check_locked(key):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT locked_until FROM failed_attempts WHERE key = %s", (key,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row and row[0]:
        until = datetime.fromisoformat(row[0])
        now = datetime.now(timezone.utc)
        if until > now:
            minutes = int((until - now).total_seconds() // 60) + 1
            raise HTTPException(status_code=429, detail=f"Too many attempts. Try again in {minutes} minutes")

def record_fail(key):
    now = datetime.now(timezone.utc)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT count, first_at FROM failed_attempts WHERE key = %s", (key,))
    row = cur.fetchone()
    if row is None or datetime.fromisoformat(row[1]) < now - timedelta(minutes=LOCK_MINUTES):
        count, first = 1, now
    else:
        count, first = row[0] + 1, datetime.fromisoformat(row[1])
    locked = None
    if count >= MAX_FAILS:
        locked = (now + timedelta(minutes=LOCK_MINUTES)).isoformat()
    cur.execute(
        "INSERT INTO failed_attempts (key, count, first_at, locked_until) VALUES (%s, %s, %s, %s) "
        "ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, first_at = EXCLUDED.first_at, locked_until = EXCLUDED.locked_until",
        (key, count, first.isoformat(), locked),
    )
    conn.commit()
    cur.close()
    conn.close()

def clear_fails(key):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM failed_attempts WHERE key = %s", (key,))
    conn.commit()
    cur.close()
    conn.close()

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

BUDDY_PROMPT = (
    "You are Mira, the user's close friend from college. You are on a normal phone call "
    "with them while they walk somewhere. You live in Kolkata and talk like a real "
    "young Indian person on the phone, not like an assistant.\n"
    "How you talk:\n"
    "- Very short turns: usually one sentence, at most two. Phone calls are quick back-and-forth.\n"
    "- Casual Indian English. Light Hinglish or Bengali words are fine sometimes "
    "(arre, yaar, accha, haan, na). Don't overdo it.\n"
    "- Use natural fillers sometimes: 'hmm', 'wait', 'oh', 'acha', 'haha'.\n"
    "- Contractions always (I'm, you're, don't). No formal words like 'certainly', "
    "'absolutely', 'I understand', 'feel free', 'I'm here for you', 'that sounds'.\n"
    "- React first, like a friend: 'No way!', 'Uff, seriously?', 'Haha okay'.\n"
    "- Ask at most one question, and only sometimes. Sometimes just share something "
    "small about your own day (class, food, a show, your annoying roommate).\n"
    "- Never give advice lists, never summarise, never use bullet points, emojis, "
    "asterisks or markdown. Your words are spoken aloud.\n"
    "- Never say you are an AI, a bot or an assistant, even if asked. Laugh it off like a friend would.\n"
    "- If the user sounds scared or mentions being followed, stay calm and natural, "
    "keep them talking, and casually suggest walking toward a busy, lit place, "
    "as a friend would, without sounding like an emergency service.\n"
    "Examples of the right style:\n"
    "User: hey what's up\nMira: Arre finally! I've been so bored, our lecture got cancelled.\n"
    "User: just walking back from the metro\nMira: Oh acha, it's late na. Which road are you on?\n"
    "User: I'm so tired\nMira: Haha same yaar, I literally slept through my alarm today.\n"
)


FALLBACK_REPLY = "Hey, I didn't quite catch that, can you say it again?"

DANGER_WORDS = [
    "help me", "following me", "followed", "attacked", "hurt me", "unsafe",
    "in danger", "scared", "kidnap", "threat", "stalk", "grabbed", "someone is behind",
]
START_TRIGGER = "did you feed the cat"
STOP_TRIGGER = "okay talk later"

class ChatIn(BaseModel):
    message: str

class TriggerSettingsIn(BaseModel):
    start_trigger: str
    stop_trigger: str

def clean_spoken_reply(text):
    """Strip anything that sounds robotic when read aloud."""
    text = re.sub(r"[*_#`>~]", "", text)                               # markdown symbols
    text = re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", "", text)   # emojis
    text = re.sub(r"\s+", " ", text).strip()
    for phrase in ("As an AI", "as an AI", "I'm an AI", "language model"):
        text = text.replace(phrase, "")
    text = text.strip(" ,.")
    return text or "Hmm, sorry, say that again?"
@app.post("/chat")
def chat(data: ChatIn, username: str = Depends(get_current_user)):
    text = data.message.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message is empty")
    if len(text) > 500:
        raise HTTPException(status_code=400, detail="Message is too long (max 500 characters)")
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Chat is not set up on this server")
    now = datetime.now(timezone.utc)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT COUNT(*) FROM chat_messages WHERE username = %s AND role = 'user' AND created_at > %s",
        (username, (now - timedelta(hours=1)).isoformat()),
    )
    count_row = cur.fetchone()
    sent = count_row[0] if count_row else 0
    if sent >= 30:
        cur.close()
        conn.close()
        raise HTTPException(status_code=429, detail="You are chatting a lot! Try again in a little while")
    cur.execute(
        "SELECT role, content FROM chat_messages WHERE username = %s ORDER BY id DESC LIMIT 16",
        (username,),
    )
    rows = cur.fetchall()
    rows.reverse()
    while rows and rows[0][0] == "model":
        rows.pop(0)
    history = [types.Content(role=r, parts=[types.Part.from_text(text=c)]) for r, c in rows]
    history.append(types.Content(role="user", parts=[types.Part.from_text(text=text)]))
    emergency = any(w in text.lower() for w in DANGER_WORDS)
    conn2 = get_conn()
    cur2 = conn2.cursor()
    cur2.execute(
        "SELECT start_trigger, stop_trigger FROM user_settings WHERE username = %s",
        (username,),
    )
    trig_row = cur2.fetchone()
    cur2.close()
    conn2.close()
    user_start = trig_row[0] if trig_row else START_TRIGGER
    user_stop = trig_row[1] if trig_row else STOP_TRIGGER

    trigger_start = user_start in text.lower()
    trigger_stop = user_stop in text.lower()
    try:
        client = genai.Client(api_key=api_key)
        res = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=history,
            config=types.GenerateContentConfig(
                system_instruction=BUDDY_PROMPT,
                max_output_tokens=120,
                temperature=1.0,
                thinking_config=types.ThinkingConfig(thinking_budget=0)
            ),
        )
        reply = clean_spoken_reply(res.text or "")
    except Exception as e:
        print("Chat error:", repr(e))
        cur.close()
        conn.close()
        raise HTTPException(status_code=502, detail="Chat service unavailable, try again")
    stamp = now.isoformat()
    cur.execute(
        "INSERT INTO chat_messages (username, role, content, created_at) VALUES (%s, 'user', %s, %s)",
        (username, text, stamp),
    )
    cur.execute(
        "INSERT INTO chat_messages (username, role, content, created_at) VALUES (%s, 'model', %s, %s)",
        (username, reply, stamp),
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"reply": reply, "emergency": emergency, "trigger_start": trigger_start, "trigger_stop": trigger_stop}

@app.get("/settings/triggers")
def get_triggers(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT start_trigger, stop_trigger FROM user_settings WHERE username = %s",
        (username,),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        return {"start_trigger": START_TRIGGER, "stop_trigger": STOP_TRIGGER}
    return {"start_trigger": row[0], "stop_trigger": row[1]}

@app.post("/settings/triggers")
def set_triggers(data: TriggerSettingsIn, username: str = Depends(get_current_user)):
    start = data.start_trigger.strip().lower()
    stop = data.stop_trigger.strip().lower()
    if not start or not stop:
        raise HTTPException(status_code=400, detail="Both phrases are required")
    if start == stop:
        raise HTTPException(status_code=400, detail="Start and stop phrases must be different")
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO user_settings (username, start_trigger, stop_trigger)
        VALUES (%s, %s, %s)
        ON CONFLICT (username) DO UPDATE SET start_trigger = %s, stop_trigger = %s
        """,
        (username, start, stop, start, stop),
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Trigger phrases saved"}

@app.get("/chat/history")
def chat_history(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT role, content, created_at FROM chat_messages WHERE username = %s ORDER BY id DESC LIMIT 50",
        (username,),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    rows.reverse()
    return [{"role": r[0], "content": r[1], "time": r[2]} for r in rows]

@app.delete("/chat/history")
def clear_chat(username: str = Depends(get_current_user)):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM chat_messages WHERE username = %s", (username,))
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Chat history deleted"}
