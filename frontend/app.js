/**
 * Mira — Frontend Client Application
 * Clean Vanilla JS Architecture connected to FastAPI backend
 */

const API_BASE = "https://umbra-api-1o94.onrender.com";

// ============================================================================
// APPLICATION STATE
// ============================================================================
const state = {
  token:
    localStorage.getItem("mira_token") ||
    null,
  username:
    localStorage.getItem("mira_user") ||
    null,
  activeScreen: "auth",

  isAlertActive: false,
  alertShareToken: null,
  alertStartTime: null,
  alertTimerInterval: null,
  locationInterval: null,
  walkDestination: "",

  // Audio recording state
  audioMediaRecorder: null,
  audioStream: null,
  audioChunkTimerInterval: null,
  audioChunkTimeout: null,
  audioChunkStartedAt: null,
  audioChunkDurationMs: 0,

  // Audio diagnostics
  audioContext: null,
  audioAnalyser: null,
  audioLevelInterval: null,
  audioCaptureStatus: "idle",

  wakeLock: null,

  // Safe-word triggers
  startTrigger: "did you feed the cat",
  stopTrigger: "okay talk later",

  // Voice Guardian
  isGuardianActive: false,
  speechRecognizer: null,
  recognitionRetryCount: 0
};

// ============================================================================
// API CLIENT UTILITY
// ============================================================================
async function api(path, options = {}) {
  const headers = { ...options.headers };

  if (state.token && !headers["Authorization"]) {
    headers["Authorization"] = `Bearer ${state.token}`;
  }

  if (
    options.body &&
    typeof options.body === "object" &&
    !(options.body instanceof FormData)
  ) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }

  options.headers = headers;

  try {
    const response = await fetch(`${API_BASE}${path}`, options);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const isLoginRequest = path === "/login" || path === "/register";

      if (handleExpiredSession(response, isLoginRequest)) {
        throw new Error("Session expired, please log in again");
      }

      const errorMsg =
        data.detail ||
        data.message ||
        `Request failed (${response.status})`;

      throw new Error(errorMsg);
    }

    return data;
  } catch (err) {
    console.error(`API Error [${path}]:`, err);
    throw err;
  }
}

