// The Gemini Live prebuilt studio voices, as exposed by the
// `prebuiltVoiceConfig.voiceName` setup field and the /v1beta/voices listing.
export type GeminiVoice = {
  name: string;
  gender: 'female' | 'male';
  tag: string;
};
export const GEMINI_VOICES: GeminiVoice[] = [
  { name: 'Zephyr', gender: 'female', tag: 'Bright' },
  { name: 'Kore', gender: 'female', tag: 'Firm' },
  { name: 'Leda', gender: 'female', tag: 'Youthful' },
  { name: 'Aoede', gender: 'female', tag: 'Breezy' },
  { name: 'Callirrhoe', gender: 'female', tag: 'Easy-going' },
  { name: 'Autonoe', gender: 'female', tag: 'Bright' },
  { name: 'Achernar', gender: 'female', tag: 'Soft' },
  { name: 'Charon', gender: 'male', tag: 'Informative' },
  { name: 'Puck', gender: 'male', tag: 'Upbeat' },
  { name: 'Fenrir', gender: 'male', tag: 'Excitable' },
  { name: 'Orus', gender: 'male', tag: 'Firm' },
  { name: 'Iapetus', gender: 'male', tag: 'Clear' },
  { name: 'Umbriel', gender: 'male', tag: 'Easy-going' },
  { name: 'Algieba', gender: 'male', tag: 'Smooth' },
  { name: 'Algenib', gender: 'male', tag: 'Gravelly' },
  { name: 'Rasalgethi', gender: 'male', tag: 'Informative' },
  { name: 'Laomedeia', gender: 'female', tag: 'Upbeat' },
  { name: 'Alnilam', gender: 'male', tag: 'Firm' },
  { name: 'Schedar', gender: 'female', tag: 'Even' },
  { name: 'Gacrux', gender: 'female', tag: 'Mature' },
  { name: 'Pulcherrima', gender: 'female', tag: 'Forward' },
  { name: 'Achird', gender: 'male', tag: 'Friendly' },
  { name: 'Zubenelgenubi', gender: 'male', tag: 'Casual' },
  { name: 'Vindemiatrix', gender: 'female', tag: 'Gentle' },
  { name: 'Sadachbia', gender: 'female', tag: 'Lively' },
  { name: 'Sadaltager', gender: 'male', tag: 'Knowledgeable' },
  { name: 'Sulafat', gender: 'female', tag: 'Warm' },
  { name: 'Enceladus', gender: 'female', tag: 'Breathy' },
  { name: 'Despina', gender: 'female', tag: 'Smooth' },
  { name: 'Erinome', gender: 'female', tag: 'Clear' },
];
export const GEMINI_VOICE_NAMES = GEMINI_VOICES.map((voice) => voice.name);
export const GEMINI_VOICE_SET = new Set(GEMINI_VOICE_NAMES);
