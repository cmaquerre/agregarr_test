import PlexAPI from '@server/api/plexapi';
import type { PlexMetadata } from '@server/api/plexapi';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getRepository } from '@server/datasource';
import { LanguageTagRecord } from '@server/entity/LanguageTagRecord';
import { getAdminUser } from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  getAudioLanguagesFromFile,
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

function parseLanguageString(str: string): string[] {
  if (!str?.trim()) return [];
  return str
    .split(/[/,;|]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function detectTag(audioLanguages: string[]): LanguageTag {
  if (audioLanguages.length === 0) return 'VOSTFR';
  const hasFrench = audioLanguages.some(isFrench);
  const hasOther = audioLanguages.some((l) => !isFrench(l));
  if (hasFrench && !hasOther) return 'VF';
  if (hasFrench && hasOther) return 'MULTI';
  return 'VOSTFR';
}

function detectTagFromString(langStr: string): LanguageTag {
  return detectTag(parseLanguageString(langStr));
}

function determineMajorityTag(tags: LanguageTag[]): LanguageTag {
  if (tags.length === 0) return 'VOSTFR';
  const counts: Record<LanguageTag, number> = { VF: 0, MULTI: 0, VOSTFR: 0 };
  for (const tag of tags) counts[tag]++;
  const max = Math.max(counts.VF, counts.MULTI, counts.VOSTFR);
  if (counts.VF === max) return 'VF';
  if (counts.MULTI === max) return 'MULTI';
  return 'VOSTFR';
}

function buildServarrUrl(instance: {
  useSsl: boolean;
  hostname: string;
  port: number;
  baseUrl?: string;
}): string {
  return `${instance.useSsl ? 'https' : 'http'}://${instance.hostname}:${instance.port}${instance.baseUrl ?? ''}/api/v3`;
}

/** Extract file paths from Plex Part objects (episode or movie). */
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
 * Apply configured path mappings to translate a Plex-reported file path
 * into the equivalent path inside the Docker container.
 * e.g. /mnt/nas/movies/film.mkv → /media/movies/film.mkv
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
    // exact match (no trailing slash)
    if (filePath === plexPath) return localPath;
  }
  return filePath;
}

class LanguageTaggerService {
  private getRadarrApis(): RadarrAPI[] {
    const settings = getSettings();
    return settings.radarr.map(
      (s) => new RadarrAPI({ url: buildServarrUrl(s), apiKey: s.apiKey })
    );
  }

