# Real conversations (phone and voice)

NOVA can hold a spoken conversation: she listens, understands, answers in natural sentences while she is still writing, and you can
interrupt her. The first transport is the phone: call **700** from a Linphone toestel, or have NOVA call you. It is **off by default**.
Code: `apps/api/src/conversation/`.

## How it works

`caller audio → voice-activity detection → speech-to-text (OmniRoute) → NOVA's normal chat pipeline (streaming) → sentence chunks → text-to-speech → audio back`.

- **Turn-taking:** an utterance ends after 800 ms of silence. Speech while NOVA talks interrupts her (barge-in); a longer burst (300 ms) is
  required then, so her own voice leaking back through the line does not cut her off.
- **Natural pace:** the first sentence is spoken as soon as it is complete; a short filler ("Even kijken.") is said when a tool runs or the model
  takes longer than 2.5 s. Markdown, links and code are never read aloud.
- **Hanging up:** goodbye phrases ("tot ziens", "doei"), silence ("Ben je er nog?", then hang up), a maximum duration (default 10 min, setting)
  and `#`/`*` on the keypad.
- **Chat pipeline:** the same orchestrator as typed chat (session memory, persona, tools), with `inputMode: "voice"` and **read-only tools only**.
  Anything that needs a confirmation on screen is refused over the phone ("Dat moet je op het scherm bevestigen").
- **One call at a time** (a second caller hears that NOVA is busy) to protect the free model quotas. Only metadata is audited (no transcripts).

## Setup

1. **Speech-to-text.** NOVA never calls a speech provider directly; it goes through OmniRoute like every model, fail-closed. Set
   `NOVA_STT_MODEL` and `NOVA_STT_FREE_VERIFIED=true`. The model must be inside the verified free key scope of the OmniRoute key, otherwise nothing is sent.
   - `NOVA_STT_MODE=transcriptions` (default): `/v1/audio/transcriptions`, for a Whisper model such as `cloudflare/@cf/openai/whisper-large-v3-turbo`
     (fast, recommended). Today's key does **not** allow any transcription model, so you must add one to the key scope and the free policy in OmniRoute
     first (the same procedure as the embedding model).
   - `NOVA_STT_MODE=chat-audio`: an audio-capable chat model, for example `gemini/gemini-3.1-flash-lite`. It works with the current key but was measured at about 12 s
     for a two-second utterance, which is too slow for conversation.
2. **Settings → Gesprekken:** switch on, pick language and greeting. Also switch on **Telefonie** (Asterisk) so extension 700 exists.
3. Asterisk reaches NOVA over **AudioSocket**: `NOVA_AUDIOSOCKET_HOST` (what Asterisk dials; default `nova`), `NOVA_AUDIOSOCKET_PORT` (8093),
   `NOVA_AUDIOSOCKET_BIND` (default `0.0.0.0`; do not publish this port). A connection is accepted only from a private address and only when its first
   frame carries a secret UUID that NOVA generated into the dialplan.
4. With conversations on, extension 700 is `Answer(); AudioSocket(...)`. The earlier short notice and alert remain when it is off.

## Linphone and the SIP trunk

Your Linphone account (`gebruiker@sip.linphone.org`) lives at Linphone's server, not on NOVA's PBX. To reach NOVA from anywhere, and for NOVA to call you:

1. Create a **second** Linphone account for NOVA (free at linphone.org) and enter it as the SIP trunk in Settings → Telefonie (host `sip.linphone.org`, its username and password; the password is stored locally, mode 0600).
2. Add yourself under **Contacten**: name, `gebruiker@sip.linphone.org`, and optionally "Mag met NOVA praten".
3. Then: "Nova, bel mij en vertel dat de was klaar is" (`phone_call`, always a fresh confirmation for external contacts) or, with `conversation: true`, NOVA
   calls and talks with you. A contact with "Mag met NOVA praten" who calls NOVA's Linphone address goes straight into a conversation; any other caller only raises an alert and rings the configured phones.
   Contacts must live on the trunk's domain.

## Tests

`npm -w apps/api test -- test/conversation test/telephony`: segmenter, chunker, STT gating, session behaviour (barge-in, echo, idle, failures), the AudioSocket protocol over real TCP,
the dialplan and contacts. `NOVA_TEST_ASTERISK=1` additionally starts a real Asterisk 22 container that dials extension 700 into NOVA over AudioSocket
(`test/conversation/real-asterisk.test.ts`; speech-to-text and the model are fakes in that test).

## Not covered

No real two-way call over a SIP phone or Linphone app has been made; no real speech-to-text model is enabled yet; noise handling is energy based (no neural VAD);
the browser microphone path still uses the browser's own recognition (the session code is transport-agnostic, a WebSocket transport is the next step).
