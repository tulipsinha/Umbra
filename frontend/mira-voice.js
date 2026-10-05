let miraVoice = null;

// Young, bright female voices first. The "Natural"/"Online" neural voices in
// Edge sound far more human than the older desktop voices, so try them first.
const MIRA_PREFERRED_VOICES = [
  /Microsoft (Ava|Emma|Jenny|Aria|Michelle).*(Natural|Online)/i,
  /Microsoft Neerja.*(Natural|Online)/i,
  /Microsoft (Sonia|Libby|Maisie|Natasha|Clara).*(Natural|Online)/i,
  /Google US English/i,
  /Google UK English Female/i,
  /Samantha|Karen|Moira|Tessa|Veena|Zira/i,
  /Ava|Emma|Jenny|Aria|Neerja|Sonia|Libby/i
];

const MIRA_MALE_VOICES =
  /\b(male|David|Mark|Guy|Ravi|Prabhat|Ryan|Thomas|George|Daniel|Alex|Fred|Christopher|Eric|Roger|Steffan|Brian|Andrew)\b/i;

// Base delivery: higher and quicker than a default assistant voice.
const MIRA_BASE_PITCH = 1.35;
const MIRA_BASE_RATE = 1.08;

function pickMiraVoice() {
  if (!("speechSynthesis" in window)) {
    return null;
  }

  const voices = window.speechSynthesis
    .getVoices()
    .filter((voice) => /^en[-_]/i.test(voice.lang));

  for (const name of MIRA_PREFERRED_VOICES) {
    const match = voices.find((voice) => name.test(voice.name));
    if (match) return match;
  }

  const female = voices.filter((voice) => !MIRA_MALE_VOICES.test(voice.name));
  return (
    female.find((voice) => /^en-IN/i.test(voice.lang)) ||
    female[0] ||
    voices[0] ||
    null
  );
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    miraVoice = pickMiraVoice();
  });
  miraVoice = pickMiraVoice();
}

// Friends don't speak in one flat tone: exclamations jump up, questions lift
// a little, and small reactions ("omg", "arre", "haha") come out extra bright.
function miraProsodyFor(sentence) {
  let pitch = MIRA_BASE_PITCH;
  let rate = MIRA_BASE_RATE;

  if (/!\s*$/.test(sentence)) {
    pitch += 0.15;
    rate += 0.06;
  } else if (/\?\s*$/.test(sentence)) {
    pitch += 0.08;
  }

  if (/^\s*(omg|oh my god|arre|haha+|yay|oh|ooh|wait|no way|yaar)\b/i.test(sentence)) {
    pitch += 0.1;
    rate += 0.04;
  }

  // A little natural wobble so repeated lines don't sound copy-pasted.
  pitch += (Math.random() - 0.5) * 0.08;
  rate += (Math.random() - 0.5) * 0.04;

  return {
    pitch: Math.min(2, Math.max(0.5, pitch)),
    rate: Math.min(1.4, Math.max(0.7, rate))
  };
}

function makeMiraUtterance(sentence) {
  const utterance = new SpeechSynthesisUtterance(sentence);

  if (miraVoice) {
    utterance.voice = miraVoice;
    utterance.lang = miraVoice.lang;
  }

  const { pitch, rate } = miraProsodyFor(sentence);
  utterance.pitch = pitch;
  utterance.rate = rate;
  utterance.volume = 1;

  return utterance;
}

function speakAsMira(text, onDone) {
  if (!("speechSynthesis" in window) || !text) {
    if (typeof onDone === "function") onDone();
    return;
  }

  window.speechSynthesis.cancel();

  const parts = (String(text).match(/[^.!?]+[.!?]*/g) || [String(text)])
    .map((part) => part.trim())
    .filter(Boolean);
  miraVoice = pickMiraVoice();

  parts.forEach((part, index) => {
    const utterance = makeMiraUtterance(part);

    if (index === parts.length - 1 && typeof onDone === "function") {
      utterance.onend = onDone;
      utterance.onerror = onDone;
    }

    window.speechSynthesis.speak(utterance);
  });
}

function playThinkingSound() {
  if (!("speechSynthesis" in window)) {
    return;
  }

  const fillers = ["Hmm", "Haan", "Acha", "Wait wait", "Ooh"];

  if (Math.random() < 0.6) {
    miraVoice = pickMiraVoice();
    window.speechSynthesis.speak(
      makeMiraUtterance(fillers[Math.floor(Math.random() * fillers.length)])
    );
  }
}
