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
 * Translates a Plex-reported file path to the equivalent Docker container path.
 * Needed when Plex uses host paths that differ from container-mounted paths.
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

type MovieTagEntry = { tag: LanguageTag; source: 'radarr' };
type ShowTagEntry = {
  seriesTag: LanguageTag;
  seasonTags: Record<number, LanguageTag>;
  source: 'sonarr';
};

class LanguageTaggerService {
  private getRadarrApis(): RadarrAPI[] {
    const settings = getSettings();
    return settings.radarr
      .filter((s) => s.hostname)
      .map((s) => new RadarrAPI({ url: RadarrAPI.buildUrl(s, '/api/v3'), apiKey: s.apiKey }));
  }

  private getSonarrApis(): SonarrAPI[] {
    const settings = getSettings();
    return settings.sonarr
      .filter((s) => s.hostname)
      .map((s) => new SonarrAPI({ url: SonarrAPI.buildUrl(s, '/api/v3'), apiKey: s.apiKey }));
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
      ? JSON.stringify(params.seasonTags)
      : undefined;
    record.source = params.source;
    await repo.save(record);
  }

  // ---------------------------------------------------------------------------
  // Bulk tag maps — fetch all at once to avoid N+1 API calls in runLibraryTagging
  // ---------------------------------------------------------------------------

  /**
   * Fetches all Radarr movies and their audio languages in one pass per instance.
   * Returns a map of tmdbId → tag, built once before iterating the library.
   */
  private async buildMovieTagMap(): Promise<Map<number, MovieTagEntry>> {
    const map = new Map<number, MovieTagEntry>();
    for (const api of this.getRadarrApis()) {
      try {
        const movies = await api.getMovies();
        const withFiles = movies.filter((m) => m.hasFile && m.tmdbId);
        const fileResults = await Promise.all(
          withFiles.map((m) => api.getMovieFilesByMovieId(m.id).catch(() => []))
        );
        for (let i = 0; i < withFiles.length; i++) {
          const movie = withFiles[i];
          if (!movie.tmdbId || map.has(movie.tmdbId)) continue;
          const files = fileResults[i];
          if (!files.length) continue;
          const langStr = files[0].mediaInfo?.audioLanguages ?? '';
          if (!langStr.trim()) continue;
          map.set(movie.tmdbId, { tag: detectTagFromString(langStr), source: 'radarr' });
        }
      } catch {
        // skip failing instance
      }
    }
    return map;
  }

