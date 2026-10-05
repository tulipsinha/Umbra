let miraVoice = null;

function pickMiraVoice() {
  if (!("speechSynthesis" in window)) {
    return null;
  }

  const voices = window.speechSynthesis.getVoices();
  const preferredNames = [
    /Microsoft Jenny/i,
    /Microsoft Aria/i,
    /Microsoft Ava/i,
    /Microsoft Sonia/i,
    /Microsoft Libby/i,
    /Google UK English Female/i,
    /Samantha|Karen|Moira|Veena|Zira/i,
    /Jenny|Aria|Ava|Sonia|Libby/i
  ];

  for (const name of preferredNames) {
    const match = voices.find((voice) =>
      name.test(voice.name) && /^en[-_]/i.test(voice.lang)
    );
    if (match) return match;
  }

  return (
    voices.find((voice) => /^en-IN/i.test(voice.lang)) ||
    voices.find((voice) => /^en[-_]/i.test(voice.lang)) ||
    null
  );
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
  miraVoice = pickMiraVoice();

  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part.trim());

    if (miraVoice) {
      utterance.voice = miraVoice;
      utterance.lang = miraVoice.lang;
    }

    utterance.rate = 0.94;
    utterance.pitch = 1.1;

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
    miraVoice = pickMiraVoice();
    if (miraVoice) {
      utterance.voice = miraVoice;
      utterance.lang = miraVoice.lang;
    }
    utterance.rate = 0.96;
    utterance.pitch = 1.1;
    window.speechSynthesis.speak(utterance);
  }
}
