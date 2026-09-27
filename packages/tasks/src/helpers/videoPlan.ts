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
 * mp4/mov/m4v container, not HDR. Anything else is TRANSCODED to H.264
 * High/yuv420p, scaled to fit 1080p with even dimensions, at most 60 fps,
 * HDR tone-mapped to SDR bt709, AAC 128k stereo, `+faststart`.
 *
 * ## Size (plan §12.7 M1)
 *
 * A transcode's `-fs` is a flat 3 GiB and its bitrate is capped so the whole
 * duration fits under it (`rateCeiling`): CRF alone would let a long, busy
 * recording run into `-fs` and fail as incomplete.
 */

/** The demuxers the job will open: what the media store accepts as VIDEO. */
export const FORMAT_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,ogg';

/** Longer than this is refused: a lecture is hours, not days. */
export const MAX_DURATION_SEC = 6 * 60 * 60;

/** More pixels than 8K UHD (8192×4320) is refused: no camera a class uses records it. */
export const MAX_PIXELS = 8192 * 4320;

/** A transcode's frame rate is capped here (`fps=60` only above it). */
export const MAX_FRAME_RATE = 60;

/** The transcode's AAC bitrate, which `rateCeiling` leaves room for. */
export const AUDIO_BITRATE = 128_000;

/** A transcode's video bitrate ceiling never exceeds this (the remux limit). */
export const MAX_VIDEO_BITRATE = 8_000_000;

/**
 * Nor drops under this. It cannot bind with the real cap: 3 GiB over the
 * 6-hour maximum is ~957 kb/s.
 */
export const MIN_VIDEO_BITRATE = 250_000;

/** Transfer characteristics that mean HDR (HLG and PQ): tone-mapped to SDR. */
export const HDR_TRANSFERS: ReadonlySet<string> = new Set(['arib-std-b67', 'smpte2084']);

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
  | 'TOO_LARGE'
  | 'TIMED_OUT'
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
  TOO_LARGE: 'The video is larger than 8K.',
  TIMED_OUT: 'The video took too long to optimise.',
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
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
  color_transfer?: unknown;
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
  /** Average frames per second, or null when the probe has no usable rate. */
  frameRate: number | null;
  /** `color_transfer` as ffprobe names it ('' when untagged). */
  colorTransfer: string;
  /** The stream's own duration, when the container records one. */
  durationSec: number | null;
}

export interface VideoFacts {
  formatName: string;
  durationSec: number;
  /** Overall bits per second (see `overallBitrate`). */
  bitRate: number;
  video: VideoStreamFacts | null;
  audio: { index: number; codec: string; durationSec: number | null } | null;
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

function positiveNumber(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n > 0 ? n : null;
}

/** An ffprobe rational ("30000/1001", "0/0") as a number, or null. */
function rational(value: unknown): number | null {
  const match = /^(\d+)\/(\d+)$/.exec(text(value));
  if (!match) return null;
  const den = Number(match[2]);
  return den > 0 ? positiveNumber(Number(match[1]) / den) : null;
}

/**
 * Frames per second: `avg_frame_rate`, falling back to `r_frame_rate` only
 * when there is no average. A variable-rate phone clip reports an inflated
 * `r_frame_rate` (120/1 for a ~30 fps clip); capping on that would force a
 * constant 60 and duplicate frames.
 */
function frameRateOf(stream: ProbeStream): number | null {
  return rational(stream.avg_frame_rate) ?? rational(stream.r_frame_rate);
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
      frameRate: frameRateOf(picture),
      colorTransfer: text(picture.color_transfer),
      durationSec: positiveNumber(picture.duration),
    };
  }

  let audio: VideoFacts['audio'] = null;
  if (sound) {
    const index = wholeNumber(sound.index);
    if (index === null) throw new VideoRefusal('UNREADABLE', 'audio stream without index');
    audio = { index, codec: text(sound.codec_name), durationSec: positiveNumber(sound.duration) };
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
  /** What the rendition should last: `mappedDurationSec`. */
  durationSec: number;
}

/**
 * How long the rendition should be: the longest of the streams it carries
 * (the picture and the first audio track), when each records its own
 * duration; otherwise the container's. A mov's timecode or data track can
 * outlast the picture, and the rendition leaves those behind — measuring it
 * against the container would call a whole copy short.
 */
export function mappedDurationSec(facts: VideoFacts): number {
  const mapped = [facts.video, facts.audio].filter(s => s !== null);
  const durations = mapped.map(s => s.durationSec);
  if (mapped.length && durations.every(d => d !== null)) {
    return Math.max(...(durations as number[]));
  }
  return facts.durationSec;
}

