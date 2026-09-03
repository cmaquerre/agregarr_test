import PlexAPI from '@server/api/plexapi';
import type { PlexMetadata } from '@server/api/plexapi';
import { getRepository } from '@server/datasource';
import { LanguageTagRecord } from '@server/entity/LanguageTagRecord';
import { getAdminUser } from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  getStreamLanguagesFromFile,
  isFfprobeAvailable,
} from './FfprobeService';

export type LanguageTag = 'VF' | 'MULTI' | 'VOSTFR';
export const LANGUAGE_TAGS: LanguageTag[] = ['VF', 'MULTI', 'VOSTFR'];

const FRENCH_CODES = new Set([
  'french',
  'fre',
  'fra',
  'fr',
  'français',
  'francais',
]);

export interface TaggingResult {
  tagged: number;
  skipped: number;
  errors: number;
  items: {
    title: string;
    ratingKey: string;
    tag: LanguageTag | null;
    source?: string;
    error?: string;
  }[];
}

function isFrench(lang: string): boolean {
  return FRENCH_CODES.has(lang.toLowerCase().trim());
}

/**
 * Determine the language tag from audio and subtitle streams.
 *
 *   MULTI   — French audio + at least one other-language audio track
 *   VF      — French audio only
 *   VOSTFR  — No French audio (original version, French subs may be present)
 */
function detectTag(audio: string[], subtitles: string[] = []): LanguageTag {
  const hasFrenchAudio = audio.some(isFrench);
  const hasOtherAudio  = audio.some((l) => !isFrench(l));
  if (hasFrenchAudio && hasOtherAudio) return 'MULTI';
  if (hasFrenchAudio) return 'VF';
  return 'VOSTFR';
}

function determineMajorityTag(tags: LanguageTag[]): LanguageTag {
  if (tags.length === 0) return 'VOSTFR';
  const counts: Record<LanguageTag, number> = { VF: 0, MULTI: 0, VOSTFR: 0 };
  for (const tag of tags) counts[tag]++;
  const max = Math.max(counts.VF, counts.MULTI, counts.VOSTFR);
  if (counts.MULTI === max) return 'MULTI';
  if (counts.VF === max) return 'VF';
  return 'VOSTFR';
}

/**
 * Extract audio (streamType 2) and subtitle (streamType 3) language codes
 * from a Plex metadata object's Media.Part.Stream entries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPlexStreamLanguages(obj: any): { audio: string[]; subtitles: string[] } {
  const audio = new Set<string>();
  const subtitles = new Set<string>();
  for (const media of obj?.Media ?? []) {
    for (const part of media?.Part ?? []) {
      for (const stream of part?.Stream ?? []) {
        const lang: string | undefined = stream?.languageCode ?? stream?.language;
        if (!lang?.trim()) continue;
        if (stream.streamType === 2) audio.add(lang.toLowerCase().trim());
        else if (stream.streamType === 3) subtitles.add(lang.toLowerCase().trim());
      }
    }
  }
  return { audio: [...audio], subtitles: [...subtitles] };
}

/** Extract file paths from Plex Part objects. */
function extractFilePaths(metadata: PlexMetadata): string[] {
  const paths: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mediaList: any[] = (metadata as any).Media ?? [];
  for (const media of mediaList) {
    for (const part of media?.Part ?? []) {
      if (part?.file) paths.push(part.file as string);
    }
  }
  return paths;
}

/**
 * Translate a Plex-reported file path to the local container path
 * using the path mappings configured in Settings > Media Folders.
 */
function applyPathMappings(filePath: string): string {
  const settings = getSettings();
  const mappings = settings.mediaFolders?.pathMappings ?? [];
  for (const { plexPath, localPath } of mappings) {
    const prefix = plexPath.endsWith('/') ? plexPath : plexPath + '/';
    if (filePath.startsWith(prefix)) {
      const base = localPath.endsWith('/') ? localPath : localPath + '/';
      return base + filePath.slice(prefix.length);
    }
    if (filePath === plexPath) return localPath;
  }
  return filePath;
}

