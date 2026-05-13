import { ArrowPathIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages({
  title: 'Tags',
  description:
    'All movies and series with their language tag (VF/MULTI/VOSTFR) and their Radarr/Sonarr tags.',
  colTitle: 'Title',
  colType: 'Type',
  colLanguageTag: 'Language Tag',
  colRadarrTags: 'Radarr Tags',
  colSonarrTags: 'Sonarr Tags',
  colUpdated: 'Updated',
  filterAll: 'All',
  filterMovies: 'Movies',
  filterShows: 'Series',
  noResults: 'No items found.',
  loading: 'Loading…',
  searchPlaceholder: 'Search by title…',
  total: '{count} items',
  typeMovie: 'Movie',
  typeShow: 'Series',
  noTag: '—',
});

interface TagItem {
  ratingKey: string;
  title: string;
  mediaType: string;
  tmdbId: number | null;
  languageTag: string;
  source: string | null;
  radarrTags: string[];
  sonarrTags: string[];
  updatedAt: string;
}

const LANG_COLORS: Record<string, string> = {
  VF: 'bg-blue-700 text-blue-100',
  MULTI: 'bg-green-700 text-green-100',
  VOSTFR: 'bg-yellow-700 text-yellow-100',
};

const TagPill: React.FC<{ label: string; color?: string }> = ({ label, color = 'bg-stone-600 text-stone-200' }) => (
  <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${color}`}>
    {label}
  </span>
);

const SettingsTags: React.FC = () => {
  const intl = useIntl();
  const [search, setSearch] = useState('');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'movie' | 'show'>('all');
  const [langFilter, setLangFilter] = useState<'all' | 'VF' | 'MULTI' | 'VOSTFR'>('all');

  const { data, isValidating, mutate } = useSWR<{ items: TagItem[] }>(
    '/api/v1/settings/tags-overview',
    { revalidateOnFocus: false }
  );

  const filtered = (data?.items ?? []).filter((item) => {
    if (mediaFilter !== 'all' && item.mediaType !== mediaFilter) return false;
    if (langFilter !== 'all' && item.languageTag !== langFilter) return false;
    if (search && !item.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">
          {intl.formatMessage(messages.title)}
        </h2>
        <p className="mt-1 text-sm text-stone-400">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <MagnifyingGlassIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-stone-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={intl.formatMessage(messages.searchPlaceholder)}
            className="w-full rounded-md border border-stone-600 bg-stone-700 pl-8 pr-3 py-1.5 text-sm text-white placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="flex gap-1 rounded-md bg-stone-800 p-1">
          {(['all', 'movie', 'show'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setMediaFilter(f)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                mediaFilter === f
                  ? 'bg-indigo-600 text-white'
                  : 'text-stone-400 hover:text-white'
              }`}
            >
              {f === 'all'
                ? intl.formatMessage(messages.filterAll)
                : f === 'movie'
                ? intl.formatMessage(messages.filterMovies)
                : intl.formatMessage(messages.filterShows)}
            </button>
          ))}
        </div>

        <div className="flex gap-1 rounded-md bg-stone-800 p-1">
          {(['all', 'VF', 'MULTI', 'VOSTFR'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setLangFilter(f)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                langFilter === f
                  ? 'bg-indigo-600 text-white'
                  : 'text-stone-400 hover:text-white'
              }`}
            >
              {f === 'all' ? intl.formatMessage(messages.filterAll) : f}
            </button>
          ))}
        </div>

        <button
          onClick={() => mutate()}
          disabled={isValidating}
          className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-stone-400 hover:text-white"
        >
          <ArrowPathIcon className={`h-4 w-4 ${isValidating ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <p className="text-xs text-stone-500">
        {intl.formatMessage(messages.total, { count: filtered.length })}
      </p>

      {/* Table */}
      {isValidating && !data ? (
        <p className="text-sm text-stone-400">{intl.formatMessage(messages.loading)}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-stone-500">{intl.formatMessage(messages.noResults)}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-700">
          <table className="min-w-full divide-y divide-stone-700">
            <thead className="bg-stone-800">
              <tr>
                {['colTitle', 'colType', 'colLanguageTag', 'colRadarrTags', 'colSonarrTags', 'colUpdated'].map((col) => (
                  <th
                    key={col}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-stone-400"
                  >
                    {intl.formatMessage(messages[col as keyof typeof messages] as Parameters<typeof intl.formatMessage>[0])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-800 bg-stone-900">
              {filtered.map((item) => (
                <tr key={item.ratingKey} className="hover:bg-stone-800/50">
                  <td className="px-4 py-2.5 text-sm text-white">
                    {item.title}
                    {item.tmdbId && (
                      <span className="ml-1.5 text-xs text-stone-500">TMDB {item.tmdbId}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-stone-400">
                    {item.mediaType === 'movie'
                      ? intl.formatMessage(messages.typeMovie)
                      : intl.formatMessage(messages.typeShow)}
                  </td>
                  <td className="px-4 py-2.5">
                    <TagPill
                      label={item.languageTag}
                      color={LANG_COLORS[item.languageTag] ?? 'bg-stone-600 text-stone-200'}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {item.radarrTags.length > 0
                        ? item.radarrTags.map((t) => <TagPill key={t} label={t} />)
                        : <span className="text-xs text-stone-600">{intl.formatMessage(messages.noTag)}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {item.sonarrTags.length > 0
                        ? item.sonarrTags.map((t) => <TagPill key={t} label={t} />)
                        : <span className="text-xs text-stone-600">{intl.formatMessage(messages.noTag)}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-stone-500">
                    {new Date(item.updatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SettingsTags;
