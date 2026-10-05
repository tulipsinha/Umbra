function sendSmsAlert(contacts, trackingLink) {
  const contactList = Array.isArray(contacts) ? contacts : [];
  const numbers = contactList
    .map((contact) => (contact && contact.phone ? String(contact.phone).trim() : ""))
    .filter(Boolean);

  if (!numbers.length) {
    if (typeof showToast === "function") {
      showToast("No contact numbers are available for SMS fallback.", "error");
    }
    return;
  }

  const baseMessage = trackingLink
    ? `I'm in danger. Please check my live location: ${trackingLink}`
    : "I'm in danger. Please call me now and check on me.";

  const encoded = encodeURIComponent(baseMessage);
  const smsTarget = numbers.join(",");
  const smsUrl = `sms:${smsTarget}?body=${encoded}`;

  if (typeof window !== "undefined") {
    window.location.href = smsUrl;
  }

  if (typeof showToast === "function") {
    showToast("SMS fallback opened with your emergency message.", "info");
  }
}