function handleExpiredSession(response, isLoginRequest = false) {
  if (
    !isLoginRequest &&
    state.token &&
    (response.status === 401 || response.status === 403)
  ) {
    showLoginScreen();
    return true;
  }

  return false;
}

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const icon =
    type === "error"
      ? "⚠️"
      : type === "success"
        ? "✅"
        : "ℹ️";

  toast.innerHTML =
    `<span>${icon}</span><span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-8px)";

    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// NAVIGATION & ROUTING
// ============================================================================
function navigateTo(screenId) {
  if (!state.token && screenId !== "auth") {
    screenId = "auth";
  }

  document
    .querySelectorAll(".screen")
    .forEach(s => s.classList.remove("active"));

  const target = document.getElementById(`screen-${screenId}`);

  if (target) {
    target.classList.add("active");
    state.activeScreen = screenId;
  }

  document
    .querySelectorAll(".nav-item")
    .forEach(item => item.classList.remove("active"));

  const activeNav = document.getElementById(`nav-${screenId}`);

  if (activeNav) {
    activeNav.classList.add("active");
  }

  if (screenId === "chat") loadChatHistory();
  if (screenId === "contacts") loadContacts();
  if (screenId === "nearby") loadNearby("hospital");
  if (screenId === "recordings") loadRecordings();
  if (screenId === "settings") loadSettings();
}

// ============================================================================
// AUTHENTICATION LOGIC
// ============================================================================
let currentAuthTab = "login";

function switchAuthTab(tab) {
  currentAuthTab = tab;

  document
    .getElementById("tab-login")
    .classList.toggle("active", tab === "login");

  document
    .getElementById("tab-register")
    .classList.toggle("active", tab === "register");

  document.getElementById("auth-btn-text").textContent =
    tab === "login" ? "Log In" : "Create Account";
}

async function handleAuthSubmit(e) {
  e.preventDefault();

  const username =
    document.getElementById("auth-username").value.trim().toLowerCase();

  const password =
    document.getElementById("auth-password").value;

  const submitBtn =
    document.getElementById("auth-submit-btn");

  if (!username || !password) {
    showToast(
      "Please provide both username and password",
      "error"
    );
    return;
  }

  submitBtn.disabled = true;
  submitBtn.style.opacity = "0.7";

  try {
    if (currentAuthTab === "register") {
      await api("/register", {
        method: "POST",
        body: {
          username,
          password
        }
      });

      showToast(
        "Account created successfully! Logging you in...",
        "success"
      );
    }

    const res = await api("/login", {
      method: "POST",
      body: {
        username,
        password
      }
    });

    state.token = res.token;
    state.username = username;

    localStorage.setItem("mira_token", res.token);
    localStorage.setItem("mira_user", username);

    showToast(
      `Welcome back, ${username}!`,
      "success"
    );

    onLoginSuccess();

  } catch (err) {
    showToast(err.message, "error");

  } finally {
    submitBtn.disabled = false;
    submitBtn.style.opacity = "1";
  }
}

function onLoginSuccess() {
  document.getElementById("bottom-nav").style.display = "flex";

  document.getElementById(
    "current-user-display"
  ).textContent = state.username;

  loadTriggers();
  loadContacts();

  if (typeof startWalkPolling === "function") {
    startWalkPolling(() => state.token, updateWalkUI);
  }
  if (typeof startAlertWatch === "function") {
    startAlertWatch(() => state.token);
  }

  navigateTo("home");
}

function formatWalkTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = String(safeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function updateWalkUI(walk) {
  const panel = document.getElementById("walk-status-panel");
  const title = document.getElementById("walk-status-title");
  const message = document.getElementById("walk-status-message");
  const actions = document.getElementById("walk-actions");
  if (!panel || !title || !message || !actions) return;

  if (!walk || walk.status === "none") {
    panel.hidden = true;
    actions.hidden = true;
    state.walkDestination = "";
    return;
  }

  state.walkDestination = walk.destination || state.walkDestination;
  panel.hidden = false;
  actions.hidden = walk.status !== "active";

  if (walk.status === "active") {
    title.textContent = "Your walk is being monitored";
    message.textContent =
      `Check in at ${state.walkDestination} in ${formatWalkTime(walk.seconds_left)}.`;
  } else if (walk.status === "arrived") {
    title.textContent = "Arrival confirmed";
    message.textContent = state.walkDestination
      ? `Glad you made it safely to ${state.walkDestination}.`
      : "Glad you made it safely.";
  } else if (walk.status === "alerted") {
    title.textContent = "Check-in time passed";
    message.textContent =
      `Your expected arrival at ${state.walkDestination || "your destination"} has passed. Emergency contacts have been alerted.`;
  } else {
    panel.hidden = true;
    actions.hidden = true;
  }
}

async function startWalkFromDashboard(event) {
  event.preventDefault();

  const form = document.getElementById("walk-form");
  const submitButton = document.getElementById("walk-start-btn");
  const destination = document.getElementById("walk-destination").value;
  const minutes = document.getElementById("walk-minutes").value;
  if (!form || !submitButton) return;

  submitButton.disabled = true;
  try {
    await startWalk(
      () => state.token,
      destination,
      minutes,
      updateWalkUI
    );
    showToast("Walk With Me is active. Check in when you arrive.", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
}

async function markWalkArrived() {
  try {
    await walkArrived(() => state.token);
    updateWalkUI({ status: "arrived", destination: state.walkDestination });
    showToast("Arrival confirmed. Glad you made it safely.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function extendWalkTimer() {
  try {
    await walkExtend(() => state.token, 10);
    showToast("Your check-in timer was extended by 10 minutes.", "success");
    startWalkPolling(() => state.token, updateWalkUI);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function showLoginScreen() {
  state.token = null;
  state.username = null;

  if (typeof stopWalkPolling === "function") {
    stopWalkPolling();
  }
  if (typeof stopAlertWatch === "function") {
    stopAlertWatch();
  }

  localStorage.removeItem("mira_token");
  localStorage.removeItem("mira_user");

  if (document.getElementById("bottom-nav")) {
    document.getElementById("bottom-nav").style.display = "none";
  }

  navigateTo("auth");
  showToast("Session expired, please log in again", "error");
}

function handleLogout() {
  state.token = null;
  state.username = null;

  if (typeof stopWalkPolling === "function") {
    stopWalkPolling();
  }
  if (typeof stopAlertWatch === "function") {
    stopAlertWatch();
  }

  localStorage.removeItem("mira_token");
  localStorage.removeItem("mira_user");

  if (state.isAlertActive) {
    stopAlert();
  }

  if (state.isGuardianActive) {
    toggleVoiceGuardian();
  }

  document.getElementById("bottom-nav").style.display = "none";

  navigateTo("auth");

  showToast(
    "Logged out safely",
    "info"
  );
}

function toggleForgotPass(e) {
  e.preventDefault();

  const panel =
    document.getElementById("forgot-panel");

  panel.style.display =
    panel.style.display === "none"
      ? "block"
      : "none";
}

async function handleResetPassword() {
  const username =
    document.getElementById("auth-username").value
      .trim()
      .toLowerCase();

  const code =
    document.getElementById("reset-code").value.trim();

  const newPassword =
    document.getElementById("reset-new-pass").value;

  if (!username || !code || !newPassword) {
    showToast(
      "Please fill in username, recovery code, and new password",
      "error"
    );
    return;
  }

  try {
    await api("/password/reset", {
      method: "POST",
      body: {
        username,
        recovery_code: code,
        new_password: newPassword
      }
    });

    showToast(
      "Password reset successfully! You can now log in.",
      "success"
    );

    document.getElementById(
      "forgot-panel"
    ).style.display = "none";

  } catch (err) {
    showToast(err.message, "error");
  }
}

// ============================================================================
// EMERGENCY SOS ALERT SYSTEM
// ============================================================================
async function toggleAlert() {
  if (state.isAlertActive) {
    await stopAlert();
  } else {
    await startAlert();
  }
}

async function startAlert() {
  if (state.isAlertActive) return;

  try {
    showToast(
      "🚨 Initiating Emergency Alert...",
      "error"
    );

    const res = await api(
      "/alert/start",
      { method: "POST" }
    );

    state.isAlertActive = true;
    state.alertShareToken = res.share_token;
    state.alertStartTime = Date.now();

    if (typeof startAlertWatch === "function") {
      startAlertWatch(() => state.token);
    }

    updateAlertUI(true);

    const trackUrl =
      `${window.location.origin}/frontend/track.html?token=${res.share_token}`;

    document.getElementById(
      "share-link-input"
    ).value = trackUrl;

    if ("wakeLock" in navigator) {
      try {
        state.wakeLock =
          await navigator.wakeLock.request("screen");
      } catch (e) {
        console.warn(
          "Wake lock unavailable:",
          e
        );
      }
    }

    sendCurrentLocation();

    state.locationInterval =
      setInterval(
        sendCurrentLocation,
        5000
      );

    // Start microphone recording.
    // We await this so the user gets immediate feedback
    // about microphone permission/capture.
    await startAudioRecordingLoop();

    startAlertTimer();

    showToast(
      state.audioCaptureStatus === "recording"
        ? "Beacon active! GPS & Audio evidence recording is ON."
        : "Beacon active! GPS is streaming. Audio recording could not start.",
      state.audioCaptureStatus === "recording"
        ? "success"
        : "error"
    );

  } catch (err) {
    showToast(
      `Failed to start alert: ${err.message}`,
      "error"
    );
  }
}

async function stopAlert() {
  if (!state.isAlertActive) return;

  // Tell backend to stop the emergency alert.
  try {
    await api(
      "/alert/stop",
      { method: "POST" }
    );
  } catch (e) {
    console.warn(
      "Stop alert API error:",
      e
    );
  }

  // IMPORTANT:
  // Change this before stopping the recorder.
  // This prevents the recorder from automatically
  // starting another 10-second clip.
  state.isAlertActive = false;
  state.alertShareToken = null;

  if (typeof stopAlertWatch === "function") {
    stopAlertWatch();
  }

  clearInterval(state.locationInterval);
  clearInterval(state.alertTimerInterval);

  state.locationInterval = null;
  state.alertTimerInterval = null;

  // Finish and upload the current audio clip.
  await stopAudioRecordingLoop(true);

  if (state.wakeLock) {
    state.wakeLock
      .release()
      .catch(() => { });

    state.wakeLock = null;
  }

  updateAlertUI(false);

  // Refresh evidence after the final clip has uploaded.
  if (state.token) {
    await loadRecordings(true).catch(err =>
      console.warn(
        "Could not refresh recordings:",
        err
      )
    );
  }

  showToast(
    "Emergency alert deactivated. Audio evidence has been saved.",
    "success"
  );
}

function updateAlertUI(isActive) {
  const mainBtn =
    document.getElementById("sos-main-btn");

  const banner =
    document.getElementById("status-banner");

  const statusTitle =
    document.getElementById("status-title");

  const statusSub =
    document.getElementById("status-subtitle");

  const linkCard =
    document.getElementById("active-link-card");

  const timer =
    document.getElementById("alert-timer");

  const audioTimer =
    document.getElementById("audio-chunk-timer");

  const btnLabel =
    document.getElementById("sos-btn-label");

  const btnSub =
    document.getElementById("sos-btn-sub");

  const btnIcon =
    document.getElementById("sos-btn-icon");

  if (isActive) {

    mainBtn?.classList.add("active-alert");
    banner?.classList.add("alert-active");
    linkCard?.classList.add("visible");

    if (timer) {
      timer.style.display = "block";
    }

    if (audioTimer) {
      audioTimer.style.display = "block";
      audioTimer.textContent =
        "🎙️ Starting microphone…";
    }

    if (btnLabel) {
      btnLabel.textContent = "STOP ALERT";
    }

    if (btnSub) {
      btnSub.textContent = "Tap when safe";
    }

    if (btnIcon) {
      btnIcon.textContent = "⏹️";
    }

    if (statusTitle) {
      statusTitle.textContent =
        "🚨 EMERGENCY BEACON ACTIVE";
    }

    if (statusSub) {
      statusSub.textContent =
        "Contacts alerted • Live GPS & Audio evidence";
    }

  } else {

    mainBtn?.classList.remove("active-alert");
    banner?.classList.remove("alert-active");
    linkCard?.classList.remove("visible");

    if (timer) {
      timer.style.display = "none";
    }

    if (audioTimer) {
      audioTimer.style.display = "none";
    }

    if (btnLabel) {
      btnLabel.textContent = "START ALERT";
    }

    if (btnSub) {
      btnSub.textContent = "Tap in danger";
    }

    if (btnIcon) {
      btnIcon.textContent = "🚨";
    }

    if (statusTitle) {
      statusTitle.textContent =
        "System Guard Active";
    }

    if (statusSub) {
      statusSub.textContent =
        "Ready to activate beacon anytime";
    }

    // IMPORTANT:
    // Evidence card is NEVER removed after stopping an alert.
    const recordingsCard =
      document.getElementById(
        "recordings-evidence-card"
      );

    if (recordingsCard) {
      recordingsCard.style.display = "block";
    }
  }
}

function startAlertTimer() {
  const timerEl =
    document.getElementById("alert-timer");

  if (!timerEl) return;

  // Immediately show 00:00.
  timerEl.textContent = "00:00";

  state.alertTimerInterval =
    setInterval(() => {

      if (!state.alertStartTime) return;

      const elapsedSec =
        Math.floor(
          (Date.now() - state.alertStartTime) / 1000
        );

      const mins =
        String(
          Math.floor(elapsedSec / 60)
        ).padStart(2, "0");

      const secs =
        String(
          elapsedSec % 60
        ).padStart(2, "0");

      timerEl.textContent =
        `${mins}:${secs}`;

    }, 1000);
}

// ============================================================================
// GEOLOCATION SENDER
// ============================================================================
function sendCurrentLocation() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {

      const {
        latitude,
        longitude
      } = pos.coords;

      const statusPill =
        document.getElementById(
          "gps-status-pill"
        );

      if (statusPill) {
        statusPill.textContent =
          `GPS: ±${Math.round(pos.coords.accuracy)}m`;
      }

      try {
        await api("/location", {
          method: "POST",
          body: {
            latitude,
            longitude
          }
        });
      } catch (err) {
        console.warn(
          "Location sync failed:",
          err
        );
      }
    },

    (err) => {

      console.warn(
        "Geolocation error:",
        err.message
      );

      const statusPill =
        document.getElementById(
          "gps-status-pill"
        );

      if (statusPill) {
        statusPill.textContent =
          "GPS: Permission denied";
      }
    },

    {
      enableHighAccuracy: true,
      timeout: 5000,
      maximumAge: 0
    }
  );
}

// ============================================================================
// AUDIO RECORDING — REAL 10 SECOND ROLLING CLIPS
// ============================================================================

const AUDIO_CHUNK_MS = 10000;

/*
 * Select a browser-supported audio format.
 *
 * Chrome / Edge on Windows normally support WebM + Opus.
 * We deliberately prefer Opus because it is a proper
 * microphone audio codec and generally works well in browsers.
 */
function chooseAudioFormat() {

  const candidates = [
    {
      mime: "audio/webm;codecs=opus",
      ext: ".webm"
    },
    {
      mime: "audio/webm",
      ext: ".webm"
    },
    {
      mime: "audio/ogg;codecs=opus",
      ext: ".ogg"
    },
    {
      mime: "audio/mp4",
      ext: ".mp4"
    }
  ];

  for (const candidate of candidates) {
    try {
      if (
        window.MediaRecorder &&
        MediaRecorder.isTypeSupported(candidate.mime)
      ) {
        return candidate;
      }
    } catch (_) { }
  }

  return null;
}

// --------------------------------------------------------------------------
// Audio timer cleanup
// --------------------------------------------------------------------------
function clearAudioChunkTimers() {

  if (state.audioChunkTimeout) {
    clearTimeout(
      state.audioChunkTimeout
    );

    state.audioChunkTimeout = null;
  }

  if (state.audioChunkTimerInterval) {
    clearInterval(
      state.audioChunkTimerInterval
    );

    state.audioChunkTimerInterval = null;
  }
}

// --------------------------------------------------------------------------
// Visible 10-second countdown
// --------------------------------------------------------------------------
function updateAudioChunkTimer() {

  const timer =
    document.getElementById(
      "audio-chunk-timer"
    );

  if (!timer) return;

  if (!state.audioChunkStartedAt) {
    timer.textContent =
      state.audioCaptureStatus === "recording"
        ? "🎙️ Mic LIVE"
        : "🎙️ Microphone inactive";
    return;
  }

  const elapsed =
    Date.now() -
    state.audioChunkStartedAt;

  const remaining =
    Math.max(
      0,
      AUDIO_CHUNK_MS - elapsed
    );

  const sec =
    Math.ceil(
      remaining / 1000
    );

  timer.textContent =
    `🎙️ Recording clip • ${sec}s`;
}

// --------------------------------------------------------------------------
// Audio level monitor
//
// This does NOT modify the recording.
// It only checks whether the browser's microphone stream
// contains changing audio data.
//
// This helps us distinguish:
// 1. microphone unavailable
// 2. microphone connected but quiet
// 3. microphone actually receiving sound
// --------------------------------------------------------------------------
function startAudioLevelMonitor() {

  stopAudioLevelMonitor();

  if (!state.audioStream) return;

  try {

    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!AudioContextClass) {
      console.warn(
        "AudioContext unavailable; skipping microphone level monitor."
      );
      return;
    }

    const audioContext =
      new AudioContextClass();

    const analyser =
      audioContext.createAnalyser();

    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;

    const source =
      audioContext.createMediaStreamSource(
        state.audioStream
      );

    source.connect(analyser);

    state.audioContext =
      audioContext;

    state.audioAnalyser =
      analyser;

    const bufferLength =
      analyser.fftSize;

    const data =
      new Uint8Array(bufferLength);

    state.audioLevelInterval =
      setInterval(() => {

        if (
          !state.audioAnalyser ||
          !state.isAlertActive
        ) {
          return;
        }

        analyser.getByteTimeDomainData(
          data
        );

        let sum = 0;

        for (let i = 0; i < data.length; i++) {
          const normalized =
            (data[i] - 128) / 128;

          sum += normalized * normalized;
        }

        const rms =
          Math.sqrt(
            sum / data.length
          );

        const timer =
          document.getElementById(
            "audio-chunk-timer"
          );

        if (!timer) return;

        const remaining =
          Math.max(
            0,
            AUDIO_CHUNK_MS -
            (
              Date.now() -
              (state.audioChunkStartedAt || Date.now())
            )
          );

        const sec =
          Math.ceil(
            remaining / 1000
          );

        if (rms > 0.015) {
          timer.textContent =
            `🎙️ Mic LIVE • Sound detected • ${sec}s`;
        } else {
          timer.textContent =
            `🎙️ Mic LIVE • Quiet • ${sec}s`;
        }

      }, 250);

  } catch (err) {

    console.warn(
      "Could not start microphone level monitor:",
      err
    );
  }
}

function stopAudioLevelMonitor() {

  if (state.audioLevelInterval) {
    clearInterval(
      state.audioLevelInterval
    );

    state.audioLevelInterval = null;
  }

  if (state.audioContext) {

    try {
      state.audioContext.close();
    } catch (_) { }

    state.audioContext = null;
  }

  state.audioAnalyser = null;
}

// --------------------------------------------------------------------------
// Start microphone capture
// --------------------------------------------------------------------------
async function startAudioRecordingLoop() {

  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {

    state.audioCaptureStatus =
      "unsupported";

    showToast(
      "This browser cannot access the microphone.",
      "error"
    );

    return false;
  }

  if (!window.MediaRecorder) {

    state.audioCaptureStatus =
      "unsupported";

    showToast(
      "This browser cannot record microphone audio.",
      "error"
    );

    return false;
  }

  // Stop an old stream if something was left behind.
  await stopAudioRecordingLoop(false);

  try {

    /*
     * These constraints request an ordinary microphone stream.
     * We are NOT requesting video.
     */
    state.audioStream =
      await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });

    const tracks =
      state.audioStream.getAudioTracks();

    if (!tracks || tracks.length === 0) {
      throw new Error(
        "No microphone track was returned by the browser."
      );
    }

    const track =
      tracks[0];

    console.log(
      "Mira microphone track:",
      {
        label: track.label,
        readyState: track.readyState,
        enabled: track.enabled,
        muted: track.muted,
        settings: track.getSettings
          ? track.getSettings()
          : {}
      }
    );

    if (
      track.readyState !== "live" ||
      !track.enabled
    ) {
      throw new Error(
        "The microphone track is not live."
      );
    }

    state.audioCaptureStatus =
      "recording";

    const audioTimer =
      document.getElementById(
        "audio-chunk-timer"
      );

    if (audioTimer) {
      audioTimer.style.display = "block";
      audioTimer.textContent =
        "🎙️ Mic LIVE • preparing clip…";
    }

    showToast(
      "🎙️ Microphone connected. Audio evidence recording is ON.",
      "success"
    );

    // Start the diagnostic level monitor.
    startAudioLevelMonitor();

    // Start first 10-second recording.
    recordSingleAudioSlice();

    return true;

  } catch (err) {

    state.audioCaptureStatus =
      "error";

    console.error(
      "Microphone capture failed:",
      err
    );

    let message =
      "Could not start microphone recording.";

    if (err.name === "NotAllowedError") {
      message =
        "Microphone permission was denied. Allow microphone access and try again.";
    } else if (err.name === "NotFoundError") {
      message =
        "No microphone was found on this device.";
    } else if (err.name === "NotReadableError") {
      message =
        "The microphone is being used by another application.";
    } else if (err.message) {
      message =
        err.message;
    }

    showToast(
      message,
      "error"
    );

    return false;
  }
}

// --------------------------------------------------------------------------
// Record ONE 10-second clip
// --------------------------------------------------------------------------
function recordSingleAudioSlice() {

  if (!state.isAlertActive) {
    return;
  }

  if (!state.audioStream) {
    console.warn(
      "Cannot record audio: microphone stream is missing."
    );
    return;
  }

  const format =
    chooseAudioFormat();

  if (!format) {

    state.audioCaptureStatus =
      "unsupported";

    console.error(
      "No supported MediaRecorder format found."
    );

    showToast(
      "Your browser does not support a compatible audio recording format.",
      "error"
    );

    return;
  }

  console.log(
    "Mira audio format:",
    format.mime
  );

  try {

    const recorder =
      new MediaRecorder(
        state.audioStream,
        {
          mimeType: format.mime,
          audioBitsPerSecond: 128000
        }
      );

    const chunks = [];

    let clipStartTime =
      Date.now();

    state.audioMediaRecorder =
      recorder;

    state.audioChunkStartedAt =
      clipStartTime;

    state.audioChunkDurationMs =
      0;

    clearAudioChunkTimers();

    updateAudioChunkTimer();

    state.audioChunkTimerInterval =
      setInterval(
        updateAudioChunkTimer,
        200
      );

    recorder.onstart =
      () => {

        console.log(
          "Audio clip started:",
          format.mime
        );

        updateAudioChunkTimer();
      };

    recorder.ondataavailable =
      (event) => {

        if (
          event.data &&
          event.data.size > 0
        ) {

          chunks.push(
            event.data
          );

          console.log(
            "Audio data received:",
            event.data.size,
            "bytes"
          );
        }
      };

    recorder.onerror =
      (event) => {

        console.error(
          "MediaRecorder error:",
          event.error || event
        );

        clearAudioChunkTimers();

        state.audioCaptureStatus =
          "error";

        const timer =
          document.getElementById(
            "audio-chunk-timer"
          );

        if (timer && state.isAlertActive) {
          timer.textContent =
            "⚠️ Audio recorder error";
        }
      };

    recorder.onstop =
      async () => {

        clearAudioChunkTimers();

        const actualDurationMs =
          Math.max(
            0,
            Date.now() -
            clipStartTime
          );

        state.audioChunkDurationMs =
          actualDurationMs;

        state.audioChunkStartedAt =
          null;

        /*
         * Build the actual audio file.
         */
        if (chunks.length > 0) {

          const blob =
            new Blob(
              chunks,
              {
                type: format.mime
              }
            );

          console.log(
            "Completed audio clip:",
            {
              type: blob.type,
              size: blob.size,
              durationMs: actualDurationMs
            }
          );

          /*
           * A healthy 10-second microphone recording should
           * normally be larger than a few hundred bytes.
           *
           * Do not upload an obviously empty blob.
           */
          if (blob.size < 1000) {

            console.warn(
              "Audio blob is extremely small and may be empty:",
              blob.size
            );

            showToast(
              "The microphone produced an empty/very small audio clip.",
              "error"
            );

          } else {

            const formData =
              new FormData();

            formData.append(
              "file",
              blob,
              `alert_audio_${Date.now()}${format.ext}`
            );

            try {

              await api(
                "/audio",
                {
                  method: "POST",
                  body: formData
                }
              );

              console.log(
                "Audio clip uploaded successfully."
              );

            } catch (uploadErr) {

              console.error(
                "Audio clip upload failed:",
                uploadErr
              );

              showToast(
                `Audio upload failed: ${uploadErr.message}`,
                "error"
              );
            }
          }

        } else {

          console.warn(
            "MediaRecorder stopped without producing any data."
          );

          showToast(
            "No audio data was produced by the microphone.",
            "error"
          );
        }

        state.audioMediaRecorder =
          null;

        /*
         * Start the NEXT 10-second clip only if
         * the alert is still active.
         *
         * When STOP is pressed, isAlertActive is already
         * false, so this will NOT start another clip.
         */
        if (
          state.isAlertActive &&
          state.audioStream
        ) {

          recordSingleAudioSlice();

        } else {

          state.audioMediaRecorder =
            null;
        }
      };

    /*
     * Timeslice makes MediaRecorder emit data periodically.
     * The clip itself is still stopped after 10 seconds.
     */
    recorder.start(250);

    /*
     * EXACT 10-second target.
     */
    state.audioChunkTimeout =
      setTimeout(() => {

        if (
          recorder.state === "recording"
        ) {

          console.log(
            "10-second audio clip complete."
          );

          recorder.stop();
        }

      }, AUDIO_CHUNK_MS);

  } catch (err) {

    console.error(
      "MediaRecorder could not be created:",
      err
    );

    state.audioCaptureStatus =
      "error";

    showToast(
      "Could not start the audio recorder.",
      "error"
    );
  }
}

// --------------------------------------------------------------------------
// Stop microphone recording
// --------------------------------------------------------------------------
async function stopAudioRecordingLoop(
  flushCurrent = false
) {

  clearAudioChunkTimers();
  stopAudioLevelMonitor();

  const recorder =
    state.audioMediaRecorder;

  /*
   * Remove the reference immediately so that
   * nothing accidentally starts another clip.
   */
  state.audioMediaRecorder =
    null;

  if (
    recorder &&
    recorder.state === "recording"
  ) {

    try {

      /*
       * recorder.stop() triggers onstop().
       * onstop uploads the final partial clip.
       */
      recorder.stop();

      if (flushCurrent) {

        /*
         * Give the onstop handler enough time to
         * create and upload the final clip.
         */
        await new Promise(resolve => {

          const started =
            Date.now();

          const waitForUpload = () => {

            if (
              Date.now() - started > 5000
            ) {
              resolve();
              return;
            }

            /*
             * The upload handler sets audioMediaRecorder
             * to null before finishing the cycle.
             */
            if (
              !state.isAlertActive
            ) {
              resolve();
              return;
            }

            setTimeout(
              waitForUpload,
              50
            );
          };

          waitForUpload();
        });
      }

    } catch (err) {

      console.warn(
        "Could not stop MediaRecorder cleanly:",
        err
      );
    }
  }

  /*
   * Only release the microphone AFTER recorder.stop().
   */
  if (state.audioStream) {

    state.audioStream
      .getTracks()
      .forEach(track => {

        try {
          track.stop();
        } catch (_) { }

      });

    state.audioStream =
      null;
  }

  state.audioCaptureStatus =
    "idle";

  state.audioChunkStartedAt =
    null;

  state.audioChunkDurationMs =
    0;

  const timer =
    document.getElementById(
      "audio-chunk-timer"
    );

  if (timer) {
    timer.textContent =
      "🎙️ Audio recording stopped";
  }
}

// ============================================================================
// AUDIO EVIDENCE PLAYBACK
// ============================================================================

async function loadRecordingAudio(button) {

  const card =
    button?.closest(
      ".audio-recording-card"
    );

  const audio =
    card?.querySelector("audio");

  const audioId =
    button?.dataset?.audioId;

  if (!audio || !audioId) {
    return;
  }

  /*
   * If the file has already been downloaded,
   * simply use the native player.
   */
  if (
    audio.dataset.loaded === "true"
  ) {

    try {

      await audio.play();

    } catch (err) {

      console.warn(
        "Audio playback failed:",
        err
      );

      showToast(
        "Press the play button on the audio player to listen.",
        "info"
      );
    }

    return;
  }

  const originalText =
    button.textContent;

  button.disabled = true;
  button.textContent =
    "Loading…";

  try {

    /*
     * IMPORTANT:
     *
     * /audio/{id} requires the user's Bearer token.
     *
     * <audio src="..."> cannot add an Authorization header.
     *
     * So we fetch the protected file ourselves,
     * turn it into a Blob URL,
     * and give that Blob URL to the audio player.
     */
    const response =
      await fetch(
        `${API_BASE}/audio/${encodeURIComponent(audioId)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${state.token}` ,
          }
        }
      );

    if (!response.ok) {

      handleExpiredSession(response);

      throw new Error(`Audio request failed (${response.status})`
      );
    }

    const blob =
      await response.blob();

    if (!blob.size) {

      throw new Error(
        "The saved audio file is empty."
      );
    }

    console.log(
      "Downloaded audio:",
      {
        type: blob.type,
        size: blob.size
      }
    );

    /*
     * Revoke any previous object URL attached
     * to this player.
     */
    if (audio.dataset.objectUrl) {

      try {
        URL.revokeObjectURL(
          audio.dataset.objectUrl
        );
      } catch (_) { }
    }

    const objectUrl =
      URL.createObjectURL(blob);

    audio.dataset.objectUrl =
      objectUrl;

    audio.src =
      objectUrl;

    audio.dataset.loaded =
      "true";

    /*
     * Use the actual MIME type returned by the server
     * if the browser supplied one.
     */
    if (blob.type) {
      audio.type =
        blob.type;
    }

    audio.load();

    /*
     * Try immediate playback.
     * If the browser blocks it, the native controls
     * are still available.
     */
    try {

      await audio.play();

    } catch (playError) {

      console.warn(
        "Browser blocked automatic playback:",
        playError
      );

      showToast(
        "Recording loaded. Press â–¶ on the audio player to hear it.",
        "info"
      );
    }

  } catch (err) {

    console.error(
      "Recording playback error:",
      err
    );

    showToast(
      `Could not load this recording: ${err.message}`,
      "error"
    );

  } finally {

    button.disabled = false;
    button.textContent =
      originalText;
  }
}

function formatDuration(seconds) {

  if (
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "—";
  }

  const rounded =
    Math.round(seconds);

  const mins =
    Math.floor(
      rounded / 60
    );

  const secs =
    rounded % 60;

  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// ============================================================================
// SHARING FUNCTIONS
// ============================================================================
function copyShareLink() {

  const input =
    document.getElementById(
      "share-link-input"
    );

  input.select();

  navigator.clipboard
    .writeText(input.value)
    .then(() => {

      showToast(
        "Tracking link copied to clipboard!",
        "success"
      );

    })
    .catch(() => {

      showToast(
        "Failed to copy link",
        "error"
      );
    });
}

function openTrackingPage() {

  const input =
    document.getElementById(
      "share-link-input"
    );

  if (input.value) {
    window.open(
      input.value,
      "_blank"
    );
  }
}

function shareViaWhatsApp() {

  const link =
    document.getElementById(
      "share-link-input"
    ).value;

  if (!link) return;

  const msg =
    encodeURIComponent(
      `EMERGENCY: I need help! Track my live location here: ${link}`
    );

  window.open(
    `https://wa.me/?text=${msg}`,
    "_blank"
  );
}

