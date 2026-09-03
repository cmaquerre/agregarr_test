import Button from '@app/components/Common/Button';
import { LANGUAGE_TAG_COLORS } from '@app/utils/languageTagColors';
import {
  ArrowPathIcon,
  FilmIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const messages = defineMessages({
  title: 'Language Tags',
  description:
    'Detect and store VF / MULTI / VOSTFR tags for your media using Radarr, Sonarr, or ffprobe. Tags are stored internally and are not applied to Plex.',
  autoTagEnabled: 'Enable automatic tagging via webhooks',
  autoTagDescription:
    'When a webhook triggers an overlay update, also detect and store the language tag.',
  save: 'Save',
  saved: 'Settings saved',
  saveError: 'Failed to save settings',
  manualTitle: 'Manual run',
  manualDescription:
    'Tag all items in a library now. Languages come from Radarr/Sonarr first; ffprobe is used as a fallback for unmanaged files.',
  runNow: 'Run Now',
  running: 'Running…',
  noLibraries: 'No Plex libraries configured.',
  runSuccess: 'Done — {tagged} tagged, {skipped} skipped, {errors} errors.',
  runError: 'Run failed',
  recordsTitle: 'Stored tags',
  recordsEmpty: 'No tags stored yet.',
  filterAll: 'All',
  filterVF: 'VF',
  filterMULTI: 'MULTI',
  filterVOSTFR: 'VOSTFR',
  colTitle: 'Title',
  colType: 'Type',
  colTag: 'Tag',
  colSeasons: 'Seasons',
  colSource: 'Source',
  colDate: 'Updated',
  sourceRadarr: 'Radarr',
  sourceSonarr: 'Sonarr',
  sourceFfprobe: 'ffprobe',
  total: '{count} records',
  regenerate: 'Regenerate overlay',
  regenerating: 'Regenerating…',
  regenerateSuccess: 'Overlay regeneration started for {title}',
  regenerateError: 'Failed to start regeneration',
  clearAll: 'Clear All',
  clearAllConfirm:
    'This will delete all {count} stored language tags. You will need to re-run the scan to rebuild them. Continue?',
  clearAllSuccess: 'Deleted {deleted} records',
  clearAllError: 'Failed to clear records',
  searchTitle: 'Search & Rescan',
  searchDescription:
    'Find a specific item by title, rescan its language tag, and regenerate its overlay poster.',
  searchPlaceholder: 'Search by title…',
  search: 'Search',
  searching: 'Searching…',
  searchEmpty: 'No results found.',
  searchError: 'Search failed',
  colLibrary: 'Library',
  colActions: 'Actions',
  rescan: 'Rescan',
  rescanning: 'Rescanning…',
  rescanSuccess: 'Rescanned — {tag}',
  rescanError: 'Rescan failed',
});

interface PlexLibrary {
  key: string;
  name: string;
  type: 'movie' | 'show';
}

interface LanguageTaggerSettings {
  enabled: boolean;
  plexLibraries: PlexLibrary[];
}

interface SearchResult {
  ratingKey: string;
  title: string;
  year?: number;
  mediaType: 'movie' | 'show';
  libraryId: string;
  libraryName: string;
  currentTag?: string;
}

interface TagRecord {
  id: number;
  ratingKey: string;
  title: string;
  mediaType: string;
  tmdbId?: number;
  tag: string;
  seasonTagsJson?: string;
  source?: string;
  updatedAt: string;
}

interface RecordsResponse {
  records: TagRecord[];
  total: number;
}

interface TaggingRunItem {
  title: string;
  ratingKey: string;
  tag: string | null;
  source?: string;
  error?: string;
}

interface TaggingResult {
  tagged: number;
  skipped: number;
  errors: number;
  items: TaggingRunItem[];
}

const TAG_COLORS = LANGUAGE_TAG_COLORS;

const SOURCE_LABELS: Record<string, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  ffprobe: 'ffprobe',
};

