let walkPollingTimer = null;

function stopWalkPolling() {
  if (walkPollingTimer) {
    clearInterval(walkPollingTimer);
    walkPollingTimer = null;
  }
}

function startWalkPolling(getToken, onUpdate) {
  if (typeof getToken !== "function") return;

  const base = typeof API_BASE !== "undefined"
    ? API_BASE
    : "https://umbra-api-1o94.onrender.com";

  const poll = async () => {
    try {
      const token = getToken();
      if (!token) return;

      const response = await fetch(`${base}/walk/status`, {
        headers: {
          Authorization: `Bearer ${token}` ,
        }
      });

      if (!response.ok) {
        handleExpiredSession(response);
        return;
      }

      const data = await response.json();
      const secondsLeft = Math.max(0, Number(data.seconds_left || 0));

      if (data.status === "active") {
        onUpdate({ status: "active", destination: data.destination, seconds_left: secondsLeft });
      } else if (data.status === "arrived") {
        onUpdate({ status: "arrived", destination: data.destination, seconds_left: 0 });
        stopWalkPolling();
      } else if (data.status === "alerted") {
        onUpdate({ status: "alerted", destination: data.destination, seconds_left: 0 });
        if (typeof startAlertWatch === "function") startAlertWatch(getToken);
        stopWalkPolling();
      } else {
        onUpdate({ status: "none" });
        stopWalkPolling();
      }
    } catch (error) {
      console.warn("Walk status check failed:", error);
    }
  };

  stopWalkPolling();
  walkPollingTimer = setInterval(poll, 5000);
  poll();
}

async function startWalk(getToken, destination, minutes, onUpdate) {
  if (typeof getToken !== "function") {
    throw new Error("Authentication required");
  }

  const cleanDestination = String(destination || "").trim();
  const cleanMinutes = Number(minutes);

  if (!cleanDestination) {
    throw new Error("Please enter a destination");
  }

  if (!Number.isFinite(cleanMinutes) || cleanMinutes < 1 || cleanMinutes > 180) {
    throw new Error("Minutes must be between 1 and 180");
  }

  const base = typeof API_BASE !== "undefined"
    ? API_BASE
    : "https://umbra-api-1o94.onrender.com";

  const token = getToken();
  const response = await fetch(`${base}/walk/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}` ,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ destination: cleanDestination, minutes: cleanMinutes })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    handleExpiredSession(response);
    throw new Error(data.detail || data.message || "Could not start walk");
  }

  if (typeof onUpdate === "function") {
    onUpdate({ status: "active", destination: cleanDestination, seconds_left: cleanMinutes * 60 });
  }

  startWalkPolling(getToken, onUpdate || (() => {}));

  if (typeof sendCurrentLocation === "function") {
    sendCurrentLocation();
  }

  return data;
}

async function walkArrived(getToken) {
  if (typeof getToken !== "function") {
    throw new Error("Authentication required");
  }

  const token = getToken();
  const base = typeof API_BASE !== "undefined"
    ? API_BASE
    : "https://umbra-api-1o94.onrender.com";

  const response = await fetch(`${base}/walk/arrived`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}` ,
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    handleExpiredSession(response);
    throw new Error(data.detail || data.message || "Could not mark arrival");
  }

  stopWalkPolling();
  return data;
}

async function walkExtend(getToken, minutes) {
  if (typeof getToken !== "function") {
    throw new Error("Authentication required");
  }

  const cleanMinutes = Number(minutes);
  if (!Number.isFinite(cleanMinutes) || cleanMinutes < 1 || cleanMinutes > 60) {
    throw new Error("You can extend by 1 to 60 minutes");
  }

  const token = getToken();
  const base = typeof API_BASE !== "undefined"
    ? API_BASE
    : "https://umbra-api-1o94.onrender.com";

  const response = await fetch(`${base}/walk/extend`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}` ,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ minutes: cleanMinutes })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    handleExpiredSession(response);
    throw new Error(data.detail || data.message || "Could not extend walk");
  }

  return data;
}