function shareViaSMS() {

  const link =
    document.getElementById(
      "share-link-input"
    ).value;

  if (!link) return;

  const msg =
    encodeURIComponent(
      `EMERGENCY: I need help! Track my live location here: ${link}`
    );

  window.open(
    `sms:?body=${msg}`,
    "_blank"
  );
}

function shareViaPhoneNative() {

  const link =
    document.getElementById(
      "share-link-input"
    ).value;

  if (!link) return;

  if (navigator.share) {

    navigator.share({
      title: "Mira Emergency Alert",
      text: "I started an emergency alert. Track my live location here:",
      url: link
    }).catch(() => { });

  } else {

    copyShareLink();
  }
}

// ============================================================================
// VOICE GUARDIAN
// ============================================================================
function toggleVoiceGuardian() {

  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) {

    showToast(
      "Speech Recognition is not supported by your browser (try Chrome/Edge).",
      "error"
    );

    return;
  }

  state.isGuardianActive =
    !state.isGuardianActive;

  const badge =
    document.getElementById(
      "voice-guardian-badge"
    );

  const label =
    document.getElementById(
      "voice-guardian-label"
    );

  const btn =
    document.getElementById(
      "btn-toggle-guardian"
    );

  if (state.isGuardianActive) {

    startListeningEngine();

    badge.classList.add(
      "listening"
    );

    label.textContent =
      "Voice: ON";

    if (btn) {
      btn.textContent =
        "Turn OFF Voice Guardian";
    }

    showToast(
      "Voice Guardian ACTIVE. Listening for your safe words.",
      "success"
    );

  } else {

    stopListeningEngine();

    badge.classList.remove(
      "listening"
    );

    label.textContent =
      "Voice: OFF";

    if (btn) {
      btn.textContent =
        "Turn ON Voice Guardian";
    }

    showToast(
      "Voice Guardian stopped",
      "info"
    );
  }
}

