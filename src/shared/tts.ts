// Shared TTS (text-to-speech) types, the curated Piper voice catalog, and the
// pure Piper phoneme→id logic. Like the rest of `src/shared`, this file must stay
// free of any node/electron imports — it is loaded by the renderer too.
//
// Sibyl speaks AI responses with on-device neural voices (Piper). A voice is a
// VITS ONNX model + a tiny JSON config, downloaded from Hugging Face's
// `rhasspy/piper-voices` repo and synthesized locally in the main process; the
// resulting audio is streamed to the renderer for Web Audio playback. No
// conversation text or audio ever leaves the machine (see CLAUDE.md → Privacy).

export type TtsVoiceQuality = 'low' | 'medium' | 'high'

/** A Piper voice offered in the built-in catalog (not necessarily installed). */
export interface TtsVoice {
  /** Stable id, also the Piper voice key, e.g. "en_US-amy-medium". */
  id: string
  /** Display name, e.g. "Amy". */
  name: string
  /** Human language label, e.g. "English (US)". */
  language: string
  quality: TtsVoiceQuality
  gender?: 'female' | 'male'
  /** Path of the `.onnx` model within the piper-voices repo. */
  modelPath: string
  /** Path of the `.onnx.json` config within the piper-voices repo. */
  configPath: string
  /** Approximate download size of the model in bytes (config is negligible). */
  sizeBytes: number
  /** Reviewed SHA-256 of the immutable model asset. */
  modelSha256: string
  /** Exact byte size and reviewed SHA-256 of the JSON config asset. */
  configSizeBytes: number
  configSha256: string
  /** One-line flavour note for the picker. */
  note?: string
}

/** Pure final integrity decision used by the streaming downloader and tests. */
export function voiceAssetIntegrityError(
  expectedBytes: number,
  expectedSha256: string,
  maxBytes: number,
  actualBytes: number,
  actualSha256: string
): string | null {
  if (expectedBytes > maxBytes || actualBytes > maxBytes) {
    return 'Voice asset exceeds the configured safety ceiling.'
  }
  if (actualBytes !== expectedBytes) {
    return 'Voice asset was truncated or had an unexpected size.'
  }
  if (actualSha256 !== expectedSha256) {
    return 'Voice asset failed SHA-256 verification.'
  }
  return null
}

/** A voice whose model files are downloaded and registered on disk. */
export interface InstalledVoice {
  id: string
  name: string
  language: string
  quality: TtsVoiceQuality
  /** Absolute path to the local `.onnx` model. */
  modelPath: string
  /** Absolute path to the local `.onnx.json` config. */
  configPath: string
  sizeBytes: number
  installedAt: string
}

/** User preferences for speech. Lives inside AppSettings. */
export interface TtsSettings {
  /** Master switch; speech controls only appear when on. */
  enabled: boolean
  /** Selected installed voice id, or null when none is chosen/installed. */
  voiceId: string | null
  /**
   * Speaking rate, where 1 = the voice's natural pace. Higher is faster. Mapped
   * to Piper's `length_scale` (= 1 / rate) at synthesis time.
   */
  rate: number
  /** Playback gain, 0..1. */
  volume: number
  /** Speak each assistant reply automatically as soon as it finishes generating. */
  autoSpeak: boolean
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false,
  voiceId: null,
  rate: 1,
  volume: 1,
  autoSpeak: false
}

/** Live progress of a voice model download (main → renderer). */
export interface TtsVoiceDownload {
  voiceId: string
  status: 'downloading' | 'completed' | 'error' | 'cancelled'
  receivedBytes: number
  totalBytes: number
  error?: string
}

/** A single snapshot of the speech subsystem's state (main → renderer). */
export interface TtsStatus {
  /**
   * Whether the on-device synth runtime (onnxruntime-node) loaded successfully.
   * False on a build/platform where the native module is missing — speech is
   * then disabled and the UI explains why.
   */
  available: boolean
  /** Why speech is unavailable, when `available` is false. */
  error?: string
  /** The message id currently being spoken, or null when idle. */
  speakingMessageId: string | null
  /** True while the CPU is synthesizing audio for the active request. */
  synthesizing: boolean
}

