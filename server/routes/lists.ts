import FlixPatrolAPI from '@server/api/flixpatrol';
import TmdbAPI from '@server/api/themoviedb';
import logger from '@server/logger';
import { Router } from 'express';

const router = Router();

interface MovieListItem {
  tmdbId: number;
  title: string;
  year?: number;
}

interface TvListItem {
  tvdbId: number;
  tmdbId: number;
  title: string;
  year?: number;
}

/**
 * GET /lists/flixpatrol
 *
 * Returns a Radarr/Sonarr-compatible import list from FlixPatrol top 10 data.
 * - mediaType=movie → [{tmdbId, title, year}]  (Radarr format)
 * - mediaType=tv    → [{tvdbId, tmdbId, title, year}]  (Sonarr format)
 *
 * This endpoint requires no authentication so Radarr/Sonarr can poll it directly.
 */
router.get('/flixpatrol', async (req, res, next) => {
  try {
    const platform = (req.query.platform as string) || 'netflix_top_10';
    const country = (req.query.country as string) || 'global';
    const mediaType = (req.query.mediaType as string) || 'movie';

    if (mediaType !== 'movie' && mediaType !== 'tv') {
      return res
        .status(400)
        .json({ message: 'mediaType must be "movie" or "tv"' });
    }

    const flixpatrol = new FlixPatrolAPI();
    const tmdb = new TmdbAPI();

    logger.info('Fetching FlixPatrol list for import', {
      label: 'Lists',
      platform,
      country,
      mediaType,
    });

    const platformData = await flixpatrol.getPlatformTop10(
      platform,
      country,
      mediaType
    );

    const sourceItems =
      mediaType === 'movie' ? platformData.movies : platformData.tvShows;

    if (mediaType === 'movie') {
      const results: MovieListItem[] = [];

      for (const item of sourceItems) {
        try {
          const searchResult = await tmdb.searchMovies({
            query: item.title,
            page: 1,
          });

          const match = searchResult.results?.[0];
          if (match) {
            const year = match.release_date
              ? parseInt(match.release_date.substring(0, 4))
              : undefined;
            results.push({ tmdbId: match.id, title: match.title, year });
          }
        } catch (err) {
          logger.warn(`TMDB movie search failed for "${item.title}"`, {
            label: 'Lists',
            error: err instanceof Error ? err.message : String(err),
          });
        }

        await new Promise((r) => setTimeout(r, 100));
      }

      return res.json(results);
    } else {
      const results: TvListItem[] = [];

      for (const item of sourceItems) {
        try {
          const searchResult = await tmdb.searchTvShows({
            query: item.title,
            page: 1,
          });

          const match = searchResult.results?.[0];
          if (match) {
            const tvDetails = await tmdb.getTvShow({ tvId: match.id });
            const tvdbId = tvDetails.external_ids?.tvdb_id;

            if (tvdbId) {
              const year = match.first_air_date
                ? parseInt(match.first_air_date.substring(0, 4))
                : undefined;
              results.push({
                tvdbId,
                tmdbId: match.id,
                title: match.name,
                year,
              });
            }
          }
        } catch (err) {
          logger.warn(`TMDB TV search failed for "${item.title}"`, {
            label: 'Lists',
            error: err instanceof Error ? err.message : String(err),
          });
        }

        await new Promise((r) => setTimeout(r, 150));
      }

      return res.json(results);
    }
  } catch (error) {
    logger.error('Failed to fetch FlixPatrol import list', {
      label: 'Lists',
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
});

export default router;