// ---------- Safe-word matching (forgiving) ----------
// Speech recognition rarely writes your words exactly the way you typed
// them: it adds punctuation, capitals, "u" for "you", splits or joins words.
// These helpers clean both sides before comparing, and for phrases of
// 4+ words allow one word to be misheard.

const SAFE_WORD_FIXES = {
  u: "you", ya: "you", r: "are", ur: "your",
  gonna: "going to", wanna: "want to", ok: "okay", k: "okay",
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
  "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten",
};

function normalizeSpeech(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SAFE_WORD_FIXES[w] || w)
    .join(" ");
}

function speechWordsMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    // allow one letter different: cat/cats, feed/fed
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, diffs = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      diffs++;
      if (diffs > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    return diffs + (a.length - i) + (b.length - j) <= 1;
  }
  return false;
}

function safeWordHeard(transcript, phrase) {
  const t = normalizeSpeech(transcript);
  const p = normalizeSpeech(phrase);
  if (!t || !p) return false;

  // 1. Exact match after cleaning
  if (t.includes(p)) return true;

  // 2. Same words but split/joined differently ("pine apple" vs "pineapple")
  if (t.replace(/ /g, "").includes(p.replace(/ /g, ""))) return true;

  // 3. Long phrases: allow one word to be missed or misheard
  const pw = p.split(" ");
  const tw = t.split(" ");
  if (pw.length < 4) return false;
  for (let start = 0; start < tw.length; start++) {
    const win = tw.slice(start, start + pw.length + 2);
    let k = 0, hits = 0;
    for (const w of win) {
      if (k < pw.length && speechWordsMatch(w, pw[k])) { hits++; k++; }
      else if (k + 1 < pw.length && speechWordsMatch(w, pw[k + 1])) { hits++; k += 2; }
    }
    if (hits >= pw.length - 1) return true;
  }
  return false;
}

function startListeningEngine() {

  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) return;

  const recognizer =
    new SpeechRecognition();

  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = "en-IN";

  recognizer.onresult =
    (event) => {

      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {

        const transcript =
          event.results[i][0]
            .transcript
            .toLowerCase();

        console.log(
          "Voice Guardian heard:",
          transcript
        );

        const startPhrase =
          state.startTrigger.toLowerCase();

        const stopPhrase =
          state.stopTrigger.toLowerCase();

        if (
                    safeWordHeard(transcript, startPhrase)
        ) {

          console.warn(
            "🚨 VOICE GUARDIAN DETECTED START TRIGGER:",
            startPhrase
          );

          showToast(
            `Safe-word detected: "${startPhrase}"`,
            "error"
          );

          startAlert();

        } else if (
                    safeWordHeard(transcript, stopPhrase)
        ) {

          console.log(
            "VOICE GUARDIAN DETECTED STOP TRIGGER:",
            stopPhrase
          );

          showToast(
            `Stop phrase detected: "${stopPhrase}"`,
            "success"
          );

          stopAlert();
        }
      }
    };

  recognizer.onerror =
    (e) => {
      console.warn(
        "Speech recognition error:",
        e.error
      );
    };

  recognizer.onend =
    () => {

      if (state.isGuardianActive) {

        try {
          recognizer.start();
        } catch (_) { }
      }
    };

  try {

    recognizer.start();

    state.speechRecognizer =
      recognizer;

  } catch (err) {

    console.warn(
      "Could not start speech recognition:",
      err
    );
  }
}

function stopListeningEngine() {

  if (state.speechRecognizer) {

    state.speechRecognizer.abort();

    state.speechRecognizer =
      null;
  }
}

// ============================================================================
// PRIYA AI CHAT COMPANION
// ============================================================================
async function loadChatHistory() {

  const container =
    document.getElementById(
      "chat-messages"
    );

  container.innerHTML =
    `<div style="text-align: center; color: var(--text-muted); font-size: 12px; padding: 12px;">Loading chat history...</div>`;

  try {

    const history =
      await api("/chat/history");

    container.innerHTML = "";

    if (
      !history ||
      history.length === 0
    ) {

      appendChatMessage(
        "priya",
        "Hey! Where are you right now? Did you start heading back?"
      );

      return;
    }

    history.forEach(msg => {

      appendChatMessage(
        msg.role === "user"
          ? "user"
          : "priya",
        msg.content,
        msg.time
      );
    });

    container.scrollTop =
      container.scrollHeight;

  } catch (err) {

    container.innerHTML =
      `<div style="text-align: center; color: var(--accent-emergency); font-size: 12px;">Could not load history (${err.message})</div>`;
  }
}

function cleanSpeechText(text) {

  if (!text) return "";

  return text

    .replace(
      /\*[^*]*\*/g,
      ""
    )

    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu,
      ""
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();
}

function appendChatMessage(
  role,
  text,
  timeStr
) {

  const container =
    document.getElementById(
      "chat-messages"
    );

  const bubble =
    document.createElement("div");

  bubble.className =
    `chat-bubble ${role}`;

  const time =
    timeStr
      ? new Date(timeStr).toLocaleTimeString(
        [],
        {
          hour: "2-digit",
          minute: "2-digit"
        }
      )
      : new Date().toLocaleTimeString(
        [],
        {
          hour: "2-digit",
          minute: "2-digit"
        }
      );

  if (role === "priya") {

    bubble.innerHTML = `
      <div class="chat-bubble-content">
        <div class="chat-text">${escapeHtml(text)}</div>
        <button
          type="button"
          class="bubble-listen-btn"
          title="Listen to Mira"
          onclick="playMiraAudio(this)"
        >🔊</button>
      </div>
      <span class="chat-bubble-time">${time}</span>
    `;

    const btn =
      bubble.querySelector(
        ".bubble-listen-btn"
      );

    if (btn) {
      btn.dataset.speech =
        text;
    }

  } else {

    bubble.innerHTML = `
      <div class="chat-text">${escapeHtml(text)}</div>
      <span class="chat-bubble-time">${time}</span>
    `;
  }

  container.appendChild(
    bubble
  );

  container.scrollTop =
    container.scrollHeight;
}