const SettingsLanguageTagger: React.FC = () => {
  const intl = useIntl();
  const { addToast } = useToasts();

  const { data: settings, mutate: mutateSettings } =
    useSWR<LanguageTaggerSettings>('/api/v1/settings/language-tagger');

  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningLibrary, setRunningLibrary] = useState<string | null>(null);
  const [runResults, setRunResults] = useState<Record<string, TaggingResult>>(
    {}
  );
  const [clearing, setClearing] = useState(false);
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [scanningKey, setScanningKey] = useState<string | null>(null);
  const [regeneratingSearchKey, setRegeneratingSearchKey] = useState<string | null>(null);
  const [recordsPage, setRecordsPage] = useState(0);

  const PAGE_SIZE = 100;

  const { data: recordsData, mutate: mutateRecords } =
    useSWR<RecordsResponse>(
      `/api/v1/settings/language-tagger/records?limit=${PAGE_SIZE}&offset=${recordsPage * PAGE_SIZE}${tagFilter ? `&tag=${tagFilter}` : ''}`
    );

  useEffect(() => {
    if (settings?.enabled !== undefined) {
      setEnabled(settings.enabled);
    }
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await axios.post('/api/v1/settings/language-tagger', { enabled });
      await mutateSettings();
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.saveError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async (library: PlexLibrary) => {
    setRunningLibrary(library.key);
    try {
      const res = await axios.post<TaggingResult>(
        '/api/v1/settings/language-tagger/run',
        { libraryId: library.key, mediaType: library.type },
        { timeout: 10 * 60 * 1000 }
      );
      setRunResults((prev) => ({ ...prev, [library.key]: res.data }));
      await mutateRecords();
      addToast(
        intl.formatMessage(messages.runSuccess, {
          tagged: res.data.tagged,
          skipped: res.data.skipped,
          errors: res.data.errors,
        }),
        {
          appearance: res.data.errors > 0 ? 'warning' : 'success',
          autoDismiss: true,
        }
      );
    } catch {
      addToast(intl.formatMessage(messages.runError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setRunningLibrary(null);
    }
  };

  const handleRegenerate = async (record: TagRecord) => {
    setRegeneratingKey(record.ratingKey);
    try {
      await axios.post('/api/v1/overlay-settings/regenerate-item', {
        ratingKey: record.ratingKey,
        mediaType: record.mediaType,
      });
      addToast(
        intl.formatMessage(messages.regenerateSuccess, { title: record.title }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.regenerateError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setRegeneratingKey(null);
    }
  };

  const handleClearAll = async () => {
    const count = recordsData?.total ?? 0;
    if (
      !window.confirm(
        intl.formatMessage(messages.clearAllConfirm, { count })
      )
    )
      return;
    setClearing(true);
    try {
      const res = await axios.delete<{ deleted: number }>(
        '/api/v1/settings/language-tagger/records'
      );
      await mutateRecords();
      addToast(
        intl.formatMessage(messages.clearAllSuccess, {
          deleted: res.data.deleted,
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.clearAllError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setClearing(false);
    }
  };

  const handleSearch = async () => {
    if (searchQuery.trim().length < 2) return;
    setSearching(true);
    setSearchResults(null);
    try {
      const res = await axios.get<{ results: SearchResult[] }>(
        `/api/v1/settings/language-tagger/search?q=${encodeURIComponent(searchQuery.trim())}`
      );
      setSearchResults(res.data.results);
    } catch {
      addToast(intl.formatMessage(messages.searchError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSearching(false);
    }
  };

  const handleScanItem = async (item: SearchResult) => {
    setScanningKey(item.ratingKey);
    try {
      const res = await axios.post<{ tag: string | null; title: string }>(
        '/api/v1/settings/language-tagger/scan-item',
        { ratingKey: item.ratingKey, mediaType: item.mediaType }
      );
      setSearchResults((prev) =>
        prev?.map((r) =>
          r.ratingKey === item.ratingKey
            ? { ...r, currentTag: res.data.tag ?? undefined }
            : r
        ) ?? null
      );
      addToast(
        intl.formatMessage(messages.rescanSuccess, {
          tag: res.data.tag ?? '—',
        }),
        { appearance: 'success', autoDismiss: true }
      );
      await mutateRecords();
    } catch {
      addToast(intl.formatMessage(messages.rescanError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setScanningKey(null);
    }
  };

  const handleRegenerateSearchItem = async (item: SearchResult) => {
    setRegeneratingSearchKey(item.ratingKey);
    try {
      await axios.post('/api/v1/overlay-settings/regenerate-item', {
        ratingKey: item.ratingKey,
        mediaType: item.mediaType,
      });
      addToast(
        intl.formatMessage(messages.regenerateSuccess, { title: item.title }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.regenerateError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setRegeneratingSearchKey(null);
    }
  };

  const libraries = settings?.plexLibraries ?? [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-white">
          {intl.formatMessage(messages.title)}
        </h2>
        <p className="mt-1 text-sm text-stone-400">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs">
        {(['VF', 'MULTI', 'VOSTFR'] as const).map((tag) => (
          <div key={tag} className="flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 font-bold ${TAG_COLORS[tag]}`}
            >
              {tag}
            </span>
            <span className="text-stone-400">
              {tag === 'VF' && 'French audio only'}
              {tag === 'MULTI' && 'French + other language(s)'}
              {tag === 'VOSTFR' && 'No French audio'}
            </span>
          </div>
        ))}
      </div>

      {/* Auto-tag toggle */}
      <div className="rounded-lg border border-stone-700 bg-stone-800 p-5">
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-white">
              {intl.formatMessage(messages.autoTagEnabled)}
            </p>
            <p className="mt-0.5 text-xs text-stone-400">
              {intl.formatMessage(messages.autoTagDescription)}
            </p>
          </div>
          <div className="relative shrink-0">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="sr-only"
            />
            <div
              onClick={() => setEnabled((v) => !v)}
              className={`h-6 w-11 cursor-pointer rounded-full transition-colors ${
                enabled ? 'bg-indigo-600' : 'bg-stone-600'
              }`}
            >
              <div
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  enabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </div>
          </div>
        </label>
      </div>

      <div className="flex justify-end">
        <Button buttonType="primary" onClick={handleSave} disabled={saving}>
          {intl.formatMessage(messages.save)}
        </Button>
      </div>

      {/* Manual run per library */}
      <div>
        <h3 className="mb-1 text-base font-semibold text-white">
          {intl.formatMessage(messages.manualTitle)}
        </h3>
        <p className="mb-4 text-sm text-stone-400">
          {intl.formatMessage(messages.manualDescription)}
        </p>

        {libraries.length === 0 ? (
          <p className="text-sm text-stone-500">
            {intl.formatMessage(messages.noLibraries)}
          </p>
        ) : (
          <div className="space-y-3">
            {libraries.map((lib) => (
              <div
                key={lib.key}
                className="rounded-lg border border-stone-700 bg-stone-800 p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-white">{lib.name}</p>
                    <p className="text-xs text-stone-500">
                      {lib.type === 'movie' ? '🎬 Movies' : '📺 Shows'} ·
                      library #{lib.key}
                    </p>
                  </div>
                  <Button
                    buttonType="default"
                    buttonSize="sm"
                    onClick={() => handleRun(lib)}
                    disabled={runningLibrary !== null}
                  >
                    {runningLibrary === lib.key ? (
                      <>
                        <ArrowPathIcon className="mr-1.5 h-4 w-4 animate-spin" />
                        {intl.formatMessage(messages.running)}
                      </>
                    ) : (
                      <>
                        <PlayIcon className="mr-1.5 h-4 w-4" />
                        {intl.formatMessage(messages.runNow)}
                      </>
                    )}
                  </Button>
                </div>

                {runResults[lib.key] && (
                  <div className="mt-4">
                    <div className="mb-2 flex gap-4 text-xs">
                      <span className="text-green-400">
                        ✓ {runResults[lib.key].tagged} tagged
                      </span>
                      <span className="text-stone-400">
                        — {runResults[lib.key].skipped} skipped
                      </span>
                      {runResults[lib.key].errors > 0 && (
                        <span className="text-red-400">
                          ✗ {runResults[lib.key].errors} errors
                        </span>
                      )}
                    </div>
                    <div className="max-h-40 overflow-y-auto rounded border border-stone-700">
                      <table className="w-full text-xs">
                        <tbody>
                          {runResults[lib.key].items
                            .filter((i) => i.tag || i.error)
                            .map((item, idx) => (
                              <tr
                                key={idx}
                                className="border-t border-stone-800"
                              >
                                <td className="px-3 py-1 text-stone-300">
                                  {item.title}
                                </td>
                                <td className="px-3 py-1 text-center">
                                  {item.tag && (
                                    <span
                                      className={`rounded px-1.5 py-0.5 font-bold ${TAG_COLORS[item.tag]}`}
                                    >
                                      {item.tag}
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-1 text-stone-500">
                                  {item.source
                                    ? SOURCE_LABELS[item.source] ?? item.source
                                    : item.error
                                      ? '⚠ Error'
                                      : ''}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Search & Rescan */}
      <div>
        <h3 className="mb-1 text-base font-semibold text-white">
          {intl.formatMessage(messages.searchTitle)}
        </h3>
        <p className="mb-4 text-sm text-stone-400">
          {intl.formatMessage(messages.searchDescription)}
        </p>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              placeholder={intl.formatMessage(messages.searchPlaceholder)}
              className="w-full rounded-lg border border-stone-700 bg-stone-800 py-2 pl-9 pr-3 text-sm text-white placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <Button
            buttonType="primary"
            buttonSize="sm"
            onClick={handleSearch}
            disabled={searching || searchQuery.trim().length < 2}
          >
            {searching ? (
              <>
                <ArrowPathIcon className="mr-1.5 h-4 w-4 animate-spin" />
                {intl.formatMessage(messages.searching)}
              </>
            ) : (
              intl.formatMessage(messages.search)
            )}
          </Button>
        </div>

        {searchResults !== null && (
          <div className="mt-4">
            {searchResults.length === 0 ? (
              <p className="text-sm text-stone-500">
                {intl.formatMessage(messages.searchEmpty)}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-stone-700">
                <table className="w-full text-sm">
                  <thead className="bg-stone-900 text-xs text-stone-400">
                    <tr>
                      <th className="px-4 py-2 text-left">
                        {intl.formatMessage(messages.colTitle)}
                      </th>
                      <th className="px-4 py-2 text-center">
                        {intl.formatMessage(messages.colType)}
                      </th>
                      <th className="px-4 py-2 text-left">
                        {intl.formatMessage(messages.colLibrary)}
                      </th>
                      <th className="px-4 py-2 text-center">
                        {intl.formatMessage(messages.colTag)}
                      </th>
                      <th className="px-4 py-2 text-right">
                        {intl.formatMessage(messages.colActions)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchResults.map((item) => (
                      <tr
                        key={item.ratingKey}
                        className="border-t border-stone-800 hover:bg-stone-800"
                      >
                        <td className="px-4 py-2 text-stone-200">
                          {item.title}
                          {item.year && (
                            <span className="ml-1 text-stone-500">
                              ({item.year})
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-center text-xs text-stone-400">
                          {item.mediaType === 'movie' ? '🎬' : '📺'}
                        </td>
                        <td className="px-4 py-2 text-xs text-stone-400">
                          {item.libraryName}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {item.currentTag ? (
                            <span
                              className={`rounded px-2 py-0.5 text-xs font-bold ${TAG_COLORS[item.currentTag] ?? 'bg-stone-600 text-stone-200'}`}
                            >
                              {item.currentTag}
                            </span>
                          ) : (
                            <span className="text-stone-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleScanItem(item)}
                              disabled={
                                scanningKey === item.ratingKey ||
                                regeneratingSearchKey === item.ratingKey
                              }
                              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-stone-400 hover:bg-stone-700 hover:text-white disabled:opacity-40"
                              title={intl.formatMessage(messages.rescan)}
                            >
                              <ArrowPathIcon
                                className={`h-3.5 w-3.5 ${scanningKey === item.ratingKey ? 'animate-spin' : ''}`}
                              />
                              {intl.formatMessage(messages.rescan)}
                            </button>
                            <button
                              onClick={() => handleRegenerateSearchItem(item)}
                              disabled={
                                regeneratingSearchKey === item.ratingKey ||
                                scanningKey === item.ratingKey
                              }
                              className="text-stone-500 hover:text-indigo-400 disabled:opacity-40"
                              title={intl.formatMessage(messages.regenerate)}
                            >
                              {regeneratingSearchKey === item.ratingKey ? (
                                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FilmIcon className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Stored records */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">
            {intl.formatMessage(messages.recordsTitle)}
            {recordsData && (
              <span className="ml-2 text-xs font-normal text-stone-400">
                {intl.formatMessage(messages.total, {
                  count: recordsData.total,
                })}
              </span>
            )}
          </h3>
          <div className="flex items-center gap-2">
            {/* Tag filter */}
            <div className="flex gap-1">
              {['', 'VF', 'MULTI', 'VOSTFR'].map((t) => (
                <button
                  key={t || 'all'}
                  onClick={() => {
                    setTagFilter(t);
                    setRecordsPage(0);
                  }}
                  className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                    tagFilter === t
                      ? 'bg-indigo-600 text-white'
                      : 'bg-stone-700 text-stone-400 hover:bg-stone-600 hover:text-white'
                  }`}
                >
                  {t || 'All'}
                </button>
              ))}
            </div>
            <button
              onClick={handleClearAll}
              disabled={clearing || !recordsData?.total}
              className="text-stone-400 hover:text-red-400 disabled:opacity-40"
              title={intl.formatMessage(messages.clearAll)}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
            <button
              onClick={() => mutateRecords()}
              className="text-stone-400 hover:text-white"
              title="Refresh"
            >
              <ArrowPathIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        {!recordsData?.records.length ? (
          <p className="text-sm text-stone-500">
            {intl.formatMessage(messages.recordsEmpty)}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-stone-700">
              <table className="w-full text-sm">
                <thead className="bg-stone-900 text-xs text-stone-400">
                  <tr>
                    <th className="px-4 py-2 text-left">
                      {intl.formatMessage(messages.colTitle)}
                    </th>
                    <th className="px-4 py-2 text-center">
                      {intl.formatMessage(messages.colType)}
                    </th>
                    <th className="px-4 py-2 text-center">
                      {intl.formatMessage(messages.colTag)}
                    </th>
                    <th className="px-4 py-2 text-left">
                      {intl.formatMessage(messages.colSeasons)}
                    </th>
                    <th className="px-4 py-2 text-center">
                      {intl.formatMessage(messages.colSource)}
                    </th>
                    <th className="px-4 py-2 text-right">
                      {intl.formatMessage(messages.colDate)}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recordsData.records.map((r) => {
                    const seasonTags: Record<string, string> = r.seasonTagsJson
                      ? (() => {
                          try {
                            return JSON.parse(r.seasonTagsJson);
                          } catch {
                            return {};
                          }
                        })()
                      : {};

                    return (
                      <tr
                        key={r.id}
                        className="border-t border-stone-800 hover:bg-stone-800"
                      >
                        <td className="px-4 py-2 text-stone-200">{r.title}</td>
                        <td className="px-4 py-2 text-center text-xs text-stone-400">
                          {r.mediaType === 'movie' ? '🎬' : '📺'}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-bold ${TAG_COLORS[r.tag] ?? 'bg-stone-600 text-stone-200'}`}
                          >
                            {r.tag}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          {Object.keys(seasonTags).length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(seasonTags)
                                .sort(
                                  ([a], [b]) => parseInt(a) - parseInt(b)
                                )
                                .map(([season, tag]) => (
                                  <span
                                    key={season}
                                    className={`rounded px-1 py-0.5 text-xs ${TAG_COLORS[tag] ?? 'bg-stone-600 text-stone-200'}`}
                                    title={`Season ${season}`}
                                  >
                                    S{season.padStart(2, '0')} {tag}
                                  </span>
                                ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-center text-xs text-stone-500">
                          {r.source
                            ? SOURCE_LABELS[r.source] ?? r.source
                            : '—'}
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-stone-500">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleRegenerate(r)}
                              disabled={regeneratingKey === r.ratingKey}
                              className="text-stone-500 hover:text-indigo-400 disabled:opacity-40"
                              title={intl.formatMessage(messages.regenerate)}
                            >
                              {regeneratingKey === r.ratingKey ? (
                                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FilmIcon className="h-3.5 w-3.5" />
                              )}
                            </button>
                            {new Date(r.updatedAt).toLocaleDateString()}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {recordsData.total > PAGE_SIZE && (
              <div className="mt-3 flex items-center justify-between text-xs text-stone-400">
                <button
                  onClick={() => setRecordsPage((p) => Math.max(0, p - 1))}
                  disabled={recordsPage === 0}
                  className="rounded px-3 py-1 hover:bg-stone-700 disabled:opacity-40"
                >
                  ← Previous
                </button>
                <span>
                  {recordsPage * PAGE_SIZE + 1}–
                  {Math.min((recordsPage + 1) * PAGE_SIZE, recordsData.total)}{' '}
                  / {recordsData.total}
                </span>
                <button
                  onClick={() => setRecordsPage((p) => p + 1)}
                  disabled={
                    (recordsPage + 1) * PAGE_SIZE >= recordsData.total
                  }
                  className="rounded px-3 py-1 hover:bg-stone-700 disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default SettingsLanguageTagger;
