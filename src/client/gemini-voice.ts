// Gemini Live (BidiGenerateContent) helpers for voice calls.
//
// The browser talks to Google directly over WebSocket while the server holds
// the API key and only provisions a short-lived ephemeral token. Audio runs
// through two AudioWorklets: microphone decimation to 16 kHz PCM16 input
// chunks, and 24 kHz PCM16 playback of the model's native audio turns.

export type GeminiFunctionCall = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

export type GeminiServerMessage = {
  setupComplete?: Record<string, never>;
  goAway?: { timeLeft?: string };
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    modelTurn?: {
      parts?: Array<{ inlineData?: { data?: string } }>;
    };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: { functionCalls?: GeminiFunctionCall[] };
  error?: { message?: string };
};

export const CAPTURE_WORKLET = /* JavaScript */ `
class OpenDotsPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Decimate the device rate down to the 16 kHz Live API input format.
    this.step = Math.max(1, sampleRate / 16000);
    this.carry = 0;
    this.chunk = new Float32Array(1280); // 80 ms per chunk at 16 kHz.
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let index = 0;
    while (index < channel.length) {
      this.carry += this.step;
      const need = Math.min(Math.floor(this.carry), channel.length - index);
      if (need < 1) break;
      let total = 0;
      for (let i = index; i < index + need; i++) total += channel[i];
      this.chunk[this.filled++] = total / need;
      this.carry -= need;
      index += need;
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('opendots-pcm-capture', OpenDotsPcmCapture);
`;

export const PLAYBACK_WORKLET = /* JavaScript */ `
class OpenDotsPcmPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.samples) this.queue.push(data.samples);
      else if (data && data.reset) {
        this.queue.length = 0;
        this.offset = 0;
      }
    };
  }
  process(inputs, outputs) {
    const channels = outputs[0];
    const out = channels[0];
    let written = 0;
    while (written < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      const copy = Math.min(head.length - this.offset, out.length - written);
      out.set(head.subarray(this.offset, this.offset + copy), written);
      this.offset += copy;
      written += copy;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    for (let i = written; i < out.length; i++) out[i] = 0;
    for (let c = 1; c < channels.length; c++) channels[c].set(out);
    return true;
  }
}
registerProcessor('opendots-pcm-playback', OpenDotsPcmPlayback);
`;

export async function addAudioWorklet(
  context: AudioContext,
  source: string,
): Promise<void> {
  const url = URL.createObjectURL(
    new Blob([source], { type: 'text/javascript' }),
  );
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Encodes a float block as 16 kHz little-endian PCM16 base64. */
export function pcmBase64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block)
    binary += String.fromCharCode(...bytes.subarray(i, i + block));
  return btoa(binary);
}

/** Decodes base64 24 kHz PCM16 model audio to float samples. */
export function base64Pcm(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
  return samples;
}

export function geminiSetupMessage(
  model: string,
  voice: string,
  instructions: string,
): string {
  return JSON.stringify({
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
      systemInstruction: { parts: [{ text: instructions }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'ask_compute',
              description:
                'Ask the authorized specialist compute agent to research or reason in this same persistent conversation.',
              parameters: {
                type: 'OBJECT',
                properties: { request: { type: 'STRING' } },
                required: ['request'],
              },
            },
          ],
        },
      ],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: {},
    },
  });
}