  private getSonarrApis(): SonarrAPI[] {
    const settings = getSettings();
    return settings.sonarr.map(
      (s) => new SonarrAPI({ url: buildServarrUrl(s), apiKey: s.apiKey })
    );
  }

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
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(params.seasonTags).map(([k, v]) => [k, v])
          )
        )
      : undefined;
    record.source = params.source;
    await repo.save(record);
  }

  // ---------------------------------------------------------------------------
  // Radarr / Sonarr detection
  // ---------------------------------------------------------------------------

  private async fetchMovieTagFromRadarr(
    tmdbId: number
  ): Promise<{ tag: LanguageTag; source: 'radarr' } | null> {
    for (const api of this.getRadarrApis()) {
      try {
        const movies = await api.getMoviesFilteredByTmdbId(tmdbId);
        const movie = movies.find((m) => m.hasFile);
        if (!movie) continue;

        const files = await api.getMovieFilesByMovieId(movie.id);
        if (!files.length) continue;

        const langStr = files[0].mediaInfo?.audioLanguages ?? '';
        if (!langStr.trim()) continue; // no mediaInfo analyzed yet

        return { tag: detectTagFromString(langStr), source: 'radarr' };
      } catch {
        // try next instance
      }
    }
    return null;
  }

  private async fetchShowTagsFromSonarr(tmdbId: number): Promise<{
    seriesTag: LanguageTag;
    seasonTags: Record<number, LanguageTag>;
    source: 'sonarr';
  } | null> {
    for (const api of this.getSonarrApis()) {
      try {
        const series = await api.getSeriesByTmdbId(tmdbId);
        if (!series?.id) continue;

        const files = await api.getEpisodeFilesBySeries(series.id);
        if (!files.length) continue;

        const seasonGroups = new Map<number, LanguageTag[]>();
        let anyLang = false;

        for (const file of files) {
          const langStr = file.mediaInfo?.audioLanguages ?? '';
          if (!langStr.trim()) continue;
          anyLang = true;
          const tag = detectTagFromString(langStr);
          if (!seasonGroups.has(file.seasonNumber)) {
            seasonGroups.set(file.seasonNumber, []);
          }
          seasonGroups.get(file.seasonNumber)!.push(tag);
        }

        if (!anyLang) continue;

        const seasonTags: Record<number, LanguageTag> = {};
        for (const [season, tags] of seasonGroups) {
          seasonTags[season] = determineMajorityTag(tags);
        }
        const seriesTag = determineMajorityTag(Object.values(seasonTags));

        return { seriesTag, seasonTags, source: 'sonarr' };
      } catch {
        // try next instance
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // ffprobe fallback (file paths from Plex metadata)
  // ---------------------------------------------------------------------------

  private async fetchMovieTagFromFfprobe(
    ratingKey: string,
    plexApi: PlexAPI
  ): Promise<{ tag: LanguageTag; source: 'ffprobe' } | null> {
    if (!(await isFfprobeAvailable())) return null;
    try {
      const metadata = await plexApi.getMetadata(ratingKey);
      const paths = extractFilePaths(metadata).map(applyPathMappings);
      if (!paths.length) return null;

      const langs = await getAudioLanguagesFromFile(paths[0]);
      if (!langs.length) return null;

      return { tag: detectTag(langs), source: 'ffprobe' };
    } catch {
      return null;
    }
  }

  private async fetchShowTagsFromFfprobe(
    showRatingKey: string,
    plexApi: PlexAPI
  ): Promise<{
    seriesTag: LanguageTag;
    seasonTags: Record<number, LanguageTag>;
    source: 'ffprobe';
  } | null> {
    if (!(await isFfprobeAvailable())) return null;

    try {
      const seasons = await plexApi.getChildrenMetadata(showRatingKey);
      const seasonTags: Record<number, LanguageTag> = {};
      let anyTag = false;

      for (const season of seasons) {
        if (season.type !== 'season') continue;
        const seasonNumber =
          season.index ?? 0;

        const episodes = await plexApi.getChildrenMetadata(season.ratingKey);
        const episodeTags: LanguageTag[] = [];

        for (const episode of episodes) {
          if (episode.type !== 'episode') continue;
          const paths = extractFilePaths(episode).map(applyPathMappings);
          if (!paths.length) continue;

          const langs = await getAudioLanguagesFromFile(paths[0]);
          if (langs.length) {
            episodeTags.push(detectTag(langs));
            anyTag = true;
          }
        }

        if (episodeTags.length) {
          seasonTags[seasonNumber] = determineMajorityTag(episodeTags);
        }
      }

      if (!anyTag) return null;

      const seriesTag = determineMajorityTag(
        Object.values(seasonTags) as LanguageTag[]
      );
      return { seriesTag, seasonTags, source: 'ffprobe' };
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
    const radarrResult = await this.fetchMovieTagFromRadarr(tmdbId);

    if (radarrResult) {
      await this.saveRecord({
        ratingKey,
        title,
        mediaType: 'movie',
        tmdbId,
        tag: radarrResult.tag,
        source: radarrResult.source,
      });
      logger.info('LanguageTagger: tagged movie via Radarr', {
        label: 'LanguageTagger',
        title,
        tag: radarrResult.tag,
      });
      return;
    }

    // Fallback: ffprobe
    const ffResult = await this.fetchMovieTagFromFfprobe(ratingKey, plexApi);
    if (ffResult) {
      await this.saveRecord({
        ratingKey,
        title,
        mediaType: 'movie',
        tmdbId,
        tag: ffResult.tag,
        source: ffResult.source,
      });
      logger.info('LanguageTagger: tagged movie via ffprobe', {
        label: 'LanguageTagger',
        title,
        tag: ffResult.tag,
      });
    } else {
      logger.debug('LanguageTagger: no language info found for movie', {
        label: 'LanguageTagger',
        title,
        tmdbId,
      });
    }
  }

  async tagShow(
    showRatingKey: string,
    title: string,
    tmdbId: number,
    plexApi: PlexAPI
  ): Promise<void> {
    const sonarrResult = await this.fetchShowTagsFromSonarr(tmdbId);

    if (sonarrResult) {
      await this.saveRecord({
        ratingKey: showRatingKey,
        title,
        mediaType: 'show',
        tmdbId,
        tag: sonarrResult.seriesTag,
        seasonTags: sonarrResult.seasonTags,
        source: sonarrResult.source,
      });
      logger.info('LanguageTagger: tagged show via Sonarr', {
        label: 'LanguageTagger',
        title,
        seriesTag: sonarrResult.seriesTag,
      });
      return;
    }

    // Fallback: ffprobe
    const ffResult = await this.fetchShowTagsFromFfprobe(
      showRatingKey,
      plexApi
    );
    if (ffResult) {
      await this.saveRecord({
        ratingKey: showRatingKey,
        title,
        mediaType: 'show',
        tmdbId,
        tag: ffResult.seriesTag,
        seasonTags: ffResult.seasonTags,
        source: ffResult.source,
      });
      logger.info('LanguageTagger: tagged show via ffprobe', {
        label: 'LanguageTagger',
        title,
        seriesTag: ffResult.seriesTag,
      });
    } else {
      logger.debug('LanguageTagger: no language info found for show', {
        label: 'LanguageTagger',
        title,
        tmdbId,
      });
    }
  }

  async runLibraryTagging(
    plexApi: PlexAPI,
    libraryId: string,
    mediaType: 'movie' | 'show'
  ): Promise<TaggingResult> {
    const result: TaggingResult = {
      tagged: 0,
      skipped: 0,
      errors: 0,
      items: [],
    };

    let offset = 0;
    const pageSize = 50;

    while (true) {
      const { items, totalSize } = await plexApi.getLibraryContents(
        libraryId,
        { offset, size: pageSize }
      );

      for (const item of items) {
        const tmdbGuid = item.Guid?.find((g) => g.id.startsWith('tmdb://'));
        const tmdbId = tmdbGuid
          ? parseInt(tmdbGuid.id.replace('tmdb://', ''), 10)
          : NaN;

        if (isNaN(tmdbId)) {
          result.skipped++;
          result.items.push({
            title: item.title,
            ratingKey: item.ratingKey,
            tag: null,
          });
          continue;
        }

        try {
          if (mediaType === 'movie') {
            let res: { tag: LanguageTag; source: string } | null =
              await this.fetchMovieTagFromRadarr(tmdbId);
            if (!res) res = await this.fetchMovieTagFromFfprobe(item.ratingKey, plexApi);

            if (res) {
              await this.saveRecord({
                ratingKey: item.ratingKey,
                title: item.title,
                mediaType: 'movie',
                tmdbId,
                tag: res.tag,
                source: res.source,
              });
              result.tagged++;
              result.items.push({
                title: item.title,
                ratingKey: item.ratingKey,
                tag: res.tag,
                source: res.source,
              });
            } else {
              result.skipped++;
              result.items.push({
                title: item.title,
                ratingKey: item.ratingKey,
                tag: null,
              });
            }
          } else {
            let res = await this.fetchShowTagsFromSonarr(tmdbId);

            if (res) {
              await this.saveRecord({
                ratingKey: item.ratingKey,
                title: item.title,
                mediaType: 'show',
                tmdbId,
                tag: res.seriesTag,
                seasonTags: res.seasonTags,
                source: res.source,
              });
              result.tagged++;
              result.items.push({
                title: item.title,
                ratingKey: item.ratingKey,
                tag: res.seriesTag,
                source: res.source,
              });
            } else {
              // ffprobe fallback for shows
              const ffRes = await this.fetchShowTagsFromFfprobe(
                item.ratingKey,
                plexApi
              );
              if (ffRes) {
                await this.saveRecord({
                  ratingKey: item.ratingKey,
                  title: item.title,
                  mediaType: 'show',
                  tmdbId,
                  tag: ffRes.seriesTag,
                  seasonTags: ffRes.seasonTags,
                  source: ffRes.source,
                });
                result.tagged++;
                result.items.push({
                  title: item.title,
                  ratingKey: item.ratingKey,
                  tag: ffRes.seriesTag,
                  source: ffRes.source,
                });
              } else {
                result.skipped++;
                result.items.push({
                  title: item.title,
                  ratingKey: item.ratingKey,
                  tag: null,
                });
              }
            }
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

  async getRecords(params?: {
    mediaType?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ records: LanguageTagRecord[]; total: number }> {
    const repo = getRepository(LanguageTagRecord);
    const qb = repo.createQueryBuilder('r').orderBy('r.updatedAt', 'DESC');

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
