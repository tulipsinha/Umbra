let alertWatchTimer = null;
let alertWatchLastViewed = false;

function renderHelpStatus(data) {
  const card = document.querySelector(".help-status-card");
  const message = document.getElementById("help-status-message");
  if (!card || !message) return;

  card.classList.remove("active", "help-confirmed");

  if (!data || !data.active) {
    message.textContent =
      "Start an SOS alert to share your live location and see when a contact opens the link.";
    alertWatchLastViewed = false;
    return;
  }

  card.classList.add("active");

  if (data.viewed) {
    card.classList.add("help-confirmed");
    const name = data.viewed_by || "An emergency contact";
    message.textContent = `${name} opened your live tracking link. Help is on the way.`;
  } else {
    message.textContent =
      "Your SOS alert is active. Waiting for a trusted contact to open your live tracking link.";
  }
}

function startAlertWatch(getToken) {
  if (typeof getToken !== "function") return;

  stopAlertWatch();

  const pollStatus = async () => {
    try {
      const token = getToken();
      if (!token) return;

      const base = typeof API_BASE !== "undefined"
        ? API_BASE
        : "https://umbra-api-1o94.onrender.com";

      const response = await fetch(`${base}/alert/status`, {
        headers: {
          Authorization: `Bearer ${token}` ,
        }
      });

      if (!response.ok) {
        handleExpiredSession(response);
        return;
      }

      const data = await response.json();
      renderHelpStatus(data);
      if (!data || !data.active || !data.viewed) return;

      if (!alertWatchLastViewed && typeof speakAsMira === "function") {
        const name = data.viewed_by || "An emergency contact";
        speakAsMira(`Good news, ${name} has opened your live location link. Help is on the way.`);
      }

      alertWatchLastViewed = true;
    } catch (error) {
      console.warn("Alert watch failed:", error);
    }
  };

  pollStatus();
  alertWatchTimer = setInterval(pollStatus, 5000);
}

function stopAlertWatch() {
  if (alertWatchTimer) {
    clearInterval(alertWatchTimer);
    alertWatchTimer = null;
  }
  alertWatchLastViewed = false;
}
