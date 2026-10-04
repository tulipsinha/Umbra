"""Shared setup for Umbra backend tests.

These tests talk to the database in DATABASE_URL. They create throwaway
users with random names and delete them (and everything they own) at the
end, using the app's own account-deletion endpoint.

Emails are never sent: send_alert_emails is replaced with a fake that
just records the call.
"""

import os
import sys
import uuid

import pytest

# Make "import main" work when running pytest from the backend/ folder
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL is not set; run `source ../env.sh` first", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

PASSWORD = "Test-password-123!"


@pytest.fixture(scope="session")
def client():
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def sent_emails(monkeypatch):
    """Replace real email sending with a recorder."""
    calls = []

    def fake_send(*args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr(main, "send_alert_emails", fake_send)
    return calls


def _make_user(client):
    username = "pytest_" + uuid.uuid4().hex[:10]
    r = client.post("/register", json={"username": username, "password": PASSWORD})
    assert r.status_code in (200, 201), r.text
    r = client.post("/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    return username, {"Authorization": f"Bearer {token}"}


@pytest.fixture
def user(client):
    """A fresh logged-in user, deleted after the test."""
    username, headers = _make_user(client)
    yield username, headers
    client.post("/alert/stop", headers=headers)
    client.post("/account/delete", headers=headers, json={"password": PASSWORD})


@pytest.fixture
def other_user(client):
    """A second user, for checking that users can't see each other's data."""
    username, headers = _make_user(client)
    yield username, headers
    client.post("/account/delete", headers=headers, json={"password": PASSWORD})