type MovieTagEntry = { tag: LanguageTag; source: 'plex' | 'ffprobe' };

/** seasonRatingKeys maps season number → Plex ratingKey for per-season record storage. */
type ShowTagEntry = {
  seriesTag: LanguageTag;
  seasonTags: Record<number, LanguageTag>;
  seasonRatingKeys: Record<number, string>;
  source: 'plex' | 'ffprobe';
};

class LanguageTaggerService {
  private async saveRecord(params: {
    ratingKey: string;
    title: string;
    mediaType: string;
    tmdbId?: number;
    tag: LanguageTag;
    seasonTags?: Record<number, LanguageTag>;
    source: string;
  }): Promise<void> {
    const repo = getRepository(LanguageTagRecord);
    let record = await repo.findOne({ where: { ratingKey: params.ratingKey } });
    if (!record) {
      record = repo.create({ ratingKey: params.ratingKey });
    }
    record.title = params.title;
    record.mediaType = params.mediaType;
    record.tmdbId = params.tmdbId;
    record.tag = params.tag;
    record.seasonTagsJson = params.seasonTags
      ? JSON.stringify(params.seasonTags)
      : undefined;
    record.source = params.source;
    await repo.save(record);
  }

  /** Save one record per season so overlays can resolve per-season language tags by ratingKey. */
  private async saveSeasonRecords(
    showTitle: string,
    tmdbId: number | undefined,
    seasonTags: Record<number, LanguageTag>,
    seasonRatingKeys: Record<number, string>,
    source: string
  ): Promise<void> {
    for (const [seasonNumberStr, tag] of Object.entries(seasonTags)) {
      const seasonNumber = parseInt(seasonNumberStr, 10);
      const seasonRatingKey = seasonRatingKeys[seasonNumber];
      if (!seasonRatingKey) continue;
      await this.saveRecord({
        ratingKey: seasonRatingKey,
        title: `${showTitle} — S${String(seasonNumber).padStart(2, '0')}`,
        mediaType: 'season',
        tmdbId,
        tag,
        source,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Plex stream detection
  // ---------------------------------------------------------------------------

  private async fetchMovieTagFromPlex(
    ratingKey: string,
    plexApi: PlexAPI
  ): Promise<MovieTagEntry | null> {
    try {
      const metadata = await plexApi.getMetadata(ratingKey);
      const { audio, subtitles } = extractPlexStreamLanguages(metadata);
      if (!audio.length && !subtitles.length) return null;
      return { tag: detectTag(audio, subtitles), source: 'plex' };
    } catch {
      return null;
    }
  }

  private async fetchShowTagsFromPlex(
    showRatingKey: string,
    plexApi: PlexAPI
  ): Promise<ShowTagEntry | null> {
    try {
      const seasons = await plexApi.getChildrenMetadata(showRatingKey);
      const seasonTags: Record<number, LanguageTag> = {};
      const seasonRatingKeys: Record<number, string> = {};
      let anyTag = false;

      for (const season of seasons) {
        if (season.type !== 'season') continue;
        const seasonNumber = season.index ?? 0;
        seasonRatingKeys[seasonNumber] = season.ratingKey;

        // getChildrenMetadata does not include Stream data for episodes —
        // call getMetadata per episode to get language info.
        // Sample the first 3 episodes per season to keep API calls bounded.
        const episodeList = await plexApi.getChildrenMetadata(season.ratingKey);
        const sampleKeys = episodeList
          .filter((ep) => ep.type === 'episode')
          .slice(0, 3)
          .map((ep) => ep.ratingKey);

        const episodeTags: LanguageTag[] = [];
        for (const key of sampleKeys) {
          try {
            const fullMeta = await plexApi.getMetadata(key);
            const { audio, subtitles } = extractPlexStreamLanguages(fullMeta);
            if (audio.length || subtitles.length) {
              episodeTags.push(detectTag(audio, subtitles));
            }
          } catch {
            // skip this episode
          }
        }

        if (episodeTags.length) {
          seasonTags[seasonNumber] = determineMajorityTag(episodeTags);
          anyTag = true;
        }
      }

      if (!anyTag) return null;

      return {
        seriesTag: determineMajorityTag(Object.values(seasonTags)),
        seasonTags,
        seasonRatingKeys,
        source: 'plex',
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // ffprobe fallback (when Plex has no stream metadata)
  // ---------------------------------------------------------------------------

  private async fetchMovieTagFromFfprobe(
    ratingKey: string,
    plexApi: PlexAPI
  ): Promise<MovieTagEntry | null> {
    if (!(await isFfprobeAvailable())) return null;
    try {
      const metadata = await plexApi.getMetadata(ratingKey);
      const paths = extractFilePaths(metadata).map(applyPathMappings);
      if (!paths.length) return null;

      const { audio, subtitles } = await getStreamLanguagesFromFile(paths[0]);
      if (!audio.length && !subtitles.length) return null;

      return { tag: detectTag(audio, subtitles), source: 'ffprobe' };
    } catch {
      return null;
    }
  }

  private async fetchShowTagsFromFfprobe(
    showRatingKey: string,
    plexApi: PlexAPI
  ): Promise<ShowTagEntry | null> {
    if (!(await isFfprobeAvailable())) return null;

    try {
      const seasons = await plexApi.getChildrenMetadata(showRatingKey);
      const seasonTags: Record<number, LanguageTag> = {};
      const seasonRatingKeys: Record<number, string> = {};
      let anyTag = false;

      for (const season of seasons) {
        if (season.type !== 'season') continue;
        const seasonNumber = season.index ?? 0;
        seasonRatingKeys[seasonNumber] = season.ratingKey;

        const episodeList = await plexApi.getChildrenMetadata(season.ratingKey);
        const sampleKeys = episodeList
          .filter((ep) => ep.type === 'episode')
          .slice(0, 3)
          .map((ep) => ep.ratingKey);

        const episodeFiles: string[] = [];
        for (const key of sampleKeys) {
          try {
            const fullMeta = await plexApi.getMetadata(key);
            const file = extractFilePaths(fullMeta).map(applyPathMappings)[0];
            if (file) episodeFiles.push(file);
          } catch {
            // skip
          }
        }

        const streamResults = await Promise.all(
          episodeFiles.map((f) => getStreamLanguagesFromFile(f))
        );

        const episodeTags = streamResults
          .filter(({ audio, subtitles }) => audio.length > 0 || subtitles.length > 0)
          .map(({ audio, subtitles }) => detectTag(audio, subtitles));

        if (episodeTags.length) {
          seasonTags[seasonNumber] = determineMajorityTag(episodeTags);
          anyTag = true;
        }
      }

      if (!anyTag) return null;

      return {
        seriesTag: determineMajorityTag(Object.values(seasonTags) as LanguageTag[]),
        seasonTags,
        seasonRatingKeys,
        source: 'ffprobe',
      };
    } catch (e) {
      logger.debug('LanguageTagger: ffprobe show scan failed', {
        label: 'LanguageTagger',
        showRatingKey,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async tagMovie(
    ratingKey: string,
    title: string,
    tmdbId: number,
    plexApi: PlexAPI
  ): Promise<void> {
    const result =
      (await this.fetchMovieTagFromPlex(ratingKey, plexApi)) ??
      (await this.fetchMovieTagFromFfprobe(ratingKey, plexApi));

    if (result) {
      await this.saveRecord({ ratingKey, title, mediaType: 'movie', tmdbId, tag: result.tag, source: result.source });
      logger.info('LanguageTagger: tagged movie', { label: 'LanguageTagger', title, tag: result.tag, source: result.source });
    } else {
      logger.debug('LanguageTagger: no language info found for movie', { label: 'LanguageTagger', title, tmdbId });
    }
  }

  async tagShow(
    showRatingKey: string,
    title: string,
    tmdbId: number,
    plexApi: PlexAPI
  ): Promise<void> {
    const result =
      (await this.fetchShowTagsFromPlex(showRatingKey, plexApi)) ??
      (await this.fetchShowTagsFromFfprobe(showRatingKey, plexApi));

    if (result) {
      await this.saveRecord({
        ratingKey: showRatingKey,
        title,
        mediaType: 'show',
        tmdbId,
        tag: result.seriesTag,
        seasonTags: result.seasonTags,
        source: result.source,
      });
      await this.saveSeasonRecords(title, tmdbId, result.seasonTags, result.seasonRatingKeys, result.source);
      logger.info('LanguageTagger: tagged show', { label: 'LanguageTagger', title, tag: result.seriesTag, source: result.source });
    } else {
      logger.debug('LanguageTagger: no language info found for show', { label: 'LanguageTagger', title, tmdbId });
    }
  }

  async runLibraryTagging(
    plexApi: PlexAPI,
    libraryId: string,
    mediaType: 'movie' | 'show',
    clearFirst = true
  ): Promise<TaggingResult> {
    if (clearFirst) {
      // Clear existing records for this media type (and season records for shows)
      // so stale entries from previous scans don't linger.
      const repo = getRepository(LanguageTagRecord);
      const typesToClear = mediaType === 'show' ? ['show', 'season'] : ['movie'];
      await repo
        .createQueryBuilder()
        .delete()
        .where('mediaType IN (:...types)', { types: typesToClear })
        .execute();
      logger.info('LanguageTagger: cleared records before scan', {
        label: 'LanguageTagger',
        mediaType,
        typesToClear,
      });
    }

    const result: TaggingResult = { tagged: 0, skipped: 0, errors: 0, items: [] };
    let offset = 0;
    const pageSize = 50;

    while (true) {
      const { items, totalSize } = await plexApi.getLibraryContents(libraryId, { offset, size: pageSize });

      for (const item of items) {
        const tmdbGuid = item.Guid?.find((g) => g.id.startsWith('tmdb://'));
        const tmdbId = tmdbGuid ? parseInt(tmdbGuid.id.replace('tmdb://', ''), 10) : undefined;

        try {
          let tag: LanguageTag | null = null;
          let source: string | undefined;
          let seasonTags: Record<number, LanguageTag> | undefined;
          let seasonRatingKeys: Record<number, string> | undefined;

          if (mediaType === 'movie') {
            const entry =
              (await this.fetchMovieTagFromPlex(item.ratingKey, plexApi)) ??
              (await this.fetchMovieTagFromFfprobe(item.ratingKey, plexApi));
            if (entry) { tag = entry.tag; source = entry.source; }
          } else {
            const entry =
              (await this.fetchShowTagsFromPlex(item.ratingKey, plexApi)) ??
              (await this.fetchShowTagsFromFfprobe(item.ratingKey, plexApi));
            if (entry) {
              tag = entry.seriesTag;
              source = entry.source;
              seasonTags = entry.seasonTags;
              seasonRatingKeys = entry.seasonRatingKeys;
            }
          }

          if (tag) {
            await this.saveRecord({ ratingKey: item.ratingKey, title: item.title, mediaType, tmdbId, tag, seasonTags, source: source! });
            if (seasonTags && seasonRatingKeys) {
              await this.saveSeasonRecords(item.title, tmdbId, seasonTags, seasonRatingKeys, source!);
            }
            result.tagged++;
            result.items.push({ title: item.title, ratingKey: item.ratingKey, tag, source });
          } else {
            result.skipped++;
            result.items.push({ title: item.title, ratingKey: item.ratingKey, tag: null });
          }
        } catch (e) {
          result.errors++;
          result.items.push({
            title: item.title,
            ratingKey: item.ratingKey,
            tag: null,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      offset += items.length;
      if (offset >= totalSize || items.length === 0) break;
    }

    logger.info('LanguageTagger: library run complete', {
      label: 'LanguageTagger',
      libraryId,
      mediaType,
      tagged: result.tagged,
      skipped: result.skipped,
      errors: result.errors,
    });

    return result;
  }

  /**
   * Tag all overlay-configured libraries. Called by the scheduled job.
   * Clears all records once at the start then processes each library without
   * clearing between runs so multi-library setups accumulate correctly.
   */
  async runAllLibraryTagging(): Promise<void> {
    const settings = getSettings();
    if (!settings.languageTagger?.enabled) {
      logger.info('LanguageTagger: tagger not enabled, skipping scheduled run', {
        label: 'LanguageTagger',
      });
      return;
    }

    const plexApi = await this.getPlexApi();
    if (!plexApi) {
      logger.warn('LanguageTagger: Plex not configured, skipping scheduled run', {
        label: 'LanguageTagger',
      });
      return;
    }

    const { getRepository: getRepo } = await import('@server/datasource');
    const { OverlayLibraryConfig } = await import('@server/entity/OverlayLibraryConfig');
    const configs = await getRepo(OverlayLibraryConfig).find();

    if (configs.length === 0) {
      logger.info('LanguageTagger: no overlay libraries configured, skipping scheduled run', {
        label: 'LanguageTagger',
      });
      return;
    }

    logger.info('LanguageTagger: starting scheduled library tagging', {
      label: 'LanguageTagger',
      libraryCount: configs.length,
    });

    // Clear all records once before the full sweep
    await this.clearRecords();

    let totalTagged = 0;
    let totalErrors = 0;

    for (const config of configs) {
      try {
        const result = await this.runLibraryTagging(
          plexApi,
          config.libraryId,
          config.mediaType,
          false // already cleared above
        );
        totalTagged += result.tagged;
        totalErrors += result.errors;
      } catch (error) {
        logger.error('LanguageTagger: failed to tag library', {
          label: 'LanguageTagger',
          libraryId: config.libraryId,
          libraryName: config.libraryName,
          error: error instanceof Error ? error.message : String(error),
        });
        totalErrors++;
      }
    }

    logger.info('LanguageTagger: scheduled tagging complete', {
      label: 'LanguageTagger',
      totalTagged,
      totalErrors,
    });
  }

  async clearRecords(): Promise<{ deleted: number }> {
    const repo = getRepository(LanguageTagRecord);
    const all = await repo.find();
    await repo.remove(all);
    logger.info('LanguageTagger: all records cleared', {
      label: 'LanguageTagger',
      deleted: all.length,
    });
    return { deleted: all.length };
  }

  async getRecords(params?: {
    mediaType?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ records: LanguageTagRecord[]; total: number }> {
    const repo = getRepository(LanguageTagRecord);
    const qb = repo
      .createQueryBuilder('r')
      // Exclude season records from the UI list — they are implementation detail
      .where('r.mediaType != :season', { season: 'season' })
      .orderBy('r.updatedAt', 'DESC');

    if (params?.mediaType) qb.andWhere('r.mediaType = :mt', { mt: params.mediaType });
    if (params?.tag) qb.andWhere('r.tag = :tag', { tag: params.tag });

    const total = await qb.getCount();
    if (params?.limit) qb.limit(params.limit);
    if (params?.offset) qb.offset(params.offset);

    const records = await qb.getMany();
    return { records, total };
  }

  async getPlexApi(): Promise<PlexAPI | null> {
    try {
      const admin = await getAdminUser();
      if (!admin?.plexToken) return null;
      return new PlexAPI({ plexToken: admin.plexToken });
    } catch {
      return null;
    }
  }
}

export const languageTaggerService = new LanguageTaggerService();
