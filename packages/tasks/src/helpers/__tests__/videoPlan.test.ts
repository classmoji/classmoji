/**
 * The video job's pure rules (plan §12.3 / §12.6): what ffprobe's JSON means,
 * remux vs transcode, the argument lists ffmpeg runs with, the size cap and
 * the completeness check that turns a truncated encode into a failure.
 */

import { describe, expect, it } from 'vitest';

import {
  FORMAT_WHITELIST,
  OUTPUT_CAP_CEILING,
  OUTPUT_CAP_FLOOR,
  VideoRefusal,
  decideVideo,
  evenFloor,
  isCompleteOutput,
  outputSizeCap,
  parseProbe,
  posterArgs,
  posterTime,
  probeArgs,
  renditionArgs,
  transcodeSize,
  type ProbeJson,
  type ProbeStream,
} from '../videoPlan.ts';

const MOV = 'mov,mp4,m4a,3gp,3g2,mj2';

function h264(over: Partial<ProbeStream> = {}): ProbeStream {
  return {
    index: 0,
    codec_type: 'video',
    codec_name: 'h264',
    profile: 'High',
    pix_fmt: 'yuv420p',
    width: 1280,
    height: 720,
    ...over,
  };
}

const AAC: ProbeStream = { index: 1, codec_type: 'audio', codec_name: 'aac' };

function probe(
  streams: ProbeStream[],
  format: Partial<NonNullable<ProbeJson['format']>> = {}
): ProbeJson {
  return {
    streams,
    format: { format_name: MOV, duration: '60.000000', bit_rate: '2000000', ...format },
  };
}

const facts = (json: ProbeJson, bytes = 15_000_000) => parseProbe(json, bytes);