/**
 * Streaming synthesis events (main → renderer). One `speak` request produces a
 * `start`, then `chunk`s of audio as each sentence is synthesized, then `done`
 * (or `error`). `requestId` lets the renderer ignore chunks from a request that
 * was superseded by stop/replace; `pcm` is mono Float32 samples in [-1, 1].
 */
export type TtsEvent =
  | { type: 'start'; requestId: string; messageId: string; sampleRate: number }
  | {
      type: 'chunk'
      requestId: string
      messageId: string
      /** Monotonic chunk index within the request, for ordered playback. */
      seq: number
      sampleRate: number
      /** ArrayBuffer backing a Float32Array of mono samples. */
      pcm: ArrayBuffer
    }
  | { type: 'done'; requestId: string; messageId: string }
  | { type: 'error'; requestId: string; messageId: string; error: string }

// ---------------------------------------------------------------------------
// Piper voice config + phoneme→id (pure; unit-tested in tts.test.ts)
// ---------------------------------------------------------------------------

/** The subset of a Piper `.onnx.json` we read to drive synthesis. */
export interface PiperVoiceConfig {
  audio: { sample_rate: number; quality?: string }
  espeak?: { voice: string }
  inference: { noise_scale: number; length_scale: number; noise_w: number }
  /** Maps a phoneme symbol → its model token id(s). */
  phoneme_id_map: Record<string, number[]>
  /** "espeak" (IPA, the default) or "text" (raw characters). */
  phoneme_type?: 'espeak' | 'text'
  num_speakers: number
  speaker_id_map?: Record<string, number>
}

// Piper's special boundary/padding symbols (present in every espeak voice's map).
const PIPER_PAD = '_'
const PIPER_BOS = '^'
const PIPER_EOS = '$'

/**
 * Split a phonemized string into individual phoneme symbols. Piper keys its id
 * map by Unicode code point (IPA letters plus combining stress/length marks),
 * so an iteration over code points is the correct tokenization.
 */
export function splitPhonemes(phonemes: string): string[] {
  return Array.from(phonemes)
}

/**
 * Convert phoneme symbols to the model's input token ids, following Piper's
 * `piper_phonemize` convention: a BOS, then a PAD interleaved before and after
 * every recognized phoneme, then an EOS. Unknown symbols are dropped. Returns an
 * empty array if the map lacks the boundary symbols (a malformed/"text" config).
 */
