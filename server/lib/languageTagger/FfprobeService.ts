import { spawn } from 'child_process';
import logger from '@server/logger';

interface FfprobeStream {
  codec_type: string;
  tags?: { language?: string };
}

interface FfprobeResult {
  streams: FfprobeStream[];
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

export async function getAudioLanguagesFromFile(
  filePath: string
): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      '-select_streams',
      'a',
      filePath,
    ]);

    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));

    let killTimer: ReturnType<typeof setTimeout>;

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        const parsed: FfprobeResult = JSON.parse(stdout);
        const langs = parsed.streams
          .filter((s) => s.codec_type === 'audio')
          .map((s) => s.tags?.language ?? '')
          .filter(Boolean);
        resolve(langs);
      } catch {
        resolve([]);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      logger.debug('FfprobeService: spawn error', {
        label: 'FfprobeService',
        error: err.message,
        filePath,
      });
      resolve([]);
    });

    killTimer = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve([]);
    }, 30_000);
  });
}
