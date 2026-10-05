let miraVoice = null;

function pickMiraVoice() {
  if (!("speechSynthesis" in window)) {
    return null;
  }

  const voices = window.speechSynthesis.getVoices();
  const preferred = [
    (v) => v.lang === "en-IN" && /female|google/i.test(v.name),
    (v) => v.lang === "en-IN",
    (v) => /Google UK English Female/i.test(v.name),
    (v) => /Samantha|Karen|Moira|Veena/i.test(v.name),
    (v) => v.lang.startsWith("en")
  ];

  for (const test of preferred) {
    const match = voices.find(test);
    if (match) return match;
  }

  return null;
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    miraVoice = pickMiraVoice();
  };
  miraVoice = pickMiraVoice();
}

function speakAsMira(text, onDone) {
  if (!("speechSynthesis" in window) || !text) {
    if (typeof onDone === "function") onDone();
    return;
  }

  window.speechSynthesis.cancel();

  const parts = String(text).match(/[^.!?]+[.!?]*/g) || [String(text)];

  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part.trim());

    if (miraVoice) {
      utterance.voice = miraVoice;
      utterance.lang = miraVoice.lang;
    }

    utterance.rate = 1.05 + Math.random() * 0.12;
    utterance.pitch = 1.05;

    if (index === parts.length - 1 && typeof onDone === "function") {
      utterance.onend = onDone;
    }

    window.speechSynthesis.speak(utterance);
  });
}

function playThinkingSound() {
  if (!("speechSynthesis" in window)) {
    return;
  }

  const fillers = ["Hmm", "Haan", "Acha", "Wait"];

  if (Math.random() < 0.6) {
    const utterance = new SpeechSynthesisUtterance(
      fillers[Math.floor(Math.random() * fillers.length)]
    );
    if (miraVoice) {
      utterance.voice = miraVoice;
      utterance.lang = miraVoice.lang;
    }
    utterance.rate = 1.1;
    window.speechSynthesis.speak(utterance);
  }
}