/** HLG or PQ: the picture needs tone-mapping to look right on an SDR screen. */
export function isHdr(video: VideoStreamFacts): boolean {
  return HDR_TRANSFERS.has(video.colorTransfer);
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
  // Area, so the rule is the same in either orientation.
  if (video.width * video.height > MAX_PIXELS) {
    throw new VideoRefusal('TOO_LARGE', `${video.width}x${video.height}`);
  }

  const reasons: string[] = [];
  if (video.codec !== 'h264') reasons.push(`codec ${video.codec || 'unknown'}`);
  if (video.pixFmt !== 'yuv420p') reasons.push(`pixel format ${video.pixFmt || 'unknown'}`);
  if (!REMUX_PROFILES.has(video.profile.toLowerCase())) {
    reasons.push(`profile ${video.profile || 'unknown'}`);
  }
  if (isHdr(video)) reasons.push(`hdr ${video.colorTransfer}`);
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

  return {
    mode: reasons.length ? 'transcode' : 'remux',
    reasons,
    video,
    durationSec: mappedDurationSec(facts),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────────────────────

/** Round down to an even integer, at least 2 (x264 in 4:2:0 needs even sizes). */
export function evenFloor(value: number): number {
  return Math.max(2, 2 * Math.floor(value / 2));
}

/**
 * The box the transcode's picture must fit: the 1080p box turned to the
 * DISPLAY orientation (ffmpeg autorotates before our filter runs), and no
 * larger than the picture itself on either side, so the filter's
 * `force_original_aspect_ratio=decrease` never upscales.
 *
 * The filter keeps the aspect of the frames it is actually given. If the
 * probe's idea of the rotation and ffmpeg's disagree (a rotation carried only
 * in a legacy tag), the picture comes out smaller than it could be, never
 * squashed — which a fixed `scale=W:H` from the probe's numbers would do.
 */
export function scaleBounds(video: VideoStreamFacts): { width: number; height: number } {
  const w = video.displayWidth;
  const h = video.displayHeight;
  const portrait = h > w;
  return {
    width: Math.min(w, portrait ? MAX_SHORT_SIDE : MAX_LONG_SIDE),
    height: Math.min(h, portrait ? MAX_LONG_SIDE : MAX_SHORT_SIDE),
  };
}

/**
 * `-fs` for the rendition. A remux is about the input's size: max(1.5 × input,
 * 500 MiB), at most 3 GiB. A transcode is a flat 3 GiB, and `rateCeiling`
 * makes the encode fit under it.
 */
export function outputSizeCap(mode: VideoMode, inputBytes: number): number {
  if (mode === 'transcode') return OUTPUT_CAP_CEILING;
  return Math.min(OUTPUT_CAP_CEILING, Math.max(Math.ceil(1.5 * inputBytes), OUTPUT_CAP_FLOOR));
}

/**
 * The transcode's `-maxrate` (bits per second): what fills `capBytes` over
 * `durationSec` after the audio's share, with 10% headroom for the container
 * and the rate control's overshoot, at most 8 Mb/s:
 *
 *     min(8 Mbps, floor(0.9 × (cap × 8 / duration − 128k)))
 *
 * `-bufsize` is twice this. Short clips get the 8 Mb/s ceiling; only long
 * recordings are held down by the cap.
 */
export function rateCeiling(capBytes: number, durationSec: number): number {
  const fill = Math.floor(0.9 * ((capBytes * 8) / durationSec - AUDIO_BITRATE));
  const rate = Number.isFinite(fill) ? fill : MAX_VIDEO_BITRATE;
  return Math.max(MIN_VIDEO_BITRATE, Math.min(MAX_VIDEO_BITRATE, rate));
}

/** The poster frame's time: one second in, or halfway through a shorter clip. */
export function posterTime(durationSec: number): number {
  return Math.min(1, durationSec / 2);
}

/**
 * The rendition is complete when it has a picture track and its duration is
 * within 1% of what it should last (`mappedDurationSec` of the input), or
 * within half a second for a short clip. A
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
  /**
   * Replaces `outputSizeCap` — both `-fs` and the rate ceiling follow it. For
   * the scratch scripts that prove a tiny cap is met; the job never sets it.
   */
  outputCapBytes?: number;
}

/**
 * HLG/PQ → SDR bt709 (zimg): to linear light, into bt709 primaries, Hable
 * tone curve, back to the bt709 transfer in limited range, 4:2:0. zscale reads
 * the input's transfer, primaries and matrix from the frames, which carry the
 * source's tags through `fps` and `scale`. Verified on Debian bookworm's
 * ffmpeg 5.1.9 (what the Trigger image installs), which is built with libzimg;
 * Homebrew's ffmpeg is not, so an HDR clip fails to convert under a local
 * `trigger dev`.
 */
export const TONEMAP_FILTERS =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,' +
  'zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** The transcode's `-vf`: frame-rate cap, the fixed-shape scale, tone-mapping. */
export function transcodeFilter(video: VideoStreamFacts): string {
  const filters: string[] = [];
  if (video.frameRate !== null && video.frameRate > MAX_FRAME_RATE) {
    filters.push(`fps=${MAX_FRAME_RATE}`);
  }
  const box = scaleBounds(video);
  filters.push(
    `scale=w=${assertPositive(box.width)}:h=${assertPositive(box.height)}` +
      ':force_original_aspect_ratio=decrease:force_divisible_by=2'
  );
  if (isHdr(video)) filters.push(TONEMAP_FILTERS);
  return filters.join(',');
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
  outputCapBytes,
}: RenditionArgsInput): string[] {
  const cap = outputCapBytes ?? outputSizeCap(decision.mode, inputBytes);
  const args = [...inputOptions(), '-i', input, '-map', `0:${assertIndex(decision.video.index)}`];
  if (audioIndex !== null) args.push('-map', `0:${assertIndex(audioIndex)}`);

  if (decision.mode === 'remux') {
    args.push('-c', 'copy');
    if (audioIndex === null) args.push('-an');
  } else {
    const maxrate = rateCeiling(cap, decision.durationSec);
    args.push(
      '-vf',
      transcodeFilter(decision.video),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-maxrate',
      assertPositive(maxrate),
      '-bufsize',
      assertPositive(2 * maxrate),
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high'
    );
    if (isHdr(decision.video)) {
      // What the tone-mapped picture now is; SDR sources keep their own tags.
      args.push(
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        '-color_range',
        'tv'
      );
    }
    if (audioIndex === null) args.push('-an');
    else args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  }

  args.push('-movflags', '+faststart', '-fs', assertPositive(cap), '-f', 'mp4', '-y', output);
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