describe('decideVideo — remux only what browsers play as-is', () => {
  it('remuxes H.264 High yuv420p + AAC, 720p, 2 Mbps, mp4', () => {
    const d = decideVideo(facts(probe([h264(), AAC])), 'mp4');
    expect(d.mode).toBe('remux');
    expect(d.reasons).toEqual([]);
  });

  it.each([
    ['Baseline', 'remux'],
    ['Constrained Baseline', 'remux'],
    ['Main', 'remux'],
    ['High', 'remux'],
    ['High 10', 'transcode'],
    ['High 4:2:2', 'transcode'],
    ['High 4:4:4 Predictive', 'transcode'],
    ['Extended', 'transcode'],
    ['', 'transcode'],
  ])('profile %s → %s', (profile, mode) => {
    expect(decideVideo(facts(probe([h264({ profile }), AAC])), 'mp4').mode).toBe(mode);
  });

  it('transcodes yuv444p', () => {
    const d = decideVideo(facts(probe([h264({ pix_fmt: 'yuv444p' }), AAC])), 'mp4');
    expect(d.mode).toBe('transcode');
    expect(d.reasons.join()).toMatch(/pixel format yuv444p/);
  });

  it('transcodes High 10 H.264 in 10-bit', () => {
    const d = decideVideo(
      facts(probe([h264({ profile: 'High 10', pix_fmt: 'yuv420p10le' }), AAC])),
      'mp4'
    );
    expect(d.mode).toBe('transcode');
  });

  it('transcodes HEVC, VP9 and ProRes', () => {
    for (const codec_name of ['hevc', 'vp9', 'prores']) {
      expect(decideVideo(facts(probe([h264({ codec_name }), AAC])), 'mp4').mode).toBe('transcode');
    }
  });

  it('remuxes with no audio; transcodes non-AAC audio', () => {
    expect(decideVideo(facts(probe([h264()])), 'mp4').mode).toBe('remux');
    const opus: ProbeStream = { index: 1, codec_type: 'audio', codec_name: 'opus' };
    expect(decideVideo(facts(probe([h264(), opus])), 'mp4').mode).toBe('transcode');
  });

  it('transcodes over 1080p in either orientation, remuxes 1080p exactly', () => {
    expect(decideVideo(facts(probe([h264({ width: 1920, height: 1080 })])), 'mp4').mode).toBe(
      'remux'
    );
    expect(decideVideo(facts(probe([h264({ width: 1080, height: 1920 })])), 'mp4').mode).toBe(
      'remux'
    );
    expect(decideVideo(facts(probe([h264({ width: 2560, height: 1440 })])), 'mp4').mode).toBe(
      'transcode'
    );
    expect(decideVideo(facts(probe([h264({ width: 1440, height: 2560 })])), 'mp4').mode).toBe(
      'transcode'
    );
  });

  it('transcodes over 8 Mbps, from the container figure or size/duration', () => {
    expect(decideVideo(facts(probe([h264()], { bit_rate: '8000000' })), 'mp4').mode).toBe('remux');
    expect(decideVideo(facts(probe([h264()], { bit_rate: '8000001' })), 'mp4').mode).toBe(
      'transcode'
    );
    // No declared bitrate: 120 MB over 60 s = 16 Mbps.
    const noRate = probe([h264()], { bit_rate: undefined });
    expect(decideVideo(parseProbe(noRate, 120_000_000), 'mp4').mode).toBe('transcode');
    expect(decideVideo(parseProbe(noRate, 30_000_000), 'mp4').mode).toBe('remux');
  });

  it('remuxes only mp4/mov/m4v containers', () => {
    for (const ext of ['mp4', 'mov', 'm4v', 'MOV']) {
      expect(decideVideo(facts(probe([h264(), AAC])), ext).mode).toBe('remux');
    }
    const mkv = probe([h264(), AAC], { format_name: 'matroska,webm' });
    expect(decideVideo(facts(mkv), 'mkv').mode).toBe('transcode');
    // An mkv file renamed .mp4 is still not an mp4.
    expect(decideVideo(facts(mkv), 'mp4').mode).toBe('transcode');
    expect(decideVideo(facts(probe([h264(), AAC], { format_name: 'avi' })), 'avi').mode).toBe(
      'transcode'
    );
  });

  it('refuses no picture track — cover art is not one', () => {
    const cover = h264({ index: 2, codec_name: 'mjpeg', disposition: { attached_pic: 1 } });
    expect(() => decideVideo(facts(probe([AAC, cover])), 'mp4')).toThrow(VideoRefusal);
    try {
      decideVideo(facts(probe([AAC])), 'mp4');
    } catch (error) {
      expect((error as VideoRefusal).code).toBe('NO_VIDEO');
      expect((error as VideoRefusal).userMessage).toBe('The file has no video track.');
    }
  });

  it('picks the real track over cover art', () => {
    const cover = h264({ index: 0, codec_name: 'mjpeg', disposition: { attached_pic: 1 } });
    const d = decideVideo(facts(probe([cover, h264({ index: 1 }), { ...AAC, index: 2 }])), 'mp4');
    expect(d.video.index).toBe(1);
  });

  it('refuses over 6 hours', () => {
    const long = probe([h264(), AAC], { duration: String(6 * 3600 + 1) });
    expect(() => decideVideo(facts(long), 'mp4')).toThrow(/longer than 6 hours/);
    const six = probe([h264(), AAC], { duration: String(6 * 3600) });
    expect(() => decideVideo(facts(six), 'mp4')).not.toThrow();
  });
});

describe('parseProbe', () => {
  it('refuses a file with no usable duration', () => {
    expect(() => parseProbe(probe([h264()], { duration: 'N/A' }), 1)).toThrow(
      expect.objectContaining({ code: 'UNREADABLE' })
    );
  });

  it('falls back to the longest stream duration', () => {
    const json = probe([h264({ duration: '12.5' }), { ...AAC, duration: '12.7' }], {
      duration: undefined,
    });
    expect(parseProbe(json, 1).durationSec).toBe(12.7);
  });

  it('reads rotation from the display matrix or the rotate tag, and swaps display size', () => {
    const matrix = parseProbe(probe([h264({ side_data_list: [{ rotation: -90 }] })]), 1);
    expect(matrix.video).toMatchObject({ rotation: 270, displayWidth: 720, displayHeight: 1280 });
    const tag = parseProbe(probe([h264({ tags: { rotate: '90' } })]), 1);
    expect(tag.video).toMatchObject({ rotation: 90, displayWidth: 720, displayHeight: 1280 });
    const flip = parseProbe(probe([h264({ side_data_list: [{ rotation: 180 }] })]), 1);
    expect(flip.video).toMatchObject({ displayWidth: 1280, displayHeight: 720 });
  });

  it('refuses a picture track with no size or a non-integer index', () => {
    expect(() => parseProbe(probe([h264({ width: 0 })]), 1)).toThrow(VideoRefusal);
    expect(() => parseProbe(probe([h264({ index: '0; rm -rf /' })]), 1)).toThrow(VideoRefusal);
    expect(() => parseProbe(probe([h264({ index: 1.5 })]), 1)).toThrow(VideoRefusal);
  });
});