  /**
   * Fetches all Sonarr series and their episode file languages in one pass per instance.
   * Returns a map of tmdbId → { seriesTag, seasonTags }, built once before iterating the library.
   */
  private async buildShowTagMap(): Promise<Map<number, ShowTagEntry>> {
    const map = new Map<number, ShowTagEntry>();
    for (const api of this.getSonarrApis()) {
      try {
        const allSeries = await api.getSeries();
        const candidates = allSeries.filter(
          (s) => s.tmdbId && s.statistics?.episodeFileCount > 0
        );
        const fileResults = await Promise.all(
          candidates.map((s) =>
            s.id ? api.getEpisodeFilesBySeries(s.id).catch(() => []) : Promise.resolve([])
          )
        );
        for (let i = 0; i < candidates.length; i++) {
          const series = candidates[i];
          if (!series.tmdbId || map.has(series.tmdbId)) continue;
          const files = fileResults[i];
          if (!files.length) continue;

          const seasonGroups = new Map<number, LanguageTag[]>();
          let anyLang = false;
          for (const file of files) {
            const langStr = file.mediaInfo?.audioLanguages ?? '';
            if (!langStr.trim()) continue;
            anyLang = true;
            const tag = detectTagFromString(langStr);
            const group = seasonGroups.get(file.seasonNumber) ?? [];
            group.push(tag);
            seasonGroups.set(file.seasonNumber, group);
          }
          if (!anyLang) continue;

          const seasonTags: Record<number, LanguageTag> = {};
          for (const [season, tags] of seasonGroups) {
            seasonTags[season] = determineMajorityTag(tags);
          }
          map.set(series.tmdbId, {
            seriesTag: determineMajorityTag(Object.values(seasonTags)),
            seasonTags,
            source: 'sonarr',
          });
        }
      } catch {
        // skip failing instance
      }
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Single-item Radarr / Sonarr detection (used by tagMovie / tagShow on webhook)
  // ---------------------------------------------------------------------------

  private async fetchMovieTagFromRadarr(
    tmdbId: number
  ): Promise<MovieTagEntry | null> {
    for (const api of this.getRadarrApis()) {
      try {
        const movies = await api.getMoviesFilteredByTmdbId(tmdbId);
        const movie = movies.find((m) => m.hasFile);
        if (!movie) continue;

        const files = await api.getMovieFilesByMovieId(movie.id);
        if (!files.length) continue;

        const langStr = files[0].mediaInfo?.audioLanguages ?? '';
        if (!langStr.trim()) continue;

        return { tag: detectTagFromString(langStr), source: 'radarr' };
      } catch {
        // try next instance
      }
    }
    return null;
  }

  private async fetchShowTagsFromSonarr(tmdbId: number): Promise<ShowTagEntry | null> {
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
          const group = seasonGroups.get(file.seasonNumber) ?? [];
          group.push(tag);
          seasonGroups.set(file.seasonNumber, group);
        }

        if (!anyLang) continue;

        const seasonTags: Record<number, LanguageTag> = {};
        for (const [season, tags] of seasonGroups) {
          seasonTags[season] = determineMajorityTag(tags);
        }

        return {
          seriesTag: determineMajorityTag(Object.values(seasonTags)),
          seasonTags,
          source: 'sonarr',
        };
      } catch {
        // try next instance
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // ffprobe fallback
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
        const seasonNumber = season.index ?? 0;

        const episodes = await plexApi.getChildrenMetadata(season.ratingKey);
        const episodeFiles = episodes
          .filter((ep) => ep.type === 'episode')
          .map((ep) => extractFilePaths(ep).map(applyPathMappings)[0])
          .filter(Boolean) as string[];

        // Probe all episodes in the season concurrently
        const langResults = await Promise.all(
          episodeFiles.map((f) => getAudioLanguagesFromFile(f))
        );

        const episodeTags = langResults
          .filter((langs) => langs.length > 0)
          .map((langs) => detectTag(langs));

        if (episodeTags.length) {
          seasonTags[seasonNumber] = determineMajorityTag(episodeTags);
          anyTag = true;
        }
      }

      if (!anyTag) return null;

      return {
        seriesTag: determineMajorityTag(Object.values(seasonTags) as LanguageTag[]),
        seasonTags,
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
      (await this.fetchMovieTagFromRadarr(tmdbId)) ??
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
      (await this.fetchShowTagsFromSonarr(tmdbId)) ??
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
      logger.info('LanguageTagger: tagged show', { label: 'LanguageTagger', title, tag: result.seriesTag, source: result.source });
    } else {
      logger.debug('LanguageTagger: no language info found for show', { label: 'LanguageTagger', title, tmdbId });
    }
  }

  async runLibraryTagging(
    plexApi: PlexAPI,
    libraryId: string,
    mediaType: 'movie' | 'show'
  ): Promise<TaggingResult> {
    const result: TaggingResult = { tagged: 0, skipped: 0, errors: 0, items: [] };

    // Pre-build tag maps to avoid one API call per library item
    const [movieTagMap, showTagMap] = await Promise.all([
      mediaType === 'movie' ? this.buildMovieTagMap() : Promise.resolve(new Map<number, MovieTagEntry>()),
      mediaType === 'show' ? this.buildShowTagMap() : Promise.resolve(new Map<number, ShowTagEntry>()),
    ]);

    let offset = 0;
    const pageSize = 50;

    while (true) {
      const { items, totalSize } = await plexApi.getLibraryContents(libraryId, { offset, size: pageSize });

      for (const item of items) {
        const tmdbGuid = item.Guid?.find((g) => g.id.startsWith('tmdb://'));
        const tmdbId = tmdbGuid ? parseInt(tmdbGuid.id.replace('tmdb://', ''), 10) : NaN;

        if (isNaN(tmdbId)) {
          result.skipped++;
          result.items.push({ title: item.title, ratingKey: item.ratingKey, tag: null });
          continue;
        }

        try {
          let tag: LanguageTag | null = null;
          let source: string | undefined;
          let seasonTags: Record<number, LanguageTag> | undefined;

          if (mediaType === 'movie') {
            const entry = movieTagMap.get(tmdbId) ?? await this.fetchMovieTagFromFfprobe(item.ratingKey, plexApi);
            if (entry) { tag = entry.tag; source = entry.source; }
          } else {
            const entry = showTagMap.get(tmdbId) ?? await this.fetchShowTagsFromFfprobe(item.ratingKey, plexApi);
            if (entry) { tag = entry.seriesTag; source = entry.source; seasonTags = entry.seasonTags; }
          }

          if (tag) {
            await this.saveRecord({
              ratingKey: item.ratingKey,
              title: item.title,
              mediaType,
              tmdbId,
              tag,
              seasonTags,
              source: source!,
            });
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