function playMiraAudio(btn) {

  const text =
    btn?.dataset?.speech;

  if (!text) return;

  if (
    window.speechSynthesis &&
    window.speechSynthesis.speaking &&
    btn.classList.contains("speaking")
  ) {

    window.speechSynthesis.cancel();

    btn.classList.remove(
      "speaking"
    );

    btn.textContent = "🔊";

    return;
  }

  document
    .querySelectorAll(
      ".bubble-listen-btn"
    )
    .forEach(b => {

      b.classList.remove(
        "speaking"
      );

      b.textContent = "🔊";
    });

  btn.classList.add(
    "speaking"
  );

  btn.textContent = "⏹️";

  speakText(
    text,
    () => {

      btn.classList.remove(
        "speaking"
      );

      btn.textContent = "🔊";
    }
  );
}

function sendQuickPrompt(promptText) {

  const input =
    document.getElementById(
      "chat-input"
    );

  if (input) {
    input.value =
      promptText;
  }

  const form =
    document.getElementById(
      "chat-form"
    );

  if (form) {

    const fakeEvent = {
      preventDefault: () => { }
    };

    sendChatMessage(
      fakeEvent
    );
  }
}

async function sendChatMessage(e) {

  e.preventDefault();

  const input =
    document.getElementById(
      "chat-input"
    );

  const text =
    input.value.trim();

  if (!text) return;

  input.value = "";

  appendChatMessage(
    "user",
    text
  );

  const container =
    document.getElementById(
      "chat-messages"
    );

  const typing =
    document.createElement("div");

  typing.id =
    "priya-typing";

  typing.className =
    "chat-bubble priya";

  typing.innerHTML = `
    <div class="typing-dots">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;

  container.appendChild(
    typing
  );

  container.scrollTop =
    container.scrollHeight;

  try {

    const res =
      await api("/chat", {
        method: "POST",
        body: {
          message: text
        }
      });

    typing.remove();

    appendChatMessage(
      "priya",
      res.reply
    );

    const banner =
      document.getElementById(
        "chat-emergency-banner"
      );

    if (
      res.emergency ||
      res.trigger_start
    ) {

      banner.classList.add(
        "visible"
      );

      if (
        res.trigger_start &&
        !state.isAlertActive
      ) {

        showToast(
          "Secret safe-word detected in chat! Alert started.",
          "error"
        );

        startAlert();
      }

    } else {

      banner.classList.remove(
        "visible"
      );
    }

    if (
      res.trigger_stop &&
      state.isAlertActive
    ) {

      showToast(
        "Stop safe-word detected in chat. Alert ended.",
        "success"
      );

      stopAlert();
    }

  } catch (err) {

    typing.remove();

    appendChatMessage(
      "priya",
      "Hey, I didn't quite catch that, can you say it again?"
    );

    showToast(
      err.message,
      "error"
    );
  }
}

async function clearChatHistory() {

  if (
    !confirm(
      "Clear your conversation history with Mira?"
    )
  ) {
    return;
  }

  try {

    await api(
      "/chat/history",
      {
        method: "DELETE"
      }
    );

    document.getElementById(
      "chat-messages"
    ).innerHTML = "";

    appendChatMessage(
      "priya",
      "Chat history cleared. How's it going?"
    );

    showToast(
      "Chat history cleared",
      "info"
    );

  } catch (err) {

    showToast(
      err.message,
      "error"
    );
  }
}

// ============================================================================
// PRIYA VOICE CALL MODE
// ============================================================================
let isMiraCallActive = false;
let callSpeechRecognizer = null;
let isCallMicMuted = false;
let callRecognitionRestartTimer = null;
let callTurnInProgress = false;

function getSpeechRecognitionClass() {

  return (
    window.SpeechRecognition ||
    window.webkitSpeechRecognition
  );
}

function browserSupportsMiraCall() {

  return (
    !!getSpeechRecognitionClass() &&
    !!window.speechSynthesis
  );
}

function getMiraVoice() {

  if (typeof pickMiraVoice === "function") {
    return pickMiraVoice();
  }

  const voices =
    window.speechSynthesis
      ?.getVoices?.() || [];

  if (!voices.length) {
    return null;
  }

  const preferred = [
    /Microsoft Jenny/i,
    /Microsoft Aria/i,
    /Microsoft Sonia/i,
    /Microsoft Libby/i,
    /Google UK English Female/i,
    /Samantha/i,
    /Zira/i,
    /Jenny/i,
    /Aria/i,
    /Sonia/i,
    /Libby/i
  ];

  for (
    const pattern of preferred
  ) {

    const voice =
      voices.find(
        v =>
          pattern.test(v.name) &&
          /^en[-_]/i.test(v.lang)
      );

    if (voice) {
      return voice;
    }
  }

  return (
    voices.find(
      v => /^en-IN/i.test(v.lang)
    ) ||
    voices.find(
      v => /^en-US/i.test(v.lang)
    ) ||
    voices.find(
      v => /^en-GB/i.test(v.lang)
    ) ||
    voices.find(
      v => /^en/i.test(v.lang)
    ) ||
    voices[0]
  );
}

if (
  typeof window !== "undefined" &&
  window.speechSynthesis
) {

  window.speechSynthesis.onvoiceschanged =
    () => {
      getMiraVoice();
    };
}

function toggleMiraVoiceCall() {

  if (!browserSupportsMiraCall()) {

    showToast(
      "Voice calling needs Chrome or Edge with microphone access.",
      "error"
    );

    return;
  }

  if (isMiraCallActive) {
    return endMiraVoiceCall();
  }

  startMiraVoiceCall();
}

async function startMiraVoiceCall() {

  try {

    if (
      !navigator.mediaDevices?.getUserMedia
    ) {
      throw new Error(
        "Microphone access is unavailable."
      );
    }

    const stream =
      await navigator.mediaDevices.getUserMedia({
        audio: true
      });

    stream
      .getTracks()
      .forEach(
        track => track.stop()
      );

    isMiraCallActive =
      true;

    isCallMicMuted =
      false;

    callTurnInProgress =
      false;

    const overlay =
      document.getElementById(
        "voice-call-overlay"
      );

    const btn =
      document.getElementById(
        "btn-toggle-call-mode"
      );

    const btnText =
      document.getElementById(
        "call-btn-text"
      );

    const statusTitle =
      document.getElementById(
        "call-status-title"
      );

    const statusSub =
      document.getElementById(
        "call-status-sub"
      );

    btn?.classList.add(
      "in-call"
    );

    if (btnText) {
      btnText.textContent =
        "End Call";
    }

    overlay?.classList.add(
      "active"
    );

    if (statusTitle) {
      statusTitle.textContent =
        "Connected to Mira";
    }

    if (statusSub) {
      statusSub.textContent =
        "Mira is speaking...";
    }

    const greeting =
      "Hey! I'm right here with you. Tell me what's going on.";

    appendChatMessage(
      "priya",
      greeting
    );

    speakText(
      greeting,
      () => {

        if (isMiraCallActive) {
          scheduleCallListening(
            250
          );
        }
      }
    );

  } catch (err) {

    console.warn(
      "Could not start Mira voice call:",
      err
    );

    isMiraCallActive =
      false;

    showToast(
      err.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow microphone access and try again."
        : `Could not start voice call: ${err.message}`,
      "error"
    );
  }
}

function endMiraVoiceCall() {

  isMiraCallActive =
    false;

  callTurnInProgress =
    false;

  if (callRecognitionRestartTimer) {
    clearTimeout(
      callRecognitionRestartTimer
    );
  }

  callRecognitionRestartTimer =
    null;

  stopCallListening();

  window.speechSynthesis?.cancel();

  document
    .getElementById(
      "btn-toggle-call-mode"
    )
    ?.classList.remove(
      "in-call"
    );

  const btnText =
    document.getElementById(
      "call-btn-text"
    );

  if (btnText) {
    btnText.textContent =
      "Start Phone Call";
  }

  document
    .getElementById(
      "voice-call-overlay"
    )
    ?.classList.remove(
      "active"
    );

  showToast(
    "Call with Mira ended",
    "info"
  );
}

function muteCallMic() {

  isCallMicMuted =
    !isCallMicMuted;

  const btn =
    document.getElementById(
      "btn-call-mute"
    );

  if (isCallMicMuted) {

    stopCallListening();

    if (btn) {
      btn.textContent =
        "🔇 Mic MUTED";

      btn.style.color =
        "var(--accent-emergency)";
    }

  } else {

    if (btn) {
      btn.textContent =
        "🎤 Mic ON";

      btn.style.color =
        "";
    }

    if (isMiraCallActive) {
      scheduleCallListening(
        150
      );
    }
  }
}

function speakText(
  text,
  onComplete
) {

  if (!window.speechSynthesis) {
    return onComplete?.();
  }

  window.speechSynthesis.cancel();

  const spoken =
    cleanSpeechText(text) ||
    text;

  const utterance =
    new SpeechSynthesisUtterance(
      spoken
    );

  utterance.rate =
    0.94;

  utterance.pitch =
    1.1;

  utterance.volume =
    1;

  const voice =
    getMiraVoice();

  if (voice) {
    utterance.voice =
      voice;
  }

  const avatar =
    document.getElementById(
      "call-avatar"
    );

  avatar?.classList.add(
    "speaking"
  );

  let done = false;

  const finish = () => {

    if (done) return;

    done = true;

    avatar?.classList.remove(
      "speaking"
    );

    onComplete?.();
  };

  utterance.onend =
    finish;

  utterance.onerror =
    finish;

  window.speechSynthesis.speak(
    utterance
  );
}

function scheduleCallListening(
  delay = 250
) {

  if (
    !isMiraCallActive ||
    isCallMicMuted
  ) {
    return;
  }

  if (callRecognitionRestartTimer) {
    clearTimeout(
      callRecognitionRestartTimer
    );
  }

  callRecognitionRestartTimer =
    setTimeout(() => {

      callRecognitionRestartTimer =
        null;

      if (
        isMiraCallActive &&
        !isCallMicMuted &&
        !callTurnInProgress
      ) {
        startCallListening();
      }

    }, delay);
}

function startCallListening() {

  if (
    !isMiraCallActive ||
    isCallMicMuted ||
    callTurnInProgress
  ) {
    return;
  }

  const SpeechRecognition =
    getSpeechRecognitionClass();

  if (!SpeechRecognition) {
    return;
  }

  const title =
    document.getElementById(
      "call-status-title"
    );

  const sub =
    document.getElementById(
      "call-status-sub"
    );

  if (title) {
    title.textContent =
      "Listening to you...";
  }

  if (sub) {
    sub.textContent =
      "Speak naturally — Mira is listening";
  }

  stopCallListening();

  const rec =
    new SpeechRecognition();

  rec.lang =
    "en-IN";

  rec.continuous =
    false;

  rec.interimResults =
    true;

  rec.maxAlternatives =
    1;

  let finalTranscript =
    "";

  rec.onstart =
    () => {
      callSpeechRecognizer =
        rec;
    };

  rec.onresult =
    event => {

      let interim =
        "";

      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {

        const tr =
          event.results[i][0]
            .transcript;

        if (
          event.results[i].isFinal
        ) {

          finalTranscript +=
            tr + " ";

        } else {

          interim +=
            tr;
        }
      }

      if (
        sub &&
        interim
      ) {

        sub.textContent =
          `Hearing: "${interim.trim()}"`;
      }
    };

  rec.onend =
    () => {

      if (
        callSpeechRecognizer === rec
      ) {
        callSpeechRecognizer =
          null;
      }

      if (
        !isMiraCallActive ||
        isCallMicMuted
      ) {
        return;
      }

      const spoken =
        finalTranscript.trim();

      if (spoken) {
        handleMiraSpokenTurn(
          spoken
        );
      } else {
        scheduleCallListening(
          250
        );
      }
    };

  rec.onerror =
    event => {

      console.warn(
        "Mira call speech recognition error:",
        event.error
      );

      if (
        callSpeechRecognizer === rec
      ) {
        callSpeechRecognizer =
          null;
      }

      if (
        !isMiraCallActive ||
        isCallMicMuted
      ) {
        return;
      }

      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {

        showToast(
          "Microphone permission is blocked. Allow microphone access for this site.",
          "error"
        );

        return;
      }

      if (
        event.error === "audio-capture"
      ) {

        showToast(
          "No working microphone was detected.",
          "error"
        );

        return;
      }

      scheduleCallListening(
        700
      );
    };

  try {

    rec.start();

  } catch (err) {

    console.warn(
      "Speech recognition start failed:",
      err
    );

    scheduleCallListening(
      800
    );
  }
}

async function handleMiraSpokenTurn(
  spoken
) {

  if (
    !isMiraCallActive ||
    isCallMicMuted ||
    callTurnInProgress
  ) {
    return;
  }

  callTurnInProgress =
    true;

  const title =
    document.getElementById(
      "call-status-title"
    );

  const sub =
    document.getElementById(
      "call-status-sub"
    );

  appendChatMessage(
    "user",
    spoken
  );

  if (title) {
    title.textContent =
      "Mira is thinking...";
  }

  if (sub) {
    sub.textContent =
      "One moment...";
  }

  try {

    const res =
      await api(
        "/chat",
        {
          method: "POST",
          body: {
            message: spoken
          }
        }
      );

    if (!isMiraCallActive) {
      return;
    }

    appendChatMessage(
      "priya",
      res.reply
    );

    if (
      res.emergency ||
      res.trigger_start
    ) {

      document
        .getElementById(
          "chat-emergency-banner"
        )
        ?.classList.add(
          "visible"
        );

      if (
        res.trigger_start &&
        !state.isAlertActive
      ) {
        startAlert();
      }
    }

    if (
      res.trigger_stop &&
      state.isAlertActive
    ) {
      stopAlert();
    }

    if (title) {
      title.textContent =
        "Mira is speaking...";
    }

    if (sub) {
      sub.textContent =
        "Mira is replying...";
    }

    speakText(
      res.reply,
      () => {

        callTurnInProgress =
          false;

        scheduleCallListening(
          250
        );
      }
    );

  } catch (err) {

    console.warn(
      "Mira voice turn failed:",
      err
    );

    speakText(
      "I didn't catch that. Could you say that again?",
      () => {

        callTurnInProgress =
          false;

        scheduleCallListening(
          250
        );
      }
    );
  }
}

function stopCallListening() {

  if (callSpeechRecognizer) {

    try {

      callSpeechRecognizer.onend =
        null;

      callSpeechRecognizer.onerror =
        null;

      callSpeechRecognizer.abort();

    } catch (_) { }

    callSpeechRecognizer =
      null;
  }
}

let chatSpeechRecognizer =
  null;

function toggleChatSpeechInput() {

  const SpeechRecognition =
    getSpeechRecognitionClass();

  if (!SpeechRecognition) {

    showToast(
      "Voice typing is not supported in this browser (try Chrome/Edge).",
      "error"
    );

    return;
  }

  const btn =
    document.getElementById(
      "chat-mic-btn"
    );

  const input =
    document.getElementById(
      "chat-input"
    );

  if (chatSpeechRecognizer) {

    try {
      chatSpeechRecognizer.abort();
    } catch (_) { }

    chatSpeechRecognizer =
      null;

    btn?.classList.remove(
      "recording"
    );

    return;
  }

  const rec =
    new SpeechRecognition();

  rec.lang =
    "en-IN";

  rec.continuous =
    false;

  rec.interimResults =
    true;

  btn?.classList.add(
    "recording"
  );

  showToast(
    "🎤 Listening... Speak your message now",
    "info"
  );

  rec.onresult =
    (e) => {

      let transcript =
        "";

      for (
        let i = e.resultIndex;
        i < e.results.length;
        i++
      ) {

        transcript +=
          e.results[i][0]
            .transcript;
      }

      if (input) {
        input.value =
          transcript;
      }
    };

  rec.onerror =
    (e) => {

      btn?.classList.remove(
        "recording"
      );

      chatSpeechRecognizer =
        null;

      if (
        e.error === "not-allowed"
      ) {

        showToast(
          "Microphone permission denied. Allow mic access in browser.",
          "error"
        );

      } else {

        showToast(
          "Could not recognize voice. Speak a bit louder.",
          "info"
        );
      }
    };

  rec.onend =
    () => {

      btn?.classList.remove(
        "recording"
      );

      chatSpeechRecognizer =
        null;
    };

  try {

    rec.start();

    chatSpeechRecognizer =
      rec;

  } catch (err) {

    btn?.classList.remove(
      "recording"
    );

    chatSpeechRecognizer =
      null;

    console.warn(
      "Chat speech start failed:",
      err
    );
  }
}

// ============================================================================
// CONTACTS MANAGEMENT
// ============================================================================
async function loadContacts() {

  const list =
    document.getElementById(
      "contacts-list"
    );

  list.innerHTML =
    `<div style="text-align: center; color: var(--text-muted); padding: 14px;">Loading contacts...</div>`;

  try {

    const contacts =
      await api("/contacts");

    document.getElementById(
      "contact-count-badge"
    ).textContent =
      contacts.length;

    if (
      !contacts ||
      contacts.length === 0
    ) {

      list.innerHTML = `
        <div style="text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px;">
          No emergency contacts added yet.<br>
          Add your family or trusted friends so they receive your tracking link!
        </div>`;

      return;
    }

    list.innerHTML =
      contacts
        .map(
          c => `
      <div class="contact-card">

        <div class="contact-info">
          <h4>${escapeHtml(c.name)}</h4>

          <div class="contact-meta">
            <span>📞 ${escapeHtml(c.phone)}</span>
            <span>✉️ ${escapeHtml(c.email || "No email")}</span>
          </div>
        </div>

        <div class="contact-actions">

          <a
            href="tel:${escapeHtml(c.phone)}"
            class="btn-secondary"
            style="padding: 6px 10px; font-size: 12px; text-decoration: none;"
          >
            Call
          </a>

          <button
            class="btn-icon-danger"
            onclick="deleteContact(${c.id})"
            title="Delete contact"
          >
            âœ•
          </button>

        </div>

      </div>
    `
        )
        .join("");

  } catch (err) {

    list.innerHTML =
      `<div style="color: var(--accent-emergency); text-align: center;">${err.message}</div>`;
  }
}

function toggleAddContactForm() {

  const panel =
    document.getElementById(
      "add-contact-panel"
    );

  panel.style.display =
    panel.style.display === "none"
      ? "block"
      : "none";
}

async function handleAddContact(e) {

  e.preventDefault();

  const name =
    document.getElementById(
      "new-contact-name"
    ).value.trim();

  const phone =
    document.getElementById(
      "new-contact-phone"
    ).value.trim();

  const email =
    document.getElementById(
      "new-contact-email"
    ).value.trim();

  try {

    await api(
      "/contacts",
      {
        method: "POST",
        body: {
          name,
          phone,
          email
        }
      }
    );

    showToast(
      "Contact added successfully",
      "success"
    );

    document.getElementById(
      "add-contact-form"
    ).reset();

    toggleAddContactForm();

    loadContacts();

  } catch (err) {

    showToast(
      err.message,
      "error"
    );
  }
}

async function deleteContact(id) {

  if (
    !confirm(
      "Are you sure you want to remove this emergency contact?"
    )
  ) {
    return;
  }

  try {

    await api(
      `/contacts/${id}`,
      {
        method: "DELETE"
      }
    );

    showToast(
      "Contact removed",
      "info"
    );

    loadContacts();

  } catch (err) {

    showToast(
      err.message,
      "error"
    );
  }
}

// ============================================================================
// NEARBY EMERGENCY SERVICES
// ============================================================================
let nearbyMap = null;
let nearbyMarkersGroup = null;
let nearbyUserMarker = null;

function initNearbyLeafletMap(
  lat,
  lon
) {

  const mapContainer =
    document.getElementById(
      "nearby-map"
    );

  if (
    !mapContainer ||
    typeof L === "undefined"
  ) {
    return;
  }

  if (!nearbyMap) {

    nearbyMap =
      L.map(
        "nearby-map",
        {
          zoomControl: false
        }
      )
        .setView(
          [lat, lon],
          14
        );

    L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        attribution:
          "© OpenStreetMap",
        maxZoom: 19
      }
    ).addTo(
      nearbyMap
    );

    nearbyMarkersGroup =
      L.layerGroup()
        .addTo(
          nearbyMap
        );

  } else {

    nearbyMap.setView(
      [lat, lon],
      14
    );

    nearbyMap.invalidateSize();
  }

  if (nearbyUserMarker) {
    nearbyUserMarker.remove();
  }

  const userIcon =
    L.divIcon({
      className:
        "user-pin",

      html:
        `<div style="width: 18px; height: 18px; border-radius: 50%; background: #6366f1; border: 3px solid white; box-shadow: 0 0 10px rgba(99,102,241,0.8);"></div>`,

      iconSize: [
        18,
        18
      ],

      iconAnchor: [
        9,
        9
      ]
    });

  nearbyUserMarker =
    L.marker(
      [lat, lon],
      {
        icon: userIcon
      }
    )
      .addTo(
        nearbyMap
      )
      .bindPopup(
        "<b>You are here</b>"
      );
}

let lastKnownCoords =
  null;

let currentSafetyCircle =
  null;

async function loadAreaSafety(
  latitude,
  longitude,
  force = false
) {

  const summaryBox =
    document.getElementById(
      "area-safety-summary-box"
    );

  const summaryText =
    document.getElementById(
      "area-safety-summary-text"
    );

  const title =
    document.getElementById(
      "area-safety-title"
    );

  const status =
    document.getElementById(
      "area-safety-status"
    );

  const rescanBtn =
    document.getElementById(
      "btn-rescan-safety"
    );

  const adviceEl =
    document.getElementById(
      "safe-route-advice"
    );

  const actionsEl =
    document.getElementById(
      "safe-haven-actions"
    );

  if (
    !summaryBox ||
    !summaryText
  ) {
    return;
  }

  summaryBox.classList.add(
    "loading"
  );

  if (rescanBtn) {
    rescanBtn.style.opacity =
      "0.5";
  }

  summaryText.textContent =
    "Scanning street lighting, main roads, and nearby safe havens with AI...";

  try {

    const data =
      await api(
        `/area-safety?lat=${latitude}&lon=${longitude}`
      );

    summaryBox.classList.remove(
      "loading"
    );

    if (rescanBtn) {
      rescanBtn.style.opacity =
        "1";
    }

    const lit =
      data.lit_road_segments_nearby ||
      0;

    const main =
      data.main_road_segments_nearby ||
      0;

    const police =
      data.nearest_police_m;

    const hosp =
      data.nearest_hospital_m;

    const biz =
      data.businesses_nearby ||
      0;

    const litEl =
      document.getElementById(
        "metric-lit-roads"
      );

    const mainEl =
      document.getElementById(
        "metric-main-roads"
      );

    const polEl =
      document.getElementById(
        "metric-police-dist"
      );

    const hospEl =
      document.getElementById(
        "metric-hospital-dist"
      );

    if (litEl) {
      litEl.textContent =
        `${lit} segs`;
    }

    if (mainEl) {
      mainEl.textContent =
        `${main} segs`;
    }

    if (polEl) {
      polEl.textContent =
        police != null
          ? `${police}m`
          : "None <1km";
    }

    if (hospEl) {
      hospEl.textContent =
        hosp != null
          ? `${hosp}m`
          : "None <1km";
    }

    let badgeColor =
      "#10b981";

    let levelName =
      "Well-Monitored & Active";

    let icon =
      "🛡️";

    if (
      (police && police <= 400) ||
      (main >= 4 && lit >= 1)
    ) {

      badgeColor =
        "#10b981";

      levelName =
        "High Security & Active Zone";

      icon =
        "🟢";

    } else if (
      main >= 2 ||
      biz >= 2 ||
      (police && police <= 1000)
    ) {

      badgeColor =
        "#f59e0b";

      levelName =
        "Moderate Activity Area";

      icon =
        "🟡";

    } else {

      badgeColor =
        "#f43f5e";

      levelName =
        "Low Infrastructure / Quiet Area";

      icon =
        "🟠";
    }

    if (title) {
      title.innerHTML =
        `${icon} Area Safety: <span style="color: ${badgeColor}; font-weight: 700;">${levelName}</span>`;
    }

    if (status) {
      status.textContent =
        `${main} main roads nearby • ${biz} open places • Police: ${police != null ? police + "m" : "not found <1km"}`;
    }

    if (summaryText) {

      summaryText.textContent =
        data.safety_summary ||
        "Real-time area scan complete. Open commercial establishments and road segments verified.";
    }

    if (adviceEl) {

      if (lit > 0) {

        adviceEl.textContent =
          `Stick to the ${lit} lit road segments and main avenues. Commercial spots are active nearby.`;

      } else if (main > 0) {

        adviceEl.textContent =
          `Street lighting data is limited here. Walk strictly along the ${main} main road segments rather than narrow side-alleys.`;

      } else {

        adviceEl.textContent =
          `Low road density area. Stay attentive, keep your phone in hand, and proceed directly toward the nearest populated avenue or safe haven.`;
      }
    }

    if (actionsEl) {

      actionsEl.innerHTML =
        "";

      if (police != null) {

        actionsEl.innerHTML += `
          <a
            class="safe-route-btn"
            href="https://www.google.com/maps/search/police+station/@${latitude},${longitude},15z"
            target="_blank"
            rel="noopener"
          >
            🚑 Route to Police (${police}m)
          </a>`;
      }

      if (hosp != null) {

        actionsEl.innerHTML += `
          <a
            class="safe-route-btn"
            href="https://www.google.com/maps/search/hospital/@${latitude},${longitude},15z"
            target="_blank"
            rel="noopener"
          >
            🏥 Route to Hospital (${hosp}m)
          </a>`;
      }

      actionsEl.innerHTML += `
        <a
          class="safe-route-btn"
          href="https://www.google.com/maps/search/pharmacy/@${latitude},${longitude},15z"
          target="_blank"
          rel="noopener"
          style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border-color: rgba(99, 102, 241, 0.4);"
        >
          💊 Route to Pharmacy
        </a>`;
    }

    if (
      nearbyMap &&
      typeof L !== "undefined"
    ) {

      if (currentSafetyCircle) {
        currentSafetyCircle.remove();
      }

      currentSafetyCircle =
        L.circle(
          [latitude, longitude],
          {
            radius: 250,
            color: badgeColor,
            fillColor: badgeColor,
            fillOpacity: 0.12,
            weight: 1.5,
            dashArray: "4, 6"
          }
        )
          .addTo(
            nearbyMap
          )
          .bindPopup(
            `<b>Safety Zone</b><br>${levelName}<br><small>${data.safety_summary || ""}</small>`
          );
    }

  } catch (err) {

    summaryBox.classList.remove(
      "loading"
    );

    if (rescanBtn) {
      rescanBtn.style.opacity =
        "1";
    }

    console.warn(
      "Area safety check notice:",
      err
    );

    if (summaryText) {

      summaryText.innerHTML =
        `<span>OpenStreetMap live query is taking longer than usual. Use the 1-tap emergency routes below to reach verified police or hospitals:</span>`;
    }

    if (actionsEl) {

      actionsEl.innerHTML = `
        <a
          class="safe-route-btn"
          href="https://www.google.com/maps/search/police+station/@${latitude},${longitude},15z"
          target="_blank"
          rel="noopener"
        >
          🚑 Nearest Police Station
        </a>

        <a
          class="safe-route-btn"
          href="https://www.google.com/maps/search/hospital/@${latitude},${longitude},15z"
          target="_blank"
          rel="noopener"
        >
          🏥 Nearest Hospital
        </a>`;
    }
  }
}

function refreshAreaSafety() {

  if (lastKnownCoords) {

    showToast(
      "Re-scanning area safety factors...",
      "info"
    );

    loadAreaSafety(
      lastKnownCoords.latitude,
      lastKnownCoords.longitude,
      true
    );

  } else if (
    navigator.geolocation
  ) {

    showToast(
      "Locating GPS for safety scan...",
      "info"
    );

    navigator.geolocation.getCurrentPosition(
      pos => {

        lastKnownCoords = {
          latitude:
            pos.coords.latitude,
          longitude:
            pos.coords.longitude
        };

        loadAreaSafety(
          pos.coords.latitude,
          pos.coords.longitude,
          true
        );
      },

      err => {

        showToast(
          "Could not access location for safety scan",
          "error"
        );
      }
    );
  }
}

async function loadNearby(
  placeType
) {

  currentNearbyType =
    placeType;

  document
    .querySelectorAll(
      ".nearby-tab"
    )
    .forEach(
      t =>
        t.classList.remove(
          "active"
        )
    );

  const tab =
    document.getElementById(
      `nearby-tab-${placeType}`
    );

  if (tab) {
    tab.classList.add(
      "active"
    );
  }

  const loading =
    document.getElementById(
      "nearby-loading"
    );

  const list =
    document.getElementById(
      "nearby-list"
    );

  const directGmapsBtn =
    document.getElementById(
      "btn-gmaps-direct"
    );

  loading.style.display =
    "block";

  list.innerHTML =
    "";

  if (!navigator.geolocation) {

    loading.style.display =
      "none";

    list.innerHTML =
      `<div style="text-align: center; color: var(--accent-emergency); padding: 16px;">Geolocation is not supported by your browser.</div>`;

    return;
  }

  navigator.geolocation.getCurrentPosition(

    async (pos) => {

      const {
        latitude,
        longitude
      } = pos.coords;

      lastKnownCoords = {
        latitude,
        longitude
      };

      initNearbyLeafletMap(
        latitude,
        longitude
      );

      loadAreaSafety(
        latitude,
        longitude
      );

      const queryName =
        placeType === "hospital"
          ? "hospitals"
          : placeType === "police"
            ? "police+station"
            : "pharmacies";

      if (directGmapsBtn) {

        directGmapsBtn.href =
          `https://www.google.com/maps/search/${queryName}/@${latitude},${longitude},14z`;
      }

      if (nearbyMarkersGroup) {
        nearbyMarkersGroup.clearLayers();
      }

      try {

        const results =
          await api(
            `/nearby?place=${placeType}&lat=${latitude}&lon=${longitude}&radius=5000`
          );

        loading.style.display =
          "none";

        if (
          !results ||
          results.length === 0
        ) {

          list.innerHTML = `
            <div style="text-align: center; color: var(--text-muted); padding: 20px;">
              No ${placeType}s found within 5km of your location.<br>

              <a
                href="https://www.google.com/maps/search/${queryName}/@${latitude},${longitude},14z"
                target="_blank"
                rel="noopener"
                class="btn-secondary"
                style="display:inline-block; margin-top:10px; text-decoration:none;"
              >
                Search Wider Area on Google Maps
              </a>
            </div>`;

          return;
        }

        const facilityIcon =
          L.divIcon({
            className:
              "facility-pin",

            html:
              `<div style="width: 14px; height: 14px; border-radius: 50%; background: #f43f5e; border: 2px solid white; box-shadow: 0 0 8px rgba(244,63,94,0.6);"></div>`,

            iconSize: [
              14,
              14
            ],

            iconAnchor: [
              7,
              7
            ]
          });

        results.forEach(
          p => {

            if (
              p.latitude &&
              p.longitude &&
              nearbyMarkersGroup
            ) {

              L.marker(
                [
                  p.latitude,
                  p.longitude
                ],
                {
                  icon:
                    facilityIcon
                }
              )
                .addTo(
                  nearbyMarkersGroup
                )
                .bindPopup(
                  `<b>${escapeHtml(p.name)}</b><br><a href="${escapeHtml(p.map_link)}" target="_blank">Directions</a>`
                );
            }
          }
        );

        list.innerHTML =
          results
            .map(
              p => {

                const distKm =
                  (
                    p.distance_m /
                    1000
                  ).toFixed(1);

                return `
            <div class="place-card">

              <h4>
                ${escapeHtml(p.name)}
              </h4>

              <div class="place-meta">
                <span>
                  📌 ${distKm} km away
                </span>

                ${p.phone
                    ? `<span>📞 ${escapeHtml(p.phone)}</span>`
                    : ""
                  }
              </div>

              <div class="place-links">

                ${p.phone
                    ? `<a href="tel:${escapeHtml(p.phone)}" class="btn-secondary" style="text-decoration:none; padding: 6px 12px;">Call</a>`
                    : ""
                  }

                <a
                  href="${escapeHtml(p.map_link)}"
                  target="_blank"
                  rel="noopener"
                  class="btn-secondary"
                  style="text-decoration:none; padding: 6px 12px;"
                >
                  Directions
                </a>

              </div>

            </div>
          `;
              }
            )
            .join("");

        list.innerHTML +=
          `<p style="font-size: 11px; color: var(--text-muted); text-align: center; margin-top: 14px;">© OpenStreetMap contributors</p>`;

      } catch (err) {

        loading.style.display =
          "none";

        list.innerHTML = `
          <div
            style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 16px; text-align: center; margin-top: 8px;"
          >

            <div
              style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;"
            >
              OpenStreetMap server is currently busy
            </div>

            <p
              style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;"
            >
              You can view live nearby ${placeType}s directly on Google Maps with 1 tap:
            </p>

            <a
              href="https://www.google.com/maps/search/${queryName}/@${latitude},${longitude},14z"
              target="_blank"
              rel="noopener"
              class="btn-primary"
              style="text-decoration:none; display:inline-flex; width:auto; padding: 10px 20px;"
            >
              🗺️ Open ${placeType.charAt(0).toUpperCase() + placeType.slice(1)}s on Google Maps
            </a>

          </div>`;
      }
    },

    (err) => {

      loading.style.display =
        "none";

      list.innerHTML =
        `<div style="text-align: center; color: var(--accent-emergency); padding: 16px;">Please allow location permission in your browser to view nearby facilities.</div>`;
    }
  );
}

