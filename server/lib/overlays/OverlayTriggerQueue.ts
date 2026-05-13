import { getRepository } from '@server/datasource';
import { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { getAdminUser } from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

interface QueueEntry {
  type: 'tmdb' | 'ratingKey';
  mediaType?: 'movie' | 'show';
  value: string; // tmdbId (as string) or ratingKey
  timer: ReturnType<typeof setTimeout>;
  enqueuedAt: number;
}

/**
 * Debounced queue for triggering overlay application on individual items.
 *
 * When Radarr/Sonarr/Plex fires a webhook, the item may not be indexed by
 * Plex yet. This queue waits a configurable delay before applying overlays,
 * and collapses duplicate events for the same item.
 */
class OverlayTriggerQueue {
  private queue = new Map<string, QueueEntry>();

  /**
   * Enqueue an item identified by TMDB ID.
   * Used by Radarr (movies) and Sonarr (series) webhooks.
   */
  public enqueueTmdbItem(tmdbId: number, mediaType: 'movie' | 'show'): void {
    const settings = getSettings();
    const triggerSettings =
      mediaType === 'movie'
        ? settings.webhookTriggers?.radarr
        : settings.webhookTriggers?.sonarr;

    if (!triggerSettings?.enabled) {
      return;
    }

    const delayMs = (triggerSettings.delayMinutes ?? 5) * 60 * 1000;
    const key = `tmdb-${mediaType}-${tmdbId}`;

    // Cancel existing timer for this item (debounce)
    const existing = this.queue.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      logger.debug('OverlayTriggerQueue: reset timer for item', {
        label: 'OverlayTriggerQueue',
        key,
        delayMinutes: triggerSettings.delayMinutes,
      });
    }

    const timer = setTimeout(
      () => this.processTmdbItem(tmdbId, mediaType, key),
      delayMs
    );

    this.queue.set(key, {
      type: 'tmdb',
      mediaType,
      value: String(tmdbId),
      timer,
      enqueuedAt: Date.now(),
    });

    logger.info('OverlayTriggerQueue: item enqueued', {
      label: 'OverlayTriggerQueue',
      tmdbId,
      mediaType,
      delayMinutes: triggerSettings.delayMinutes,
    });
  }

  /**
   * Enqueue an item identified by Plex ratingKey.
   * Used by Plex library.new webhooks (no delay needed — item already indexed).
   */
  public enqueueRatingKey(ratingKey: string): void {
    const settings = getSettings();
    if (!settings.webhookTriggers?.plex?.enabled) {
      return;
    }

    const key = `ratingKey-${ratingKey}`;

    const existing = this.queue.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    // No delay for Plex events — item is already indexed
    const timer = setTimeout(
      () => this.processRatingKeyItem(ratingKey, key),
      2000 // 2s grace period for Plex to finish metadata
    );

    this.queue.set(key, {
      type: 'ratingKey',
      value: ratingKey,
      timer,
      enqueuedAt: Date.now(),
    });

    logger.info('OverlayTriggerQueue: Plex item enqueued', {
      label: 'OverlayTriggerQueue',
      ratingKey,
    });
  }

  private async processTmdbItem(
    tmdbId: number,
    mediaType: 'movie' | 'show',
    key: string
  ): Promise<void> {
    this.queue.delete(key);

    logger.info('OverlayTriggerQueue: processing TMDB item', {
      label: 'OverlayTriggerQueue',
      tmdbId,
      mediaType,
    });

    try {
      const plexApi = await this.getPlexApi();
      if (!plexApi) return;

      const configRepo = getRepository(OverlayLibraryConfig);
      const configs = await configRepo.find();
      const relevantConfigs = configs.filter(
        (c) =>
          c.mediaType === mediaType && c.enabledOverlays.some((o) => o.enabled)
      );

      if (relevantConfigs.length === 0) {
        logger.debug(
          'OverlayTriggerQueue: no overlay-configured libraries for media type',
          { label: 'OverlayTriggerQueue', mediaType }
        );
        return;
      }

      for (const config of relevantConfigs) {
        const item = await this.findItemByTmdbId(
          plexApi,
          config.libraryId,
          tmdbId,
          mediaType
        );

        if (item) {
          await this.applyOverlaysToItem(item.ratingKey, config.libraryId);
          await this.applyLanguageTagToItem(
            plexApi,
            item.ratingKey,
            item.title,
            tmdbId,
            mediaType
          );
          return; // Found and processed — stop searching other libraries
        }
      }

      logger.warn('OverlayTriggerQueue: item not found in any Plex library', {
        label: 'OverlayTriggerQueue',
        tmdbId,
        mediaType,
        searchedLibraries: relevantConfigs.map((c) => c.libraryName),
      });
    } catch (error) {
      logger.error('OverlayTriggerQueue: failed to process TMDB item', {
        label: 'OverlayTriggerQueue',
        tmdbId,
        mediaType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async processRatingKeyItem(
    ratingKey: string,
    key: string
  ): Promise<void> {
    this.queue.delete(key);

    logger.info('OverlayTriggerQueue: processing Plex ratingKey item', {
      label: 'OverlayTriggerQueue',
      ratingKey,
    });

    try {
      const plexApi = await this.getPlexApi();
      if (!plexApi) return;

      // Get item metadata to determine its library
      const metadata = await plexApi.getMetadata(ratingKey);

      if (!metadata || (metadata.type !== 'movie' && metadata.type !== 'show')) {
        logger.debug(
          'OverlayTriggerQueue: skipping non-movie/show item from Plex webhook',
          { label: 'OverlayTriggerQueue', ratingKey, type: metadata?.type }
        );
        return;
      }

      // Find which library this item belongs to by checking overlay configs
      const configRepo = getRepository(OverlayLibraryConfig);
      const configs = await configRepo.find();
      const mediaType = metadata.type === 'movie' ? 'movie' : 'show';
      const relevantConfigs = configs.filter(
        (c) =>
          c.mediaType === mediaType && c.enabledOverlays.some((o) => o.enabled)
      );

      // Find the library by searching each configured library
      for (const config of relevantConfigs) {
        const item = await this.findItemInLibrary(
          plexApi,
          config.libraryId,
          ratingKey
        );
        if (item) {
          await this.applyOverlaysToItem(ratingKey, config.libraryId);

          // Extract TMDB ID from Plex metadata GUIDs for language tagging
          const tmdbGuid = metadata.Guid?.find((g) =>
            g.id.startsWith('tmdb://')
          );
          const tmdbId = tmdbGuid
            ? parseInt(tmdbGuid.id.replace('tmdb://', ''), 10)
            : null;
          if (tmdbId && !isNaN(tmdbId)) {
            await this.applyLanguageTagToItem(
              plexApi,
              ratingKey,
              metadata.title,
              tmdbId,
              mediaType
            );
          }

          return;
        }
      }

      logger.warn(
        'OverlayTriggerQueue: item not found in any overlay-configured library',
        { label: 'OverlayTriggerQueue', ratingKey }
      );
    } catch (error) {
      logger.error('OverlayTriggerQueue: failed to process Plex item', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Search a specific Plex library for an item by TMDB ID.
   * Uses Plex's GUID search endpoint.
   */
  private async findItemByTmdbId(
    plexApi: PlexAPI,
    libraryId: string,
    tmdbId: number,
    mediaType: 'movie' | 'show'
  ): Promise<PlexLibraryItem | null> {
    try {
      const type = mediaType === 'movie' ? 1 : 2;
      const guid = `tmdb://${tmdbId}`;

      const response = await plexApi['plexClient'].query<{
        MediaContainer: {
          totalSize?: number;
          Metadata?: Array<{
            ratingKey: string;
            title: string;
            type: string;
            guid?: string;
            Guid?: { id: string }[];
          }>;
        };
      }>(
        `/library/sections/${libraryId}/all?type=${type}&guid=${encodeURIComponent(guid)}&includeGuids=1`
      );

      const metadata = response?.MediaContainer?.Metadata;
      if (metadata && metadata.length > 0) {
        const found = metadata[0];
        logger.debug('OverlayTriggerQueue: found item by TMDB ID', {
          label: 'OverlayTriggerQueue',
          tmdbId,
          libraryId,
          title: found.title,
          ratingKey: found.ratingKey,
        });
        return found as unknown as PlexLibraryItem;
      }
    } catch (error) {
      logger.debug(
        'OverlayTriggerQueue: TMDB ID search failed for library, trying next',
        {
          label: 'OverlayTriggerQueue',
          tmdbId,
          libraryId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
    return null;
  }

  /**
   * Check if a specific ratingKey item exists in a library (lightweight check).
   */
  private async findItemInLibrary(
    plexApi: PlexAPI,
    libraryId: string,
    ratingKey: string
  ): Promise<boolean> {
    try {
      const metadata = await plexApi.getMetadata(ratingKey);
      // Plex metadata doesn't include libraryId directly, but if we can fetch it
      // and it matches the expected media type, we use it
      return !!metadata;
    } catch {
      return false;
    }
  }

  private async applyOverlaysToItem(
    ratingKey: string,
    libraryId: string
  ): Promise<void> {
    try {
      const { overlayLibraryService } = await import(
        '@server/lib/overlays/OverlayLibraryService'
      );

      logger.info('OverlayTriggerQueue: applying overlays to item', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        libraryId,
      });

      await overlayLibraryService.applyOverlaysToCollectionItems(
        [ratingKey],
        libraryId
      );

      logger.info('OverlayTriggerQueue: overlays applied successfully', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        libraryId,
      });
    } catch (error) {
      logger.error('OverlayTriggerQueue: failed to apply overlays', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applyLanguageTagToItem(
    plexApi: PlexAPI,
    ratingKey: string,
    title: string,
    tmdbId: number,
    mediaType: 'movie' | 'show'
  ): Promise<void> {
    const settings = getSettings();
    if (!settings.languageTagger?.enabled) return;

    try {
      const { languageTaggerService } = await import(
        '@server/lib/languageTagger/LanguageTaggerService'
      );

      if (mediaType === 'movie') {
        await languageTaggerService.tagMovie(ratingKey, title, tmdbId, plexApi);
      } else {
        await languageTaggerService.tagShow(ratingKey, title, tmdbId, plexApi);
      }
    } catch (error) {
      logger.error('OverlayTriggerQueue: language tagging failed', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        tmdbId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getPlexApi(): Promise<PlexAPI | null> {
    try {
      const admin = await getAdminUser();
      if (!admin?.plexToken) return null;
      return new PlexAPI({ plexToken: admin.plexToken });
    } catch {
      return null;
    }
  }

  /** Return current queue state for monitoring */
  public getQueueStatus(): Array<{
    key: string;
    type: string;
    mediaType?: string;
    value: string;
    enqueuedAt: number;
    secondsRemaining: number;
    delayMinutes: number;
  }> {
    const settings = getSettings();
    return Array.from(this.queue.entries()).map(([key, entry]) => {
      let delayMs = 5 * 60 * 1000;
      if (entry.mediaType === 'movie') {
        delayMs = (settings.webhookTriggers?.radarr?.delayMinutes ?? 5) * 60 * 1000;
      } else if (entry.mediaType === 'show') {
        delayMs = (settings.webhookTriggers?.sonarr?.delayMinutes ?? 5) * 60 * 1000;
      }
      const elapsed = Date.now() - entry.enqueuedAt;
      const secondsRemaining = Math.max(
        0,
        Math.round((delayMs - elapsed) / 1000)
      );
      return {
        key,
        type: entry.type,
        mediaType: entry.mediaType,
        value: entry.value,
        enqueuedAt: entry.enqueuedAt,
        secondsRemaining,
        delayMinutes: delayMs / 60000,
      };
    });
  }
}

export const overlayTriggerQueue = new OverlayTriggerQueue();
