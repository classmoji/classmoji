/**
 * The pure half of the video job (`media-video-process`): read what ffprobe
 * said, decide remux or transcode, and build the exact argument lists ffmpeg
 * is run with. No I/O here — the task drives the processes and the bucket —
 * so every rule below is a unit test, and a scratch script can run the same
 * arguments against real clips.
 *
 * ## Why argument lists, and why only numbers
 *
 * ffmpeg is a large parser pointed at a file an uploader chose. The job never
 * hands it a shell, a URL, a filter string with user text in it, or an output
 * path it did not create: every list below is a fixed shape whose only
 * variable parts are our own tmp paths and integers the probe returned
 * (stream indices, dimensions, a seek time). The inputs are also fenced at
 * the demuxer: `-protocol_whitelist file,pipe` (no network, no nested
 * protocols) and `-format_whitelist` (only the containers the media store
 * accepts as VIDEO — a playlist or concat script renamed `.mp4` is refused by
 * the probe instead of being followed).
 *
 * ## The decision (plan §12.6)
 *
 * REMUX — copy the streams into an mp4 with the index at the front — only
 * when browsers play the file as it is: H.264 in yuv420p at a profile no
 * higher than High, AAC or no audio, at most 1080p, at most 8 Mbps, in an
 * mp4/mov/m4v container. Anything else is TRANSCODED to H.264 High/yuv420p,
 * scaled to fit 1080p with even dimensions, AAC 128k, `+faststart`.
 */

/** The demuxers the job will open: what the media store accepts as VIDEO. */
export const FORMAT_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,ogg';

/** Longer than this is refused: a lecture is hours, not days. */
export const MAX_DURATION_SEC = 6 * 60 * 60;

/** Remux only at or under this overall bitrate (bits per second). */
export const MAX_REMUX_BITRATE = 8_000_000;

/** The 1080p box, for either orientation: long side × short side. */
export const MAX_LONG_SIDE = 1920;
export const MAX_SHORT_SIDE = 1080;

/** The poster is at most this wide (never upscaled). */
export const POSTER_MAX_WIDTH = 1280;

/** A poster larger than this is not a poster. `-fs` backstop for its encode. */
export const POSTER_MAX_BYTES = 20 * 1024 * 1024;

const MIB = 1024 * 1024;
/** The rendition's size cap floor and ceiling (plan §12.6 "Disk budget"). */
export const OUTPUT_CAP_FLOOR = 500 * MIB;
export const OUTPUT_CAP_CEILING = 3 * 1024 * MIB;

/** Profiles every browser's H.264 decoder takes (High 10, 4:2:2, 4:4:4 are not). */
const REMUX_PROFILES = new Set(['baseline', 'constrained baseline', 'main', 'high']);

/** The row extensions whose container can be remuxed as-is. */
const REMUX_EXTS = new Set(['mp4', 'mov', 'm4v']);

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

export type VideoRefusalCode =
  | 'NO_VIDEO'
  | 'TOO_LONG'
  | 'UNREADABLE'
  | 'CONVERT_FAILED'
  | 'INCOMPLETE'
  | 'ORIGINAL_MISSING'
  | 'ORIGINAL_MISMATCH';

/**
 * The user-legible sentence recorded as `processing_error` for each refusal.
 * The Media page shows it under "Couldn't optimise — the original is shown",
 * so it says what is wrong with the file, never how the job works.
 */
export const REFUSAL_MESSAGES: Readonly<Record<VideoRefusalCode, string>> = {
  NO_VIDEO: 'The file has no video track.',
  TOO_LONG: 'The video is longer than 6 hours.',
  UNREADABLE: "The video's format could not be read.",
  CONVERT_FAILED: 'The video could not be converted.',
  INCOMPLETE: 'The optimised copy was incomplete.',
  ORIGINAL_MISSING: 'The original file is missing.',
  ORIGINAL_MISMATCH: 'The stored original does not match its upload.',
};

/** Recorded when a retryable failure runs out of attempts. */
export const GENERIC_FAILURE_MESSAGE = 'The video could not be optimised.';

/**
 * A failure another attempt cannot change: the task records it and throws
 * `AbortTaskRunError`. Everything that is NOT one of these is treated as
 * transient (network, R2 5xx, a killed process) and retried.
 */