export function phonemesToIds(
  phonemes: string[],
  idMap: Record<string, number[]>
): number[] {
  const bos = idMap[PIPER_BOS]
  const eos = idMap[PIPER_EOS]
  const pad = idMap[PIPER_PAD]
  if (!bos || !eos || !pad) return []
  const ids: number[] = []
  ids.push(...bos, ...pad)
  for (const p of phonemes) {
    const mapped = idMap[p]
    if (!mapped) continue
    ids.push(...mapped, ...pad)
  }
  ids.push(...eos)
  return ids
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** Reviewed immutable piper-voices revision used by every catalog URL. */
export const PIPER_VOICES_REVISION = '0d907f158acc877ddeebcbf827659ee13bea8bcd'

/** Base URL for resolving piper-voices files (raw download). */
export const PIPER_VOICES_BASE_URL =
  `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REVISION}/`

/** Absolute HF download URL for a catalog voice's `.onnx` model. */
export function voiceModelUrl(voice: Pick<TtsVoice, 'modelPath'>): string {
  return PIPER_VOICES_BASE_URL + voice.modelPath
}

/** Absolute HF download URL for a catalog voice's `.onnx.json` config. */
export function voiceConfigUrl(voice: Pick<TtsVoice, 'configPath'>): string {
  return PIPER_VOICES_BASE_URL + voice.configPath
}

/** Build a catalog entry from the compact descriptor below. */
function voice(
  id: string,
  name: string,
  language: string,
  quality: TtsVoiceQuality,
  gender: 'female' | 'male' | undefined,
  modelPath: string,
  sizeBytes: number,
  modelSha256: string,
  configSizeBytes: number,
  configSha256: string,
  note?: string
): TtsVoice {
  return {
    id,
    name,
    language,
    quality,
    gender,
    modelPath,
    configPath: `${modelPath}.json`,
    sizeBytes,
    modelSha256,
    configSizeBytes,
    configSha256,
    note
  }
}

/**
 * A small, curated set of high-quality English Piper voices. These are stable
 * paths in `rhasspy/piper-voices`; the medium models strike the best
 * quality/size balance, with a couple of low (smaller, faster) options.
 */
export const TTS_VOICE_CATALOG: TtsVoice[] = [
  voice(
    'en_US-amy-medium',
    'Amy',
    'English (US)',
    'medium',
    'female',
    'en/en_US/amy/medium/en_US-amy-medium.onnx',
    63201294,
    'b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18',
    4882,
    '95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77',
    'Warm, natural American female voice.'
  ),
  voice(
    'en_US-hfc_female-medium',
    'Eva',
    'English (US)',
    'medium',
    'female',
    'en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx',
    63201294,
    '914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7',
    5033,
    '03f1fa0622b80463283592d97aca9f6e89aec345a5c56b7257723e0093c58b6c',
    'Clear, neutral American female voice.'
  ),
  voice(
    'en_US-ryan-medium',
    'Ryan',
    'English (US)',
    'medium',
    'male',
    'en/en_US/ryan/medium/en_US-ryan-medium.onnx',
    63201294,
    'abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a',
    4883,
    '44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d',
    'Confident American male voice.'
  ),
  voice(
    'en_US-lessac-medium',
    'Lessac',
    'English (US)',
    'medium',
    'female',
    'en/en_US/lessac/medium/en_US-lessac-medium.onnx',
    63201294,
    '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
    4885,
    'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0',
    'Crisp studio-quality reference voice.'
  ),
  voice(
    'en_GB-alba-medium',
    'Alba',
    'English (UK)',
    'medium',
    'female',
    'en/en_GB/alba/medium/en_GB-alba-medium.onnx',
    63201294,
    '401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b',
    4888,
    'aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4',
    'Scottish-accented British female voice.'
  ),
  voice(
    'en_GB-northern_english_male-medium',
    'Cole',
    'English (UK)',
    'medium',
    'male',
    'en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx',
    63201294,
    '57a219ae8e638873db7d18893304be5069c42868f392bb95c3ff17f0690d0689',
    4847,
    '69557ed3d974463453e9b0c09dd99a7ed0e52b8b87b64b357dbeeb2540a97d47',
    'Northern English male voice.'
  ),
  voice(
    'en_US-amy-low',
    'Amy (compact)',
    'English (US)',
    'low',
    'female',
    'en/en_US/amy/low/en_US-amy-low.onnx',
    63104526,
    'a5a91abb7de0f104358a25aded480ddacf1ff0762886325886ec406a2e86aab3',
    4164,
    '2250a9a605b8dc35a116717fadc5056695dd809e34a15d02f72a0f52d53d3ebb',
    'Smaller, faster build of Amy.'
  )
]

/** Look up a catalog voice by id. */
export function findCatalogVoice(id: string | null | undefined): TtsVoice | undefined {
  if (!id) return undefined
  return TTS_VOICE_CATALOG.find((v) => v.id === id)
}

// ---------------------------------------------------------------------------
// Markdown → spoken text (pure; unit-tested)
// ---------------------------------------------------------------------------

/**
 * Reduce assistant Markdown to plain text suitable for speech: code blocks are
 * dropped (a voice reading raw code is noise), and inline emphasis/link/heading
 * syntax is stripped to the words a listener actually wants to hear. Best-effort,
 * not a full Markdown parser.
 */
export function plainTextForSpeech(markdown: string): string {
  let t = markdown
  // Drop fenced code blocks entirely.
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/~~~[\s\S]*?~~~/g, ' ')
  // Inline code → its contents.
  t = t.replace(/`([^`]+)`/g, '$1')
  // Images → alt text; links → link text.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Strip remaining HTML tags.
  t = t.replace(/<[^>]+>/g, ' ')
  // Emphasis / strikethrough markers.
  t = t.replace(/(\*\*|__|\*|_|~~)/g, '')
  // Leading block markers per line: headings, blockquotes, list bullets.
  t = t
    .split('\n')
    .map((line) => line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, ''))
    .join('\n')
  // Horizontal rules.
  t = t.replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')
  // Normalize lines: collapse inner whitespace and drop now-blank lines (e.g.
  // where a code block was removed) so the voice doesn't pause oddly.
  t = t
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
  return t
}
