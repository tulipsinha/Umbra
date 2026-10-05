let alertWatchTimer = null;
let alertWatchLastViewed = false;

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
      if (!data || !data.viewed) return;

      if (!alertWatchLastViewed && typeof speakAsMira === "function") {
        const name = data.viewed_by || "someone";
        speakAsMira(`Oh wait, ${name} just messaged me. They're on their way to you, okay?`);
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