// ============================================================================
// AUDIO RECORDINGS / EVIDENCE
// ============================================================================

async function loadRecordings(
  showRefreshState = false
) {

  const list =
    document.getElementById(
      "recordings-list"
    );

  if (!list) return;

  if (showRefreshState) {

    list.innerHTML =
      `<div style="text-align:center;color:var(--text-muted);padding:14px;">Saving and loading audio evidence…</div>`;

  } else {

    list.innerHTML =
      `<div style="text-align:center;color:var(--text-muted);padding:14px;">Loading recordings…</div>`;
  }

  try {

    const files =
      await api("/audio");

    /*
     * Clear button is always available when there
     * are recordings.
     */
    if (
      !files ||
      files.length === 0
    ) {

      list.innerHTML = `
        <div
          style="
            display:flex;
            justify-content:space-between;
            align-items:center;
            gap:12px;
            margin-bottom:14px;
            padding:12px 14px;
            border:1px solid var(--border-subtle);
            border-radius:12px;
            background:var(--bg-card);
          "
        >
          <div>
            <div style="font-size:13px;font-weight:700;color:var(--text-primary);">
              🎧 Audio Evidence
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
              No saved recordings
            </div>
          </div>
        </div>

        <div
          style="
            text-align:center;
            color:var(--text-muted);
            padding:24px;
          "
        >
          Start an alert and Mira will save
          rolling 10-second microphone evidence clips here.
        </div>
      `;

      return;
    }

    /*
     * Newest recordings first.
     */
    const sortedFiles =
      [...files].sort(
        (a, b) =>
          new Date(b.time) -
          new Date(a.time)
      );

    /*
     * Header + Clear All button.
     */
    let html = `
      <div
        style="
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:12px;
          margin-bottom:14px;
          padding:12px 14px;
          border:1px solid var(--border-subtle);
          border-radius:12px;
          background:var(--bg-card);
        "
      >

        <div>
          <div
            style="
              font-size:13px;
              font-weight:700;
              color:var(--text-primary);
            "
          >
            🎧 ${sortedFiles.length} Audio Evidence Clip${sortedFiles.length === 1 ? "" : "s"}
          </div>

          <div
            style="
              font-size:11px;
              color:var(--text-muted);
              margin-top:3px;
            "
          >
            Rolling 10-second recordings from your alerts
          </div>
        </div>

        <button
          type="button"
          class="btn-secondary"
          onclick="clearAllRecordings()"
          style="
            padding:7px 11px;
            color:var(--accent-emergency);
            border-color:rgba(244,63,94,0.35);
            white-space:nowrap;
          "
        >
          🗑️ Clear All
        </button>

      </div>
    `;

    /*
     * Add every recording.
     */
    html += sortedFiles
      .map(
        (f, index) => {

          const time =
            new Date(
              f.time
            ).toLocaleString();

          const audioId =
            escapeHtml(
              String(f.id)
            );

          return `
        <div
          class="place-card audio-recording-card"
          style="
            margin-bottom:12px;
            position:relative;
          "
        >

          <div
            style="
              display:flex;
              justify-content:space-between;
              align-items:center;
              gap:8px;
              margin-bottom:6px;
            "
          >

            <div
              style="
                font-size:12px;
                font-weight:700;
                color:var(--text-primary);
              "
            >
              Audio Clip ${index + 1}
            </div>

            <div
              style="
                font-size:10px;
                color:var(--text-muted);
              "
            >
              ${escapeHtml(time)}
            </div>

          </div>

          <div
            style="
              font-size:10px;
              color:var(--text-muted);
              margin-bottom:8px;
            "
          >
            🎙️ Emergency evidence recording
          </div>

          <div
            style="
              display:flex;
              align-items:center;
              justify-content:space-between;
              gap:8px;
              margin-bottom:8px;
            "
          >

            <span
              class="audio-duration-label"
              style="
                font-size:11px;
                color:var(--text-muted);
              "
            >
              Target: 00:10 • Actual: checking…
            </span>

            <button
              type="button"
              class="btn-secondary"
              data-audio-id="${audioId}"
              onclick="loadRecordingAudio(this)"
              style="padding:6px 10px;"
            >
              â–¶ Play
            </button>

          </div>

          <audio
            controls
            preload="metadata"
            data-loaded="false"
            style="
              width:100%;
              height:36px;
              border-radius:8px;
            "
            onloadedmetadata="
              const label = this.closest('.audio-recording-card').querySelector('.audio-duration-label');
              if (label) {
                label.textContent =
                  'Target: 00:10 • Actual: ' +
                  formatDuration(this.duration);
              }
            "
            onerror="
              const label = this.closest('.audio-recording-card').querySelector('.audio-duration-label');
              if (label) {
                label.textContent =
                  'Target: 00:10 • Could not decode audio';
              }
            "
          ></audio>

        </div>
      `;
        }
      )
      .join("");

    list.innerHTML =
      html;

  } catch (err) {

    list.innerHTML =
      `<div style="color:var(--accent-emergency);text-align:center;padding:16px;">${escapeHtml(err.message)}</div>`;
  }
}

