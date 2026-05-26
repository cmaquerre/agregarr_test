import { spawn } from 'child_process';
import logger from '@server/logger';

interface FfprobeStream {
  codec_type: string;
  tags?: { language?: string };
}

interface FfprobeResult {
  streams: FfprobeStream[];
}

export interface StreamLanguages {
  audio: string[];
  subtitles: string[];
}

let ffprobeAvailableCache: boolean | null = null;

export async function isFfprobeAvailable(): Promise<boolean> {
  if (ffprobeAvailableCache !== null) return ffprobeAvailableCache;
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-version']);
    proc.on('close', (code) => {
      ffprobeAvailableCache = code === 0;
      resolve(ffprobeAvailableCache);
    });
    proc.on('error', () => {
      ffprobeAvailableCache = false;
      resolve(false);
    });
  });
}

/** Returns audio and subtitle language codes from a media file using ffprobe. */
export async function getStreamLanguagesFromFile(
  filePath: string
): Promise<StreamLanguages> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      filePath,
    ]);

    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));

    let killTimer: ReturnType<typeof setTimeout>;

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 || !stdout.trim()) {
        resolve({ audio: [], subtitles: [] });
        return;
      }
      try {
        const parsed: FfprobeResult = JSON.parse(stdout);
        const audio = parsed.streams
          .filter((s) => s.codec_type === 'audio')
          .map((s) => s.tags?.language ?? '')
          .filter(Boolean);
        const subtitles = parsed.streams
          .filter((s) => s.codec_type === 'subtitle')
          .map((s) => s.tags?.language ?? '')
          .filter(Boolean);
        resolve({ audio, subtitles });
      } catch {
        resolve({ audio: [], subtitles: [] });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      logger.debug('FfprobeService: spawn error', {
        label: 'FfprobeService',
        error: err.message,
        filePath,
      });
      resolve({ audio: [], subtitles: [] });
    });

    killTimer = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve({ audio: [], subtitles: [] });
    }, 30_000);
  });
}

/** @deprecated Use getStreamLanguagesFromFile instead. */
export async function getAudioLanguagesFromFile(
  filePath: string
): Promise<string[]> {
  const { audio } = await getStreamLanguagesFromFile(filePath);
  return audio;
}
