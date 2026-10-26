import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders } from './api';
import {
  addAudioWorklet,
  base64Pcm,
  CAPTURE_WORKLET,
  geminiSetupMessage,
  PLAYBACK_WORKLET,
  pcmBase64,
  type GeminiServerMessage,
} from './gemini-voice';
// A single failed control poll is usually a network flap, not a dead call.
// Only treat the control connection as lost after this many consecutive
// poll failures, mirroring the grace period #26 gives the peer connection.
const CONTROL_POLL_FAILURE_LIMIT = 3;
// One session shape with provider-specific optional fields so both the
// OpenAI Realtime WebRTC flow and the Gemini Live WebSocket flow share the
// transcript, control poll, and teardown paths.
type VoiceSession = {
  stream: MediaStream;
  transcript: string[];
  cancelled: boolean;
  id?: string;
  timer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  controlPollFailures: number;
  // OpenAI Realtime WebRTC flow.
  pc?: RTCPeerConnection;
  channel?: RTCDataChannel;
  audio?: HTMLAudioElement;
  // Gemini Live WebSocket flow.
  ws?: WebSocket;
  inputCtx?: AudioContext;
  outputCtx?: AudioContext;
  gain?: GainNode;
  spoken?: string;
};
export function useVoice(
  threadId: string,
  onSaved: () => void,
  anchorMessageId?: string,
) {
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'active' | 'ending'
  >('idle');
  const generation = useRef(0);
  const connecting = useRef(false);
  const ending = useRef(false);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [phase, setPhase] = useState<'listening' | 'speaking' | 'thinking'>(
    'listening',
  );
  const [caption, setCaption] = useState('');
  const [userCaption, setUserCaption] = useState('');
  const session = useRef<VoiceSession | undefined>(undefined);
  const anchor = useRef(anchorMessageId);
  anchor.current = anchorMessageId;
  const closeMedia = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;
    current.stream.getTracks().forEach((track) => track.stop());
    current.channel?.close();
    current.pc?.close();
    current.ws?.close();
    if (current.audio) {
      current.audio.pause();
      current.audio.srcObject = null;
    }
    void current.inputCtx?.close().catch(() => {});
    void current.outputCtx?.close().catch(() => {});
    clearTimeout(current.timer);
    clearTimeout(current.disconnectTimer);
  }, []);
  const end = useCallback(async () => {
    if (ending.current) return;
    generation.current++;
    connecting.current = false;
    const current = session.current;
    if (!current) {
      setStatus('idle');
      return;
    }
    // Silence the call immediately, while keeping the peer alive until the
    // provider confirms hangup through the server.
    current.cancelled = true;
    current.stream.getTracks().forEach((track) => {
      track.enabled = false;
    });
    current.audio?.pause();
    current.ws?.close();
    clearTimeout(current.timer);
    clearTimeout(current.disconnectTimer);
    ending.current = true;
    setStatus('ending');
    try {
      if (current.id)
        await api(`/voice/calls/${current.id}/end`, 'POST', {
          transcript: current.transcript.join('\n').slice(0, 20000),
          anchorMessageId: anchor.current,
        });
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Call ended, but its receipt could not be saved.',
      );
    } finally {
      closeMedia();
      session.current = undefined;
      ending.current = false;
      setStatus('idle');
    }
  }, [closeMedia, onSaved]);
  useEffect(
    () => () => {
      generation.current++;
      const current = session.current;
      closeMedia();
      if (current?.id && !ending.current)
        void fetch(`/api/voice/calls/${current.id}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            transcript: current.transcript.join('\n').slice(0, 20000),
            anchorMessageId: anchor.current,
          }),
          keepalive: true,
        }).catch(() => {});
    },
    [closeMedia],
  );
  useEffect(() => {
    if (status !== 'active' && status !== 'connecting') return;
    const timer = setInterval(() => {
      const current = session.current;
      const id = current?.id;
      if (id)
        void api<{ endedAt: number | null }>(`/voice/calls/${id}`)
          .then((call) => {
            if (session.current !== current) return;
            if (call.endedAt) {
              void end();
              return;
            }
            current.controlPollFailures = 0;
          })
          .catch(() => {
            if (session.current !== current) return;
            current.controlPollFailures += 1;
            if (current.controlPollFailures < CONTROL_POLL_FAILURE_LIMIT)
              return;
            setError('Call control connection was lost.');
            void end();
          });
    }, 2000);
    return () => clearInterval(timer);
  }, [status, closeMedia, onSaved, end]);
  const startGemini = async (attempt: number, stream: MediaStream) => {
    // The model answers with 24 kHz native audio; the capture worklet
    // decimates the microphone down to the 16 kHz Live API input format.
    const outputCtx = new AudioContext({ sampleRate: 24000 });
    const inputCtx = new AudioContext();
    let sessionId: string | undefined;
    try {
      await addAudioWorklet(inputCtx, CAPTURE_WORKLET);
      await addAudioWorklet(outputCtx, PLAYBACK_WORKLET);
      const capture = new AudioWorkletNode(inputCtx, 'opendots-pcm-capture', {
        numberOfOutputs: 0,
      });
      const playback = new AudioWorkletNode(
        outputCtx,
        'opendots-pcm-playback',
        {
          numberOfInputs: 0,
          outputChannelCount: [1],
        },
      );
      const gain = outputCtx.createGain();
      inputCtx.createMediaStreamSource(stream).connect(capture);
      playback.connect(gain);
      gain.connect(outputCtx.destination);
      const begin = await api<{
        id: string;
        provider: 'gemini';
        token: string;
        model: string;
        voice: string;
        instructions: string;
      }>('/voice/calls', 'POST', { threadId });
      if (attempt !== generation.current) {
        await api(`/voice/calls/${begin.id}/end`, 'POST', {
          transcript: '',
        }).catch(() => {});
        return;
      }
      sessionId = begin.id;
      await Promise.allSettled([inputCtx.resume(), outputCtx.resume()]);
      const ws = new WebSocket(
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(begin.token)}`,
      );
      ws.binaryType = 'arraybuffer';
      const frameText = new TextDecoder();
      const current: VoiceSession = {
        stream,
        transcript: [],
        cancelled: false,
        id: begin.id,
        controlPollFailures: 0,
        ws,
        inputCtx,
        outputCtx,
        gain,
      };
      session.current = current;
      const sendInputAudio = (samples: Float32Array) => {
        if (current.cancelled || ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: pcmBase64(samples),
                mimeType: 'audio/pcm;rate=16000',
              },
            },
          }),
        );
      };
      capture.port.onmessage = (event) => {
        if (current.cancelled) return;
        sendInputAudio(event.data as Float32Array);
      };
      const handleToolCall = (message: GeminiServerMessage) => {
        const calls = message.toolCall?.functionCalls ?? [];
        if (!calls.length || !current.id || current.cancelled) return;
        void (async () => {
          const responses: Array<{
            id: string;
            response: Record<string, unknown>;
          }> = [];
          for (const call of calls) {
            if (call.name !== 'ask_compute' || typeof call.id !== 'string')
              continue;
            setPhase('thinking');
            let output: string;
            try {
              const request = (call.args as { request?: unknown } | undefined)
                ?.request;
              if (typeof request !== 'string' || !request.trim())
                throw new Error('Invalid compute request.');
              const result = await api<{ text: string }>(
                `/voice/calls/${current.id}/compute`,
                'POST',
                {
                  toolCallId: call.id,
                  request,
                  transcript: current.transcript.join('\n').slice(-12000),
                },
              );
              output = result.text;
            } catch (e) {
              output = `Compute failed: ${e instanceof Error ? e.message : 'Unknown error'}`;
            }
            responses.push({ id: call.id, response: { result: output } });
          }
          if (
            !current.cancelled &&
            responses.length &&
            ws.readyState === WebSocket.OPEN
          )
            ws.send(
              JSON.stringify({
                toolResponse: {
                  functionResponses: responses.map(({ id, response }) => ({
                    id,
                    name: 'ask_compute',
                    response,
                  })),
                },
              }),
            );
        })();
      };
      ws.onopen = () => {
        if (current.cancelled) return;
        ws.send(
          geminiSetupMessage(begin.model, begin.voice, begin.instructions),
        );
      };
      ws.onmessage = (event) => {
        if (current.cancelled) return;
        let message: GeminiServerMessage;
        try {
          const raw =
            typeof event.data === 'string'
              ? event.data
              : frameText.decode(new Uint8Array(event.data));
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object') return;
          message = parsed as GeminiServerMessage;
        } catch {
          return;
        }
        if (message.setupComplete) {
          setStatus('active');
          setStartedAt((value) => value ?? Date.now());
          void api(`/voice/calls/${current.id}/active`, 'POST', {}).catch(
            (e) => {
              if (!current.cancelled) setError(e.message);
            },
          );
        }
        if (message.error)
          setError(
            'The voice provider reported a session error. End the call and retry.',
          );
        const content = message.serverContent;
        if (content) {
          if (content.interrupted) {
            setPhase('listening');
            setCaption('');
            current.spoken = '';
            playback.port.postMessage({ reset: true });
          }
          for (const part of content.modelTurn?.parts ?? []) {
            const audio = part.inlineData?.data;
            if (!audio) continue;
            setPhase('speaking');
            playback.port.postMessage({ samples: base64Pcm(audio) });
          }
          const heard = content.inputTranscription?.text;
          if (heard) {
            setCaption('');
            setUserCaption(heard);
            if (
              heard !==
              current.transcript[current.transcript.length - 1]?.slice(5)
            )
              current.transcript.push(`You: ${heard}`);
          }
          const spoken = content.outputTranscription?.text;
          if (spoken) {
            current.spoken = (current.spoken ?? '') + spoken;
            setPhase('speaking');
            setCaption(current.spoken);
          }
          if (content.turnComplete) {
            setPhase('listening');
            if (current.spoken) {
              current.transcript.push(`Dot: ${current.spoken}`);
              current.spoken = '';
            }
            setCaption('');
          }
        }
        handleToolCall(message);
      };
      ws.onerror = () => {
        if (current.cancelled || session.current !== current) return;
        setError(
          'The voice provider reported a session error. End the call and retry.',
        );
      };
      ws.onclose = () => {
        if (current.cancelled || session.current !== current) return;
        setError('The voice connection dropped.');
        void end();
      };
      current.timer = setTimeout(() => void end(), 15 * 60_000);
    } catch (e) {
      if (attempt !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        void inputCtx.close().catch(() => {});
        void outputCtx.close().catch(() => {});
        return;
      }
      const id = session.current?.id ?? sessionId;
      if (id)
        void api(`/voice/calls/${id}/end`, 'POST', {
          transcript: '',
          anchorMessageId: anchor.current,
        }).catch(() => {});
      stream.getTracks().forEach((track) => track.stop());
      void inputCtx.close().catch(() => {});
      void outputCtx.close().catch(() => {});
      closeMedia();
      session.current = undefined;
      setStatus('idle');
      setError(e instanceof Error ? e.message : 'Could not connect the call.');
    } finally {
      if (attempt === generation.current) connecting.current = false;
    }
  };
  const start = async () => {
    if (session.current || connecting.current || ending.current) return;
    connecting.current = true;
    const attempt = ++generation.current;
    setStatus('connecting');
    setError('');
    setMuted(false);
    setSpeakerMuted(false);
    setStartedAt(undefined);
    setPhase('listening');
    setCaption('');
    setUserCaption('');
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const detected = await api<{ provider: 'openai' | 'gemini' }>(
        '/voice/provider',
      );
      if (attempt !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (detected.provider === 'gemini') {
        await startGemini(attempt, stream);
        return;
      }
      const pc = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      const channel = pc.createDataChannel('oai-events');
      const current = {
        pc,
        audio,
        stream,
        channel,
        transcript: [] as string[],
        cancelled: false,
        id: undefined as string | undefined,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
        controlPollFailures: 0,
        disconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      session.current = current;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream!));
      pc.ontrack = (event) => {
        if (current.cancelled) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => {
          if (!current.cancelled)
            setError(
              'Audio playback was blocked. Check your browser audio permissions.',
            );
        });
      };
      pc.onconnectionstatechange = () => {
        if (current.cancelled) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(current.disconnectTimer);
          current.disconnectTimer = undefined;
          setStatus('active');
          setStartedAt((value) => value ?? Date.now());
          if (current.id)
            void api(`/voice/calls/${current.id}/active`, 'POST', {}).catch(
              (e) => {
                if (!current.cancelled) setError(e.message);
              },
            );
        }
        if (pc.connectionState === 'disconnected' && !current.disconnectTimer) {
          current.disconnectTimer = setTimeout(() => {
            current.disconnectTimer = undefined;
            if (current.cancelled || pc.connectionState !== 'disconnected')
              return;
            setError('The voice connection dropped.');
            void end();
          }, 5000);
        }
        if (pc.connectionState === 'failed') {
          setError('The voice connection dropped.');
          void end();
        }
      };
      channel.onmessage = async (event) => {
        if (current.cancelled) return;
        let data: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(String(event.data));
          if (!parsed || typeof parsed !== 'object') return;
          data = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        if (data.type === 'input_audio_buffer.speech_started') {
          setPhase('listening');
          setCaption('');
        }
        if (
          data.type === 'response.output_audio_transcript.delta' &&
          typeof data.delta === 'string'
        ) {
          setPhase('speaking');
          setCaption((text) => text + data.delta);
        }
        if (data.type === 'output_audio_buffer.stopped') setPhase('listening');
        if (data.type === 'response.created') {
          setCaption('');
          setPhase('thinking');
        }
        if (typeof data.transcript === 'string') {
          if (
            data.type ===
            'conversation.item.input_audio_transcription.completed'
          ) {
            current.transcript.push(`You: ${data.transcript}`);
            setUserCaption(data.transcript);
          }
          if (data.type === 'response.output_audio_transcript.done')
            current.transcript.push(`Dot: ${data.transcript}`);
        }
        if (data.type === 'error')
          setError(
            'The voice provider reported a session error. End the call and retry.',
          );
        if (
          data.type !== 'response.function_call_arguments.done' ||
          data.name !== 'ask_compute' ||
          typeof data.call_id !== 'string' ||
          !current.id
        )
          return;
        let output: string;
        setPhase('thinking');
        try {
          const args: unknown = JSON.parse(String(data.arguments));
          if (
            !args ||
            typeof args !== 'object' ||
            !('request' in args) ||
            typeof args.request !== 'string'
          )
            throw new Error('Invalid compute request.');
          const result = await api<{ text: string }>(
            `/voice/calls/${current.id}/compute`,
            'POST',
            {
              toolCallId: data.call_id,
              request: args.request,
              transcript: current.transcript.join('\n').slice(-12000),
            },
          );
          output = result.text;
        } catch (e) {
          output = `Compute failed: ${e instanceof Error ? e.message : 'Unknown error'}`;
        }
        if (!current.cancelled && channel.readyState === 'open') {
          channel.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: data.call_id,
                output,
              },
            }),
          );
          channel.send(JSON.stringify({ type: 'response.create' }));
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await api<{ id: string; sdp: string }>(
        '/voice/calls',
        'POST',
        { threadId, sdp: offer.sdp },
      );
      current.id = response.id;
      if (current.cancelled) {
        await api(`/voice/calls/${response.id}/end`, 'POST', {
          transcript: '',
        });
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: response.sdp });
      if (current.cancelled) return;
      current.timer = setTimeout(() => void end(), 15 * 60_000);
    } catch (e) {
      if (attempt !== generation.current) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      const current = session.current;
      const id = current?.id;
      if (id)
        void api(`/voice/calls/${id}/end`, 'POST', {
          transcript: '',
          anchorMessageId: anchor.current,
        }).catch(() => {});
      stream?.getTracks().forEach((track) => track.stop());
      closeMedia();
      session.current = undefined;
      setStatus('idle');
      setError(e instanceof Error ? e.message : 'Could not connect the call.');
    } finally {
      if (attempt === generation.current) connecting.current = false;
    }
  };
  const toggleMute = () => {
    const next = !muted;
    session.current?.stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  };
  const toggleSpeaker = () => {
    const next = !speakerMuted;
    const current = session.current;
    if (current?.gain) current.gain.gain.value = next ? 0 : 1;
    else if (current?.audio) current.audio.muted = next;
    setSpeakerMuted(next);
  };
  return {
    status,
    error,
    start,
    end,
    muted,
    speakerMuted,
    startedAt,
    phase,
    caption,
    userCaption,
    toggleMute,
    toggleSpeaker,
  };
}
