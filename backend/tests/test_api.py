"""Tests for the Umbra backend API.

Run from the backend/ folder:
    source ../env.sh
    python -m pytest -v
"""

import main
from conftest import PASSWORD


# ---------- basics and security ----------

def test_server_is_up(client):
    r = client.get("/")
    assert r.status_code == 200


def test_security_headers_present(client):
    r = client.get("/")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert r.headers.get("Referrer-Policy") == "no-referrer"


def test_protected_endpoint_needs_login(client):
    r = client.get("/contacts")
    assert r.status_code in (401, 403)


def test_fake_token_is_rejected(client):
    r = client.get("/contacts", headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code in (401, 403)


# ---------- accounts ----------

def test_wrong_password_cannot_log_in(client, user):
    username, _ = user
    r = client.post("/login", json={"username": username, "password": "wrong-password-999"})
    assert r.status_code in (400, 401)


def test_duplicate_username_rejected(client, user):
    username, _ = user
    r = client.post("/register", json={"username": username, "password": PASSWORD})
    assert r.status_code >= 400


def test_me_returns_logged_in_user(client, user):
    _, headers = user
    r = client.get("/me", headers=headers)
    assert r.status_code == 200


# ---------- contacts and data isolation ----------

def _add_contact(client, headers, name="Riya"):
    r = client.post(
        "/contacts",
        headers=headers,
        json={"name": name, "phone": "+919812345678", "email": "riya@example.com"},
    )
    assert r.status_code in (200, 201), r.text
    contacts = client.get("/contacts", headers=headers).json()
    return next(c for c in contacts if c["name"] == name)


def test_add_list_delete_contact(client, user):
    _, headers = user
    contact = _add_contact(client, headers)
    assert contact["phone"] == "+919812345678"

    r = client.delete(f"/contacts/{contact['id']}", headers=headers)
    assert r.status_code == 200
    names = [c["name"] for c in client.get("/contacts", headers=headers).json()]
    assert "Riya" not in names


def test_users_cannot_see_each_others_contacts(client, user, other_user):
    _, headers_a = user
    _, headers_b = other_user
    contact = _add_contact(client, headers_a, name="Secret Contact")

    b_names = [c["name"] for c in client.get("/contacts", headers=headers_b).json()]
    assert "Secret Contact" not in b_names


def test_users_cannot_delete_each_others_contacts(client, user, other_user):
    _, headers_a = user
    _, headers_b = other_user
    contact = _add_contact(client, headers_a)

    r = client.delete(f"/contacts/{contact['id']}", headers=headers_b)
    assert r.status_code == 404
    a_names = [c["name"] for c in client.get("/contacts", headers=headers_a).json()]
    assert "Riya" in a_names


# ---------- trigger phrases ----------

def test_trigger_phrases_have_defaults(client, user):
    _, headers = user
    r = client.get("/settings/triggers", headers=headers)
    assert r.status_code == 200
    data = r.json()
    assert data["start_trigger"] and data["stop_trigger"]


def test_custom_trigger_phrases_are_saved(client, user):
    _, headers = user
    r = client.post(
        "/settings/triggers",
        headers=headers,
        json={"start_trigger": "did you water the plants", "stop_trigger": "okay see you at home"},
    )
    assert r.status_code == 200
    data = client.get("/settings/triggers", headers=headers).json()
    assert data["start_trigger"] == "did you water the plants"


def test_start_and_stop_phrases_must_differ(client, user):
    _, headers = user
    r = client.post(
        "/settings/triggers",
        headers=headers,
        json={"start_trigger": "same phrase here", "stop_trigger": "same phrase here"},
    )
    assert r.status_code == 400


# ---------- alerts, tracking and Help Is Coming ----------

def test_alert_flow_and_help_is_coming(client, user, sent_emails):
    _, headers = user
    contact = _add_contact(client, headers)
    client.post("/location", headers=headers, json={"latitude": 22.57, "longitude": 88.36})

    r = client.post("/alert/start", headers=headers)
    assert r.status_code == 200, r.text
    token = r.json()["share_token"]
    assert len(sent_emails) == 1                     # contacts were emailed (fake)

    status = client.get("/alert/status", headers=headers).json()
    assert status["active"] is True
    assert status["viewed"] is False

    # A contact opens their personal tracking link (no login needed)
    r = client.get(f"/track/{token}", params={"v": contact["id"]})
    assert r.status_code == 200
    assert r.json()["latitude"] == 22.57

    status = client.get("/alert/status", headers=headers).json()
    assert status["viewed"] is True
    assert status["viewed_by"] == "Riya"

    r = client.post("/alert/stop", headers=headers)
    assert r.status_code == 200
    assert client.get("/alert/status", headers=headers).json()["active"] is False


def test_stranger_cannot_mark_alert_as_seen(client, user, other_user, sent_emails):
    _, headers_a = user
    _, headers_b = other_user
    _add_contact(client, headers_a)
    stranger_contact = _add_contact(client, headers_b, name="Stranger")
    client.post("/location", headers=headers_a, json={"latitude": 22.57, "longitude": 88.36})
    token = client.post("/alert/start", headers=headers_a).json()["share_token"]

    client.get(f"/track/{token}", params={"v": stranger_contact["id"]})

    assert client.get("/alert/status", headers=headers_a).json()["viewed"] is False


def test_invalid_tracking_token(client):
    r = client.get("/track/this-token-does-not-exist")
    assert r.status_code == 404


# ---------- Walk With Me ----------

def test_walk_start_arrive(client, user):
    _, headers = user
    r = client.post("/walk/start", headers=headers, json={"destination": "Hostel", "minutes": 20})
    assert r.status_code == 200, r.text

    status = client.get("/walk/status", headers=headers).json()
    assert status["status"] == "active"
    assert status["destination"] == "Hostel"
    assert 0 < status["seconds_left"] <= 20 * 60

    r = client.post("/walk/arrived", headers=headers)
    assert r.status_code == 200
    assert client.get("/walk/status", headers=headers).json()["status"] == "arrived"


def test_walk_extend(client, user):
    _, headers = user
    client.post("/walk/start", headers=headers, json={"destination": "Home", "minutes": 5})
    before = client.get("/walk/status", headers=headers).json()["seconds_left"]

    r = client.post("/walk/extend", headers=headers, json={"minutes": 10})
    assert r.status_code == 200
    after = client.get("/walk/status", headers=headers).json()["seconds_left"]
    assert after > before + 9 * 60


def test_walk_rejects_bad_input(client, user):
    _, headers = user
    assert client.post("/walk/start", headers=headers, json={"destination": "Home", "minutes": 0}).status_code == 400
    assert client.post("/walk/start", headers=headers, json={"destination": "Home", "minutes": 500}).status_code == 400
    assert client.post("/walk/start", headers=headers, json={"destination": "", "minutes": 10}).status_code == 400


def test_arriving_without_a_walk_is_404(client, user):
    _, headers = user
    assert client.post("/walk/arrived", headers=headers).status_code == 404


def test_overdue_check_requires_secret_key(client):
    r = client.get("/walk/check-overdue", params={"key": "wrong-key"})
    assert r.status_code == 403


# ---------- Mira (no Gemini calls are made in these tests) ----------

def test_chat_rejects_empty_message(client, user):
    _, headers = user
    r = client.post("/chat", headers=headers, json={"message": "   "})
    assert r.status_code == 400


def test_chat_rejects_too_long_message(client, user):
    _, headers = user
    r = client.post("/chat", headers=headers, json={"message": "a" * 501})
    assert r.status_code == 400


def test_spoken_reply_cleanup():
    assert main.clean_spoken_reply("**Haha** okay 😂") == "Haha okay"
    assert "AI" not in main.clean_spoken_reply("As an AI, I'm fine")
    assert main.clean_spoken_reply("") == "Hmm, sorry, say that again?"


# ---------- input validation for map endpoints (no map calls made) ----------

def test_nearby_rejects_unknown_place(client, user):
    _, headers = user
    r = client.get("/nearby", headers=headers, params={"place": "casino", "lat": 22.5, "lon": 88.3})
    assert r.status_code == 422


def test_area_safety_rejects_bad_coordinates(client):
    r = client.get("/area-safety", params={"lat": 200, "lon": 88.3})
    assert r.status_code == 422