// --------------------------------------------------------------------------
// DELETE ALL AUDIO RECORDINGS
// --------------------------------------------------------------------------
async function clearAllRecordings() {

  const confirmed =
    window.confirm(
      "Delete ALL saved audio evidence for this account?\n\nThis cannot be undone."
    );

  if (!confirmed) {
    return;
  }

  try {

    await api(
      "/audio",
      {
        method: "DELETE"
      }
    );

    showToast(
      "All audio evidence was cleared.",
      "success"
    );

    await loadRecordings();

  } catch (err) {

    console.error(
      "Could not clear audio recordings:",
      err
    );

    showToast(
      `Could not clear recordings: ${err.message}`,
      "error"
    );
  }
}

// ============================================================================
// SETTINGS & SAFE-WORDS
// ============================================================================
async function loadSettings() {
  await loadTriggers();
}

async function loadTriggers() {

  try {

    const data =
      await api(
        "/settings/triggers"
      );

    if (data.start_trigger) {

      state.startTrigger =
        data.start_trigger;

      state.stopTrigger =
        data.stop_trigger;

      const startInput =
        document.getElementById(
          "setting-start-trigger"
        );

      const stopInput =
        document.getElementById(
          "setting-stop-trigger"
        );

      if (startInput) {
        startInput.value =
          data.start_trigger;
      }

      if (stopInput) {
        stopInput.value =
          data.stop_trigger;
      }
    }

  } catch (err) {

    console.warn(
      "Could not load trigger settings:",
      err
    );
  }
}

