import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useSettings from '@app/hooks/useSettings';
import axios from 'axios';
import React, { useEffect, useState } from 'react';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

interface PathMapping {
  plexPath: string;
  localPath: string;
}

interface MediaFolderSettings {
  pathMappings: PathMapping[];
}

const SettingsMediaFolders = () => {
  const { addToast } = useToasts();
  const settings = useSettings();
  const { data, error, mutate } = useSWR<MediaFolderSettings>(
    '/api/v1/settings/media-folders',
    (url: string) => fetch(url).then((r) => r.json())
  );

  const [mappings, setMappings] = useState<PathMapping[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data?.pathMappings) {
      setMappings(data.pathMappings);
    }
  }, [data]);

  const addMapping = () => {
    setMappings((prev) => [...prev, { plexPath: '', localPath: '' }]);
  };

  const removeMapping = (index: number) => {
    setMappings((prev) => prev.filter((_, i) => i !== index));
  };

  const updateMapping = (
    index: number,
    field: 'plexPath' | 'localPath',
    value: string
  ) => {
    setMappings((prev) =>
      prev.map((m, i) => (i === index ? { ...m, [field]: value } : m))
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      await axios.post('/api/v1/settings/media-folders', {
        pathMappings: mappings.filter((m) => m.plexPath && m.localPath),
      });
      addToast('Path mappings saved successfully.', {
        appearance: 'success',
        autoDismiss: true,
      });
      mutate();
    } catch {
      addToast('Failed to save path mappings.', {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  if (!data && !error) return <LoadingSpinner />;

  return (
    <>
      <PageTitle title="Media Folders" />
      <div className="mb-6">
        <h3 className="text-lg font-medium text-white">Media Folder Mappings</h3>
        <p className="mt-1 text-sm text-gray-400">
          Map the file paths reported by Plex to the paths mounted inside your
          Docker container. Required for ffprobe language detection when files
          are not managed by Radarr/Sonarr.
        </p>
      </div>

      {/* Docker compose hint */}
      <div className="mb-6 rounded-lg border border-blue-700 bg-blue-900/30 p-4">
        <p className="mb-2 text-sm font-semibold text-blue-300">
          Docker volume setup
        </p>
        <p className="mb-2 text-xs text-blue-200">
          Add your media folders as read-only volumes in{' '}
          <code className="rounded bg-blue-800/50 px-1">
            docker-compose.prod.yml
          </code>
          :
        </p>
        <pre className="overflow-x-auto rounded bg-stone-900 p-3 text-xs text-green-300">
          {`volumes:
  - ./config:/app/config
  - /your/host/movies:/media/movies:ro
  - /your/host/series:/media/series:ro`}
        </pre>
        <p className="mt-2 text-xs text-blue-200">
          Then add the corresponding mappings below (e.g.{' '}
          <code className="rounded bg-blue-800/50 px-1">
            Plex path: /your/host/movies
          </code>{' '}
          →{' '}
          <code className="rounded bg-blue-800/50 px-1">
            Local path: /media/movies
          </code>
          ).
        </p>
      </div>

      {/* Mappings table */}
      <div className="space-y-3">
        {mappings.length === 0 && (
          <p className="text-sm text-gray-500">
            No mappings configured. Click &quot;Add Mapping&quot; to get
            started.
          </p>
        )}

        {mappings.map((mapping, index) => (
          <div
            key={index}
            className="flex items-center gap-3 rounded-lg border border-stone-700 bg-stone-800 p-3"
          >
            <div className="flex-1">
              <label className="mb-1 block text-xs text-gray-400">
                Plex path (as reported by Plex)
              </label>
              <input
                type="text"
                value={mapping.plexPath}
                onChange={(e) =>
                  updateMapping(index, 'plexPath', e.target.value)
                }
                placeholder="/mnt/nas/movies"
                className="w-full rounded border border-stone-600 bg-stone-700 px-3 py-1.5 text-sm text-white placeholder-stone-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="flex items-center pt-5 text-gray-500">→</div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-gray-400">
                Local path (inside Docker container)
              </label>
              <input
                type="text"
                value={mapping.localPath}
                onChange={(e) =>
                  updateMapping(index, 'localPath', e.target.value)
                }
                placeholder="/media/movies"
                className="w-full rounded border border-stone-600 bg-stone-700 px-3 py-1.5 text-sm text-white placeholder-stone-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <button
              onClick={() => removeMapping(index)}
              className="mt-5 rounded p-1 text-gray-400 hover:text-red-400"
              title="Remove mapping"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="mt-4 flex gap-3">
        <Button buttonType="default" onClick={addMapping}>
          + Add Mapping
        </Button>
        <Button buttonType="primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  );
};

export default SettingsMediaFolders;