export class VideoRefusal extends Error {
  readonly code: VideoRefusalCode;
  constructor(code: VideoRefusalCode, detail?: string) {
    super(detail ? `${REFUSAL_MESSAGES[code]} (${detail})` : REFUSAL_MESSAGES[code]);
    this.name = 'VideoRefusal';
    this.code = code;
  }
  /** What the row records — the sentence alone, never the detail. */
  get userMessage(): string {
    return REFUSAL_MESSAGES[this.code];
  }
}

export function isVideoRefusal(error: unknown): error is VideoRefusal {
  return error instanceof VideoRefusal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe
// ─────────────────────────────────────────────────────────────────────────────

/** The parts of `ffprobe -of json -show_format -show_streams` the job reads. */
export interface ProbeStream {
  index?: unknown;
  codec_type?: unknown;
  codec_name?: unknown;
  profile?: unknown;
  pix_fmt?: unknown;
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  disposition?: { attached_pic?: unknown } | null;
  tags?: { rotate?: unknown } | null;
  side_data_list?: Array<{ rotation?: unknown }> | null;
}

export interface ProbeJson {
  streams?: ProbeStream[] | null;
  format?: {
    format_name?: unknown;
    duration?: unknown;
    bit_rate?: unknown;
  } | null;
}

export interface VideoStreamFacts {
  index: number;
  codec: string;
  profile: string;
  pixFmt: string;
  /** Coded size, as stored. */
  width: number;
  height: number;
  /** Clockwise display rotation in degrees: 0, 90, 180 or 270. */
  rotation: number;
  /** What a viewer sees: coded size with w/h swapped for a quarter turn. */
  displayWidth: number;
  displayHeight: number;
}

export interface VideoFacts {
  formatName: string;
  durationSec: number;
  /** Overall bits per second (see `overallBitrate`). */
  bitRate: number;
  video: VideoStreamFacts | null;
  audio: { index: number; codec: string } | null;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function wholeNumber(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Rotation from the display matrix (ffmpeg ≥ 5) or the legacy `rotate` tag. */
function rotationOf(stream: ProbeStream): number {
  let raw: number | null = null;
  for (const side of stream.side_data_list ?? []) {
    const r = finiteNumber(side?.rotation);
    if (r !== null) {
      raw = r;
      break;
    }
  }
  if (raw === null) raw = finiteNumber(stream.tags?.rotate);
  if (raw === null) return 0;
  const quarter = Math.round(raw / 90);
  return (((quarter % 4) + 4) % 4) * 90;
}

/**
 * A real picture track: `codec_type: video` and not an attached picture (the
 * cover art an mp4 or mkv can carry is a one-frame "video" stream).
 */
function isPictureTrack(stream: ProbeStream): boolean {
  return stream.codec_type === 'video' && wholeNumber(stream.disposition?.attached_pic) !== 1;
}

/**
 * Overall bitrate: the container's own figure, else size × 8 / duration.
 * Overall rather than the video stream's, because what matters for playing a
 * remuxed file as-is is what a viewer has to download per second.
 */
function overallBitrate(format: ProbeJson['format'], fileBytes: number, durationSec: number) {
  const declared = finiteNumber(format?.bit_rate);
  if (declared !== null && declared > 0) return declared;
  return durationSec > 0 ? (fileBytes * 8) / durationSec : 0;
}

/**
 * The facts the plan needs, from ffprobe's JSON. Throws `UNREADABLE` when the
 * probe gives no usable duration (the 6-hour rule and the completeness check
 * both depend on it) or a picture track with no usable size.
 */
export function parseProbe(json: ProbeJson, fileBytes: number): VideoFacts {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const picture = streams.find(isPictureTrack);
  const sound = streams.find(s => s?.codec_type === 'audio');

  let video: VideoStreamFacts | null = null;
  if (picture) {
    const index = wholeNumber(picture.index);
    const width = wholeNumber(picture.width);
    const height = wholeNumber(picture.height);
    if (index === null || !width || !height) {
      throw new VideoRefusal('UNREADABLE', 'video stream without index or size');
    }
    const rotation = rotationOf(picture);
    const quarterTurn = rotation === 90 || rotation === 270;
    video = {
      index,
      codec: text(picture.codec_name),
      profile: text(picture.profile),
      pixFmt: text(picture.pix_fmt),
      width,
      height,
      rotation,
      displayWidth: quarterTurn ? height : width,
      displayHeight: quarterTurn ? width : height,
    };
  }

  let audio: VideoFacts['audio'] = null;
  if (sound) {
    const index = wholeNumber(sound.index);
    if (index === null) throw new VideoRefusal('UNREADABLE', 'audio stream without index');
    audio = { index, codec: text(sound.codec_name) };
  }

  let durationSec = finiteNumber(json?.format?.duration);
  if (durationSec === null || durationSec <= 0) {
    const streamDurations = streams
      .map(s => finiteNumber(s?.duration))
      .filter((d): d is number => d !== null && d > 0);
    durationSec = streamDurations.length ? Math.max(...streamDurations) : null;
  }
  if (durationSec === null || durationSec <= 0) {
    throw new VideoRefusal('UNREADABLE', 'no duration');
  }

  return {
    formatName: text(json?.format?.format_name),
    durationSec,
    bitRate: overallBitrate(json?.format, fileBytes, durationSec),
    video,
    audio,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision
// ─────────────────────────────────────────────────────────────────────────────

export type VideoMode = 'remux' | 'transcode';

export interface VideoDecision {
  mode: VideoMode;
  /** Why it is not a remux (empty for a remux). For the run log. */
  reasons: string[];
  video: VideoStreamFacts;
}

function fitsIn1080p(width: number, height: number): boolean {
  return Math.max(width, height) <= MAX_LONG_SIDE && Math.min(width, height) <= MAX_SHORT_SIDE;
}

/**
 * Remux or transcode — or refuse. `ext` is the ROW's extension (what the
 * upload was classified as): ffprobe names mp4, mov and m4v with one compound
 * demuxer name, so the container rule needs both.
 */
export function decideVideo(facts: VideoFacts, ext: string): VideoDecision {
  if (facts.durationSec > MAX_DURATION_SEC) throw new VideoRefusal('TOO_LONG');
  const video = facts.video;
  if (!video) throw new VideoRefusal('NO_VIDEO');

  const reasons: string[] = [];
  if (video.codec !== 'h264') reasons.push(`codec ${video.codec || 'unknown'}`);
  if (video.pixFmt !== 'yuv420p') reasons.push(`pixel format ${video.pixFmt || 'unknown'}`);
  if (!REMUX_PROFILES.has(video.profile.toLowerCase())) {
    reasons.push(`profile ${video.profile || 'unknown'}`);
  }
  if (facts.audio && facts.audio.codec !== 'aac') reasons.push(`audio ${facts.audio.codec}`);
  if (!fitsIn1080p(video.width, video.height)) {
    reasons.push(`size ${video.displayWidth}x${video.displayHeight}`);
  }
  if (!(facts.bitRate > 0) || facts.bitRate > MAX_REMUX_BITRATE) {
    reasons.push(`bitrate ${Math.round(facts.bitRate)}`);
  }
  const container = facts.formatName.split(',');
  if (!REMUX_EXTS.has(ext.toLowerCase()) || !container.includes('mov')) {
    reasons.push(`container ${ext}/${facts.formatName}`);
  }

  return { mode: reasons.length ? 'transcode' : 'remux', reasons, video };
}

// ─────────────────────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────────────────────

/** Round down to an even integer, at least 2 (x264 in 4:2:0 needs even sizes). */
export function evenFloor(value: number): number {
  return Math.max(2, 2 * Math.floor(value / 2));
}

/**
 * The transcode's output size: the DISPLAY size (ffmpeg autorotates before our
 * filter runs) scaled down to fit the 1080p box, never up, keeping the aspect,
 * with both sides even.
 */
export function transcodeSize(video: VideoStreamFacts): { width: number; height: number } {
  const w = video.displayWidth;
  const h = video.displayHeight;
  const factor = Math.min(1, MAX_LONG_SIDE / Math.max(w, h), MAX_SHORT_SIDE / Math.min(w, h));
  return { width: evenFloor(w * factor), height: evenFloor(h * factor) };
}

/** `-fs` for the rendition: max(1.5 × input, 500 MiB), at most 3 GiB. */
export function outputSizeCap(inputBytes: number): number {
  return Math.min(OUTPUT_CAP_CEILING, Math.max(Math.ceil(1.5 * inputBytes), OUTPUT_CAP_FLOOR));
}

/** The poster frame's time: one second in, or halfway through a shorter clip. */
export function posterTime(durationSec: number): number {
  return Math.min(1, durationSec / 2);
}

/**
 * The rendition is complete when it has a picture track and its duration is
 * within 1% of the input's, or within half a second for a short clip. A
 * shortfall means `-fs` cut it off, the disk filled, or ffmpeg stopped early
 * and still exited 0 — in every case the copy must not replace the original.
 */
export function isCompleteOutput(inputDurationSec: number, output: VideoFacts): boolean {
  if (!output.video) return false;
  const tolerance = Math.max(0.01 * inputDurationSec, 0.5);
  return Math.abs(output.durationSec - inputDurationSec) <= tolerance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument lists
// ─────────────────────────────────────────────────────────────────────────────

function assertIndex(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`video: not a stream index (${n})`);
  return String(n);
}

function assertPositive(n: number): string {
  if (!Number.isInteger(n) || n <= 0) throw new TypeError(`video: not a positive integer (${n})`);
  return String(n);
}

/** The options every process opens its input with. */
function inputOptions(): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-format_whitelist',
    FORMAT_WHITELIST,
  ];
}

/** `ffprobe` on a local file, JSON out. */
export function probeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-format_whitelist',
    FORMAT_WHITELIST,
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    input,
  ];
}

export interface RenditionArgsInput {
  input: string;
  output: string;
  decision: VideoDecision;
  audioIndex: number | null;
  inputBytes: number;
}

/**
 * The rendition's ffmpeg arguments for the decision. Only the chosen video
 * track and the first audio track are mapped — a mov's timecode or data
 * tracks, subtitles and cover art are left behind.
 */
export function renditionArgs({
  input,
  output,
  decision,
  audioIndex,
  inputBytes,
}: RenditionArgsInput): string[] {
  const args = [...inputOptions(), '-i', input, '-map', `0:${assertIndex(decision.video.index)}`];
  if (audioIndex !== null) args.push('-map', `0:${assertIndex(audioIndex)}`);

  if (decision.mode === 'remux') {
    args.push('-c', 'copy');
    if (audioIndex === null) args.push('-an');
  } else {
    const size = transcodeSize(decision.video);
    args.push(
      '-vf',
      `scale=${assertPositive(size.width)}:${assertPositive(size.height)}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high'
    );
    if (audioIndex === null) args.push('-an');
    else args.push('-c:a', 'aac', '-b:a', '128k');
  }

  args.push(
    '-movflags',
    '+faststart',
    '-fs',
    assertPositive(outputSizeCap(inputBytes)),
    '-f',
    'mp4',
    '-y',
    output
  );
  return args;
}

/**
 * The poster: one frame of the RENDITION (already decodable and upright) at
 * `posterTime`, at most 1280 wide, as a baseline JPEG.
 *
 * JPEG, not webp: the `mjpeg` encoder is built into every ffmpeg (webp needs
 * libwebp, which neither Homebrew's ffmpeg nor every distro build has).
 * `format=yuvj420p` hands the encoder full-range 4:2:0 explicitly rather than
 * leaving the range conversion to format negotiation, which has changed
 * between releases; verified on 5.1.9 (Debian bookworm, what the Trigger image
 * installs) and 8.1.
 */
export function posterArgs({
  rendition,
  output,
  durationSec,
  renditionWidth,
}: {
  rendition: string;
  output: string;
  durationSec: number;
  renditionWidth: number;
}): string[] {
  const at = posterTime(durationSec);
  if (!Number.isFinite(at) || at < 0) throw new TypeError(`video: bad poster time (${at})`);
  const width = Math.min(POSTER_MAX_WIDTH, evenFloor(renditionWidth));
  return [
    ...inputOptions(),
    '-ss',
    at.toFixed(3),
    '-i',
    rendition,
    '-frames:v',
    '1',
    '-vf',
    `scale=${assertPositive(width)}:-2,format=yuvj420p`,
    '-an',
    '-c:v',
    'mjpeg',
    '-q:v',
    '3',
    '-fs',
    String(POSTER_MAX_BYTES),
    '-f',
    'mjpeg',
    '-y',
    output,
  ];
}