describe('numbers', () => {
  it('evenFloor', () => {
    expect([evenFloor(1081), evenFloor(1080), evenFloor(1.2), evenFloor(0)]).toEqual([
      1080, 1080, 2, 2,
    ]);
  });

  it('transcodeSize fits 1080p from the DISPLAY size, keeps aspect, even, never upscales', () => {
    const at = (width: number, height: number, rotation = 0) =>
      transcodeSize(
        decideVideo(facts(probe([h264({ width, height, side_data_list: [{ rotation }] })])), 'mp4')
          .video
      );
    expect(at(2560, 1440)).toEqual({ width: 1920, height: 1080 });
    expect(at(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(at(1440, 2560)).toEqual({ width: 1080, height: 1920 });
    // A phone clip stored landscape, displayed portrait.
    expect(at(3840, 2160, -90)).toEqual({ width: 1080, height: 1920 });
    expect(at(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(at(641, 481)).toEqual({ width: 640, height: 480 });
    // Ultra-wide: the long side binds.
    expect(at(5120, 1440)).toEqual({ width: 1920, height: 540 });
  });

  it('outputSizeCap = max(1.5 × input, 500 MiB), at most 3 GiB', () => {
    expect(outputSizeCap(10_000_000)).toBe(OUTPUT_CAP_FLOOR);
    expect(outputSizeCap(1_000_000_000)).toBe(1_500_000_000);
    // The 2 GB per-file maximum lands under the ceiling; it binds only past it.
    expect(outputSizeCap(2_000_000_000)).toBe(3_000_000_000);
    expect(outputSizeCap(2_500_000_000)).toBe(OUTPUT_CAP_CEILING);
    expect(OUTPUT_CAP_FLOOR).toBe(500 * 1024 * 1024);
    expect(OUTPUT_CAP_CEILING).toBe(3 * 1024 * 1024 * 1024);
  });

  it('posterTime = min(1 s, duration / 2)', () => {
    expect(posterTime(60)).toBe(1);
    expect(posterTime(1.2)).toBe(0.6);
  });
});

describe('isCompleteOutput — truncation is failure', () => {
  const out = (duration: string, streams: ProbeStream[] = [h264(), AAC]) =>
    parseProbe(probe(streams, { duration }), 1_000_000);

  it('accepts within 1% or 0.5 s, whichever is larger', () => {
    expect(isCompleteOutput(3600, out('3564'))).toBe(true); // -1%
    expect(isCompleteOutput(3600, out('3563'))).toBe(false);
    expect(isCompleteOutput(10, out('9.5'))).toBe(true); // 0.5 s floor
    expect(isCompleteOutput(10, out('9.4'))).toBe(false);
    expect(isCompleteOutput(5, out('5.015011'))).toBe(true); // AAC priming
  });

  it('refuses an output cut short by -fs (real run: 12.33 s of 30 s)', () => {
    expect(isCompleteOutput(30, out('12.33'))).toBe(false);
  });

  it('refuses an output with no picture track', () => {
    expect(isCompleteOutput(60, out('60', [AAC]))).toBe(false);
  });
});

describe('argument lists — arrays, fixed shape, numbers only', () => {
  const IN = '/tmp/media-video-abc/input';
  const OUT = '/tmp/media-video-abc/web.mp4';

  const fenced = (args: string[]) => {
    expect(args.slice(0, 1)).toEqual(['-nostdin']);
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe');
    expect(args[args.indexOf('-format_whitelist') + 1]).toBe(FORMAT_WHITELIST);
    // Input options precede the input.
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    expect(args.indexOf('-format_whitelist')).toBeLessThan(args.indexOf('-i'));
  };

  it('remux: copy the mapped tracks, faststart, -fs, our own paths', () => {
    const d = decideVideo(facts(probe([h264(), AAC])), 'mp4');
    const args = renditionArgs({
      input: IN,
      output: OUT,
      decision: d,
      audioIndex: 1,
      inputBytes: 1_000_000_000,
    });
    fenced(args);
    expect(args).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      FORMAT_WHITELIST,
      '-i',
      IN,
      '-map',
      '0:0',
      '-map',
      '0:1',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-fs',
      '1500000000',
      '-f',
      'mp4',
      '-y',
      OUT,
    ]);
  });

  it('transcode: libx264 veryfast crf 23 yuv420p High, scaled, aac 128k', () => {
    const d = decideVideo(
      facts(probe([h264({ width: 2560, height: 1440, pix_fmt: 'yuv444p' }), AAC])),
      'mp4'
    );
    const args = renditionArgs({
      input: IN,
      output: OUT,
      decision: d,
      audioIndex: 1,
      inputBytes: 1,
    });
    fenced(args);
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after('-vf')).toBe('scale=1920:1080');
    expect(after('-c:v')).toBe('libx264');
    expect(after('-preset')).toBe('veryfast');
    expect(after('-crf')).toBe('23');
    expect(after('-pix_fmt')).toBe('yuv420p');
    expect(after('-profile:v')).toBe('high');
    expect(after('-c:a')).toBe('aac');
    expect(after('-b:a')).toBe('128k');
    expect(after('-movflags')).toBe('+faststart');
    expect(after('-fs')).toBe(String(OUTPUT_CAP_FLOOR));
    expect(args.at(-1)).toBe(OUT);
  });

  it('no audio → -an and no audio map', () => {
    const d = decideVideo(facts(probe([h264({ pix_fmt: 'yuv444p' })])), 'mp4');
    const args = renditionArgs({
      input: IN,
      output: OUT,
      decision: d,
      audioIndex: null,
      inputBytes: 1,
    });
    expect(args).toContain('-an');
    expect(args.filter(a => a === '-map')).toHaveLength(1);
    expect(args).not.toContain('-c:a');
  });

  it('every element is a plain string; no shell metacharacters from the probe', () => {
    const d = decideVideo(facts(probe([h264({ codec_name: 'hevc; touch /x' }), AAC])), 'mp4');
    const args = renditionArgs({
      input: IN,
      output: OUT,
      decision: d,
      audioIndex: 1,
      inputBytes: 5,
    });
    for (const a of args) expect(typeof a).toBe('string');
    expect(args.join(' ')).not.toMatch(/touch|;/);
  });

  it('refuses a non-integer stream index outright', () => {
    const d = decideVideo(facts(probe([h264(), AAC])), 'mp4');
    expect(() =>
      renditionArgs({ input: IN, output: OUT, decision: d, audioIndex: 1.5, inputBytes: 1 })
    ).toThrow(TypeError);
    expect(() =>
      renditionArgs({
        input: IN,
        output: OUT,
        decision: { ...d, video: { ...d.video, index: -1 } },
        audioIndex: null,
        inputBytes: 1,
      })
    ).toThrow(TypeError);
  });

  it('poster: seek before input, one frame, ≤1280 wide, JPEG from the built-in mjpeg encoder', () => {
    const args = posterArgs({
      rendition: OUT,
      output: '/tmp/media-video-abc/poster.jpg',
      durationSec: 60,
      renditionWidth: 1920,
    });
    fenced(args);
    expect(args[args.indexOf('-ss') + 1]).toBe('1.000');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1280:-2,format=yuvj420p');
    expect(args[args.indexOf('-c:v') + 1]).toBe('mjpeg');
    expect(args[args.indexOf('-q:v') + 1]).toBe('3');
    expect(args[args.indexOf('-f') + 1]).toBe('mjpeg');
    expect(args).toContain('-an');
    expect(args).not.toContain('libwebp');
    expect(args.at(-1)).toBe('/tmp/media-video-abc/poster.jpg');
    // Never upscaled.
    const small = posterArgs({ rendition: OUT, output: 'p', durationSec: 1, renditionWidth: 640 });
    expect(small[small.indexOf('-vf') + 1]).toBe('scale=640:-2,format=yuvj420p');
    expect(small[small.indexOf('-ss') + 1]).toBe('0.500');
  });

  it('probe: whitelisted, JSON, the file last', () => {
    const args = probeArgs(IN);
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe');
    expect(args[args.indexOf('-format_whitelist') + 1]).toBe(FORMAT_WHITELIST);
    expect(args[args.indexOf('-print_format') + 1]).toBe('json');
    expect(args.at(-1)).toBe(IN);
  });
});
