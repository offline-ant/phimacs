# @phimacs/sound

Explicitly configured dictation, speech transcription, text-to-speech and
notifications. Dictation is English 16 kHz mono signed 16-bit little-endian PCM;
no backend fallback. Installation does not enable dictation or speech, access a
microphone or discover devices; credentials are read only when a configured
speech backend names a Pi provider.

## Configuration

Missing `<agentDir>/voice.json` means disabled, type mode. Malformed settings are
an error. Writes are atomic and private (0600; newly created directory 0700).

```json
{
  "backend": "local",
  "options": { "url": "http://127.0.0.1:8090", "model": "whisper-1" },
  "mode": "type",
  "capture": {
    "command": "parecord",
    "args": ["--raw", "--rate=16000", "--channels=1", "--format=s16le"]
  }
}
```

The example capture command is opt-in: supply an executable installed on your
machine or omit capture when the caller supplies audio. No shell interprets argv.
Instead of `capture`, `"share": true` selects the devices that remote machines
share with this host (see [device sharing](#device-sharing)) for the microphone,
speaker and notifications; `share` and `capture` are exclusive.
Local options: explicit credential-free HTTP(S) base `url`, optional `model`,
`timeoutMs` and explicitly supplied string `headers`. Options are backend-specific
and strictly validated before capture. No status command prints backend options.

Optional `sendWord`, `clearWord` and `sendWordMs` are described under the dictation protocol below. Optional
`dictatedFormat` (string containing `%s` exactly once, default `"(dictated) %s"`,
`"%s"` for none) wraps dictated text the frontends put into Pi input, `%s`
standing for the text, so the model can read a misheard word as a transcription
error; Emacs applies it only in buffers with a send command.

An optional `speech` section selects a text-to-speech backend; without it speech
is disabled. Dictation and speech settings are independent; each setter keeps
the other section.

```json
{
  "backend": null,
  "speech": {
    "backend": "openai-speech",
    "options": { "url": "https://api.openai.com", "model": "gpt-4o-mini-tts",
                 "voice": "marin", "authProvider": "openai" }
  }
}
```

`openai-speech` posts JSON `{model, input, voice, response_format, instructions?,
speed?}` to `<url>/v1/audio/speech`, as OpenAI and OpenAI-compatible local servers
accept. Options: credential-free HTTP(S) base `url`, `model` and `voice`; optional
default `instructions`, `speed` (0.25–4), `timeoutMs` (default 120000), string
`headers`, and `authProvider`, a Pi provider ID whose API key is resolved per
request and sent as a bearer token (omit it for local servers without a key; it
excludes an `Authorization` header). The CLI resolves keys as Pi does from
`<agentDir>/auth.json`, configured commands/variables or the provider's
environment variable; the extension uses its session's model registry. Keys are
never printed or stored. One request accepts at most 4096 characters. Error
messages never include server response bodies.

`command` runs a local synthesizer that writes 16-bit PCM WAV, without a shell,
once per request, such as Flite or eSpeak NG:

```json
{ "backend": "command", "options": { "command": "flite",
  "args": ["-voice", "{voice}", "-t", "{text}", "-o", "{output}"], "voice": "kal" } }
{ "backend": "command", "options": { "command": "espeak-ng",
  "args": ["-v", "{voice}", "--stdin", "--stdout"], "voice": "en+klatt" } }
```

Options: `command`, string `args`, `voice` (required exactly when an argument
contains `{voice}`) and optional `timeoutMs` (default 120000). Within each
argument `{text}`, `{voice}` and `{output}` are replaced in one pass. Without
`{text}` the text is written to standard input; `{output}` is a WAV path in a
private temporary directory, removed after the request, otherwise WAV is read
from standard output. A nonzero exit, output other than 16-bit PCM WAV, no
samples, delivery instructions or speed, and a voice override without
`{voice}` are errors; command stderr is ignored. One request accepts at most
4096 characters. Saved speech is encoded to Ogg Opus by `ffmpeg` (with
`libopus`) from `PATH`; playback needs no encoder.

## CLI

- `pi-sound dictate`: use explicitly configured capture or shared microphone.
- `pi-sound dictate --pcm FILE` or `--pcm -`: raw PCM file or standard input.
- `pi-sound mode [type|send|toggle]`: JSON mode, without selecting a backend.
- `pi-sound play done|request` and `notify TITLE [BODY]`: the composed output sink,
  else the shared devices that `share` selects; silent success when there is
  no output at all. Shared output without an answering device exits 1.
- `pi-sound share-dir`: create the [share directory](#device-sharing) if missing,
  verify it and print its path.
- `pi-sound speak [--voice V] [--instructions I] [--out FILE | --play] (TEXT|-)`:
  synthesize TEXT, or standard input with `-`, using the configured speech backend.

Without `--play`, speak saves one Ogg Opus file and prints one JSON line `{type:
"speech", path, mediaType, bytes, backend, voice}`. Text over the backend limit is
an error, never truncated. `--out` names the file; otherwise it is a new file in
`${XDG_RUNTIME_DIR:-$TMPDIR}/pi-speech-<uid>/` (directory 0700). Files are
created exclusively (0600) before the request, never replace existing files and
are removed again when synthesis fails; nothing deletes saved files later.

`--play` speaks text of any length on the output sink and prints `{type:
"played", backend, device, chunks}`. It first probes the sink with zero samples and
fails before any request when no device is connected. Text is split into sentence
chunks of at most 500 characters, each requested as WAV, mixed to mono and
resampled linearly to the 44.1 kHz speaker format; the next chunk is synthesized
while one plays, and each is sent when the previous one should have finished
(timed from its sending, since a sink such as the shared speaker may settle only
after playing). Cancellation stops further synthesis and sending; audio already
sent plays out.
Speak errors exit 1 (`pi-sound: message` on stderr; silent on a signal), usage
errors 2.

Dictation prints JSON lines: `ready` (device, backend, mode, dictatedFormat), any `partial` previews,
then exactly one `final` (text, optional limited, send and clear) or `error` (message).
A transcript ending in the send word (setting `sendWord`, default `"send"`, a word
or phrase; `""` for none), then only punctuation, gets `send: true`
and its text omits the word; frontends submit it in either mode.
A transcript ending in the clear word (setting `clearWord`, default `"clear stop"`,
matched like the send word; a phrase, since transcription tends to merge a
repeated single word; `""` for none) gets `{type: "final", text: "", clear: true}`
instead, also after a send word; frontends discard it: nothing is inserted,
submitted or saved, in either mode.
After speech, recording stops by itself when no newer partial arrives within
`sendWordMs` (setting, positive milliseconds, default 1000) of one ending in the
send or clear word, or four seconds of any other (its final gets `send: true`);
backends without partials stop only explicitly.
`--send-word W` and `--clear-word W` replace the words and `--pause-ms N` the four
seconds for one recording; `""` and `0` disable them, so a frontend whose target
cannot submit records until it stops and keeps a trailing send word. Standard
input EOF stops external capture; PCM stdin EOF ends the audio. SIGINT/SIGTERM/
SIGHUP cancel without a terminal line. Dictation exits 0; other command errors
exit 1 and usage errors 2. No audio is stored. Maximum audio is five minutes;
15 seconds without audio fails. Odd partial samples are joined; trailing half
samples are discarded.

## Device sharing

Protocol v1 lets the machine you sit at lend its microphone, speaker and
desktop notifications to the host that runs Pi and Emacs, over SSH. This package
implements the host side; a device client forwards its sockets.

- **Share directory:** `PHIMACS_SHARE_DIR` if non-empty (it must be absolute),
  else `/tmp/phimacs-share-<uid>`, lexically normalized (`.`, `..`, repeated and
  trailing slashes) before any check, so `link/.` or `link/` cannot make the check
  follow a symbolic link; checks and socket paths use that same path. The root
  launcher's `share-host` applies the same rule. Without following a symbolic link, it must be a directory owned by the user
  whose permission bits are exactly 0700 (other bits such as setgid are allowed);
  anything else is refused. `pi-sound share-dir` creates missing parents and the
  directory itself with mode 0700, like `mkdir -p` then `mkdir -m 700`.
- **Device connections:** each connection picks `id = <device>-<random>`, the
  device being its short host name reduced to `[A-Za-z0-9_-]`. One `ssh -N -R`
  creates `<id>.mic.sock`, `<id>.speaker.sock` and `<id>.notify.sock` there.
  Status and results name the device without the random part.
- **mic:** for each connection the device streams raw s16le 16 kHz mono PCM
  until the host closes it.
- **speaker:** the host writes raw s16le 44.1 kHz mono and closes its write side;
  the device reads to EOF and plays the buffered audio to its end.
- **notify:** the host writes a UTF-8 title line, an optional body and EOF; the
  device reads to EOF and shows a desktop notification.
- **Status line:** after its player or notifier child exits, a speaker or notify
  device writes exactly one ASCII line on the same connection, `ok\n` for exit 0,
  else `error <exit code>\n`, then closes. The host succeeds only on `ok`;
  `error N` fails as `Shared <kind> device <name> failed: player exited N` (or
  `notifier exited N`). EOF without a status line fails as uncertain delivery,
  and any other reply as an invalid status line.
- **Delivery:** a delivery settles at that status and close. A device that closes
  without reading (an accepted forward whose device listener is gone) resets the
  connection; that, a write error and no close within the audio's duration plus
  10 seconds are errors. A speaker probe sends one silent sample and needs its
  status too, so speech is never synthesized for a device that cannot play.
  Cancelling before anything was written closes the connection; afterwards it
  stops waiting without cutting audio already sent.
- **Selection:** per kind, the newest socket (modification time) that accepts a
  connection wins. With `share` selected there is no fallback to local devices:
  no answering device is an error naming the directory.
- **Cleanup:** nobody removes another connection's sockets, except that the host
  prunes a socket that refuses connections and is older than 60 seconds, since a
  younger one can be between bind and listen. After the refused connection it
  checks that the file still has the same inode and modification time before
  removing it. A device removes only its own `id`'s sockets on exit.

The Pi extension and the CLI resolve the directory when they use a device, so Pi
(through its runtime service), Emacs and the device client must agree on
`PHIMACS_SHARE_DIR`. Emacs deck notifications run the CLI, so they need no
other configuration.

## Explicit composition

`createSoundRuntime` accepts a per-runtime `BackendRegistry`, optional
`CaptureSource`, optional `OutputSink`, and optional settings reader. Register an
arbitrary backend ID using `register(id, {validate, open})`. Opening receives
validated options, transcript/error callbacks and an AbortSignal, and must resolve
only when ready. A transcriber accepts `write(Buffer)`, `finish():Promise<string>`
and idempotent `close()`. Cancellation must release opening/streaming resources.

`transcriberFor(setting, registry)` validates synchronously, then returns an async
`OpenTranscriber(events, signal)` resolving `{backend, transcriber}`.
`configuredTranscriber(agentDir, runtime?)` reads settings for every utterance.
Callers can supply PCM directly to that transcriber without a microphone/capture
driver. `startDictation` coordinates a transcriber and capture source with limits,
cancellation, readiness and exactly-once completion.
`captureFor(setting, runtime)` and `outputFor(setting, runtime)` return the
runtime's composed capture/output, else what the settings select (shared devices
or the capture command). `sharedCapture(dir?)` and `sharedOutput(dir?)` implement
the device-sharing host side on these interfaces; a missing directory argument
resolves the share directory per use. `connectDevice(dir, kind)` returns the
selected device socket or null. Unlike sinks that return null without a
destination, the shared output rejects when no device answers.
`OutputSink.play(pcm, signal?)` treats empty samples as a probe; the signal stops
waiting for a delivery. `sharedOutput(dir?, {closeGraceMs?})` selects the close grace.
`deliverToDevice(device, kind, data, {signal?, closeGraceMs?})` delivers to a socket
from `connectDevice` and waits for its status line; `normalizeShareDirectory`
applies the directory normalization.
There is no ambient registry singleton or private adapter discovery.

Speech follows the Vercel AI SDK's speech model shape. The runtime's
`SpeechRegistry` (default: `openai-speech` and `command`) registers `register(id, {validate,
create})`; `create(options, {credentials?})` constructs a `SpeechModel` without
network access. A model has `backend`, `maxInputLength` and `generate({text,
voice?, instructions?, speed?, format, signal})` resolving `{audio, mediaType,
format, voice?}`; `opus` is Ogg Opus. A `CredentialResolver(provider, signal)`
returns an API key or rejects; `runtime.credentials` overrides the frontend's
(`piCredentials(agentDir)` in the CLI, the session's model registry in the
extension). `speechFor(setting, runtime, credentials?)` validates before any
request; `saveSpeech` and `playSpeech` implement the CLI behaviour above, and
`speakableText` reduces Markdown (code blocks, links, tables, emphasis) to prose.

Composition entry points: `runCli(args, {runtime, agentDir, signal})` from
`@phimacs/sound/cli`, and `registerDictation(pi, {runtime, agentDir})` and
`registerSpeech(pi, {runtime, agentDir})` from `@phimacs/sound/extension`; its
default export registers both with one public runtime. Private/site adapters belong outside this package and are
explicitly imported by their own bootstrap. No private integration is bundled.

## Frontends

The opt-in Pi extension provides /dictate, Alt+V and /dictate-setting. Type mode
pastes at the TUI cursor and refuses RPC type insertion; send mode submits the
transcript, steering a busy agent. A `send` final submits in type mode too: the
text is pasted and the whole editor sent; a `clear` final pastes and sends
nothing. Session shutdown cancels the recording.
Backend setting arguments are an ID and optional JSON options object; disabled,
type, send and status are also available.

/speak TEXT speaks TEXT on the output sink; /speak alone speaks the text of the
latest assistant message on the branch, reduced by `speakableText`, or stops
speech in progress. Playback runs in the background with a `speech` status
(chunk/total and device); a new prompt, a new /speak and session shutdown cancel
it, and failures are notified. /speak-setting takes a registered speech backend ID
with a JSON options object, `disabled` or `status` (the backend only, never its
options); options are validated without credentials or network access.

The `speak` agent tool (`{text, voice?, instructions?}`) saves one Ogg Opus file
like `pi-sound speak` and returns its path, media type, size, backend and voice as
`details` and `structuredContent`; it does not play audio. It is registered with
`defaultActive: false`: enable it with /tools, `--tools` or `defaultTools`.
Other extensions consume the saved file through the tool result; text over the
backend limit is a tool error, so callers split longer text.

`emacs/pi-sound.el` uses the configurable `pi-sound-program`, supports
type/send, cancellation, header/mode-line buttons and optional deck notifications.
`emacs/pi-sound-target.el` decides where a recording goes when it starts:
`pi-sound-target-functions` (integrations such as Phimacs's Pilish inputs, editor
questions and inline questions), then the open minibuffer prompt, terminals and
shells (Ghostel, vterm, eat, term; comint and Eshell), then any buffer at point.
The live transcript shows there in the `pi-sound-partial` face as display-only
text until the final arrives. Text that cannot be delivered (read-only text, a
prompt or buffer gone meanwhile) goes to the kill ring. Targets that can submit
(prompts, terminals, integrations) do so in send mode or on a `send` final, after
any newer prompt closed; only they let the CLI stop by itself on the send word or
a pause (terminals on the send word only), elsewhere Emacs passes `--send-word ""
--pause-ms 0`. The clear word stops and discards everywhere, ordinary buffers and
`pi-sound-stop-and-send` included. While
recording, a target's submit command, such as RET in a prompt or Pilish's
`pilish-send` (also its ⏎ button), runs `pi-sound-stop-and-send` (stop, then
submit). Prompts normalize answers: `yes-or-no-p` takes yes/no, `y-or-n-p` a y/n
key, `completing-read` the candidate the text names. `dictatedFormat` applies to
all text except normalized answers and buffers in `pi-sound-unformatted-modes`
(terminals and shells by default). The global `pi-sound-mode` shows the state in
every mode line and a button after minibuffer prompts other than `y-or-n-p` and
`yes-or-no-p` questions; keys bound in
`pi-sound-mode-map` also work in prompts. `pi-sound-input-button-setup`, added to a
mode hook such as `pilish-input-mode-hook`, shows the button in three columns it
adds to the right margin (other margin buttons keep theirs) beside each input
window's first visible row, following its scrolling (🎤, red `REC`, `…`); clicking
it dictates into that input. `pi-sound-input-button` (default t) toggles margin
and button in every such buffer. Loading it installs no global keys/hooks. Configure
the CLI/capture/backend first and add desired UI bindings explicitly.

## Development and licenses

From the coordinated workspace: run the package check and compile scripts, focused
`node --test test/<name>.test.ts`, and
`emacs -Q --batch -L emacs -l emacs/pi-sound-test.el -f ert-run-tests-batch-and-exit`.
Its prompt tests need a display and are skipped in batch; run them with
`xvfb-run -a emacs -Q -L emacs -l emacs/pi-sound-test.el --eval '(run-at-time 0.5 nil (lambda () (kill-emacs (if (zerop (ert-stats-completed-unexpected (ert-run-tests-batch "pi-sound-prompt"))) 0 1))))'`
(the exit status is the result; output goes to `*Messages*`).
No test requires real accounts, microphones or paid services.
[npm packages](../../docs/development.md#npm-packages) covers tarballs and
installs; `emacs/` is also the `pi-sound` Emacs package.

Software preserves the original MIT grant in LICENSE. Notification sounds derive
from Herdr and retain the separate Apache-2.0 grant and conversion provenance in
`sounds/LICENSE-APACHE-2.0` and `sounds/NOTICE`.