async function handleSaveTriggers(e) {

  e.preventDefault();

  const start =
    document.getElementById(
      "setting-start-trigger"
    ).value
      .trim()
      .toLowerCase();

  const stop =
    document.getElementById(
      "setting-stop-trigger"
    ).value
      .trim()
      .toLowerCase();

  if (!start || !stop) {

    showToast(
      "Both phrases are required",
      "error"
    );

    return;
  }

  if (start === stop) {

    showToast(
      "Start and stop phrases must be different",
      "error"
    );

    return;
  }

  try {

    await api(
      "/settings/triggers",
      {
        method: "POST",
        body: {
          start_trigger:
            start,

          stop_trigger:
            stop
        }
      }
    );

    state.startTrigger =
      start;

    state.stopTrigger =
      stop;

    showToast(
      "Custom safe-words saved successfully!",
      "success"
    );

  } catch (err) {

    showToast(
      err.message,
      "error"
    );
  }
}

async function showRecoveryCode() {

  const display =
    document.getElementById(
      "recovery-code-display"
    );

  display.style.display =
    "block";

  display.textContent =
    "Generating emergency recovery code...";

  try {

    const res =
      await api(
        "/account/recovery-code",
        {
          method: "POST"
        }
      );

    display.innerHTML = `
      <div
        style="color: var(--accent-safe); margin-bottom: 4px;"
      >
        Save this recovery code somewhere safe:
      </div>

      <div
        style="font-size: 15px; font-weight: 700; color: white; letter-spacing: 1px;"
      >
        ${res.recovery_code}
      </div>

      <div
        style="font-size: 11px; color: var(--text-muted); margin-top: 4px;"
      >
        Use this if you ever forget your password.
      </div>
    `;

  } catch (err) {

    display.textContent =
      `Error: ${err.message}`;
  }
}

// ============================================================================
// INITIALIZATION ON PAGE LOAD
// ============================================================================
document.addEventListener(
  "DOMContentLoaded",
  () => {

    if (
      state.token &&
      state.username
    ) {

      onLoginSuccess();

    } else {

      navigateTo(
        "auth"
      );
    }

    const voiceBadge =
      document.getElementById(
        "voice-guardian-badge"
      );

    if (voiceBadge) {

      voiceBadge.addEventListener(
        "click",
        () => {
          toggleVoiceGuardian();
        }
      );
    }
  }
);
