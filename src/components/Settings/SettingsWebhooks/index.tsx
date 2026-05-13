import Button from '@app/components/Common/Button';
import { ArrowPathIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const messages = defineMessages({
  title: 'Webhook Triggers',
  description:
    'Configure automatic overlay application when Radarr, Sonarr, or Plex detects new media.',
  radarrSection: 'Radarr',
  sonarrSection: 'Sonarr',
  plexSection: 'Plex (library.new)',
  enabled: 'Enable',
  delayMinutes: 'Delay (minutes)',
  delayHelp:
    'Time to wait after the webhook before applying overlays. Gives Plex time to scan and index the file.',
  webhookUrl: 'Webhook URL',
  copyUrl: 'Copy',
  urlCopied: 'URL copied!',
  save: 'Save',
  saved: 'Settings saved',
  saveError: 'Failed to save settings',
  regenerateToken: 'Regenerate token',
  tokenRegenerated: 'Token regenerated — update your Radarr/Sonarr webhook URLs!',
  tokenInfo:
    'This token authenticates Radarr and Sonarr webhooks. Include it as a ?token= query parameter.',
  tokenLabel: 'Webhook token',
  noApplicationUrl:
    'Application URL is not configured. Go to General settings and set the Application URL so webhook URLs can be built correctly.',
  queueTitle: 'Pending queue',
  queueEmpty: 'No items pending',
  queueItem: '{value} ({mediaType}) — {secondsRemaining}s remaining',
  plexDelayNote:
    'Plex events fire after indexing, so a 0-second delay is usually sufficient.',
  setupInstructions: 'Setup instructions',
  radarrInstructions:
    'In Radarr → Settings → Connect → Add Webhook. Set the URL above and enable On Download and On Upgrade events.',
  sonarrInstructions:
    'In Sonarr → Settings → Connect → Add Webhook. Set the URL above and enable On Download and On Upgrade events.',
  plexInstructions:
    'In Plex → Settings → Webhooks → Add Webhook. Set the URL to your Agregarr server base URL: {baseUrl}/plex-webhook',
});

interface TriggerConfig {
  enabled: boolean;
  delayMinutes: number;
}

interface WebhookSettings {
  webhookToken: string;
  applicationUrl: string;
  triggers: {
    radarr: TriggerConfig;
    sonarr: TriggerConfig;
    plex: TriggerConfig;
  };
}

interface QueueItem {
  key: string;
  type: string;
  mediaType?: string;
  value: string;
  secondsRemaining: number;
}

const CopyableUrl: React.FC<{ url: string }> = ({ url }) => {
  const { addToast } = useToasts();
  const intl = useIntl();

  const handleCopy = () => {
    navigator.clipboard.writeText(url).then(() => {
      addToast(intl.formatMessage(messages.urlCopied), {
        appearance: 'success',
        autoDismiss: true,
      });
    });
  };

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded bg-stone-800 px-3 py-1.5 text-xs text-stone-300">
        {url}
      </code>
      <button
        onClick={handleCopy}
        className="shrink-0 rounded p-1.5 text-stone-400 hover:bg-stone-700 hover:text-white"
        title={intl.formatMessage(messages.copyUrl)}
      >
        <ClipboardDocumentIcon className="h-4 w-4" />
      </button>
    </div>
  );
};

const TriggerSection: React.FC<{
  title: string;
  config: TriggerConfig;
  webhookUrl?: string;
  delayHelp?: string;
  instructions?: string;
  onChange: (config: TriggerConfig) => void;
}> = ({ title, config, webhookUrl, delayHelp, instructions, onChange }) => {
  const intl = useIntl();

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <label className="flex cursor-pointer items-center gap-2">
          <span className="text-sm text-stone-400">
            {intl.formatMessage(messages.enabled)}
          </span>
          <div className="relative">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
              className="sr-only"
            />
            <div
              onClick={() => onChange({ ...config, enabled: !config.enabled })}
              className={`h-6 w-11 cursor-pointer rounded-full transition-colors ${
                config.enabled ? 'bg-indigo-600' : 'bg-stone-600'
              }`}
            >
              <div
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  config.enabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </div>
          </div>
        </label>
      </div>

      {webhookUrl && (
        <div className="mb-4">
          <label className="mb-1 block text-xs font-medium text-stone-400">
            {intl.formatMessage(messages.webhookUrl)}
          </label>
          <CopyableUrl url={webhookUrl} />
        </div>
      )}

      <div className="mb-4">
        <label className="mb-1 block text-xs font-medium text-stone-400">
          {intl.formatMessage(messages.delayMinutes)}
        </label>
        <input
          type="number"
          min={0}
          max={60}
          value={config.delayMinutes}
          onChange={(e) =>
            onChange({ ...config, delayMinutes: Number(e.target.value) })
          }
          className="w-24 rounded-md border-stone-600 bg-stone-700 px-3 py-1.5 text-sm text-white"
        />
        {delayHelp && (
          <p className="mt-1 text-xs text-stone-500">{delayHelp}</p>
        )}
      </div>

      {instructions && (
        <p className="mt-2 rounded bg-stone-900 px-3 py-2 text-xs text-stone-400">
          {instructions}
        </p>
      )}
    </div>
  );
};

const SettingsWebhooks: React.FC = () => {
  const intl = useIntl();
  const { addToast } = useToasts();

  const { data, mutate } = useSWR<WebhookSettings>(
    '/api/v1/settings/webhook-triggers'
  );
  const { data: queueData, mutate: mutateQueue } = useSWR<{ queue: QueueItem[] }>(
    '/api/v1/settings/webhook-triggers/queue',
    { refreshInterval: 10000 }
  );

  const [triggers, setTriggers] = useState<WebhookSettings['triggers']>({
    radarr: { enabled: false, delayMinutes: 5 },
    sonarr: { enabled: false, delayMinutes: 5 },
    plex: { enabled: false, delayMinutes: 0 },
  });
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    if (data?.triggers) {
      setTriggers(data.triggers);
    }
  }, [data]);

  const baseUrl = data?.applicationUrl?.replace(/\/$/, '') || '';
  const token = data?.webhookToken || '';

  const radarrUrl = `${baseUrl}/radarr-webhook?token=${token}`;
  const sonarrUrl = `${baseUrl}/sonarr-webhook?token=${token}`;

  const handleSave = async () => {
    setSaving(true);
    try {
      await axios.post('/api/v1/settings/webhook-triggers', { triggers });
      await mutate();
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

  const handleRegenerateToken = async () => {
    if (
      !confirm(
        'Regenerate the webhook token? You will need to update the URL in Radarr and Sonarr.'
      )
    )
      return;
    setRegenerating(true);
    try {
      await axios.post('/api/v1/settings/webhook-triggers/regenerate-token');
      await mutate();
      addToast(intl.formatMessage(messages.tokenRegenerated), {
        appearance: 'warning',
        autoDismiss: false,
      });
    } catch {
      // ignore
    } finally {
      setRegenerating(false);
    }
  };

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

      {/* Token info */}
      <div className="rounded-lg border border-stone-700 bg-stone-800 p-4">
        <div className="mb-3 flex items-start justify-between gap-4">
          <p className="text-sm text-stone-400">
            {intl.formatMessage(messages.tokenInfo)}
          </p>
          <Button
            buttonType="default"
            buttonSize="sm"
            onClick={handleRegenerateToken}
            disabled={regenerating}
          >
            <ArrowPathIcon className="mr-1.5 h-4 w-4" />
            {intl.formatMessage(messages.regenerateToken)}
          </Button>
        </div>
        <label className="mb-1 block text-xs font-medium text-stone-400">
          {intl.formatMessage(messages.tokenLabel)}
        </label>
        {token ? (
          <CopyableUrl url={token} />
        ) : (
          <p className="text-xs italic text-stone-500">
            Token not yet generated — reload this page or restart the server.
          </p>
        )}
      </div>

      {!baseUrl && (
        <div className="rounded-lg border border-amber-700 bg-amber-900/30 px-4 py-3 text-sm text-amber-300">
          {intl.formatMessage(messages.noApplicationUrl)}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-1 lg:grid-cols-3">
        <TriggerSection
          title={intl.formatMessage(messages.radarrSection)}
          config={triggers.radarr}
          webhookUrl={radarrUrl}
          delayHelp={intl.formatMessage(messages.delayHelp)}
          instructions={intl.formatMessage(messages.radarrInstructions)}
          onChange={(c) => setTriggers((p) => ({ ...p, radarr: c }))}
        />

        <TriggerSection
          title={intl.formatMessage(messages.sonarrSection)}
          config={triggers.sonarr}
          webhookUrl={sonarrUrl}
          delayHelp={intl.formatMessage(messages.delayHelp)}
          instructions={intl.formatMessage(messages.sonarrInstructions)}
          onChange={(c) => setTriggers((p) => ({ ...p, sonarr: c }))}
        />

        <TriggerSection
          title={intl.formatMessage(messages.plexSection)}
          config={triggers.plex}
          delayHelp={intl.formatMessage(messages.plexDelayNote)}
          instructions={intl.formatMessage(messages.plexInstructions, {
            baseUrl,
          })}
          onChange={(c) => setTriggers((p) => ({ ...p, plex: c }))}
        />
      </div>

      <div className="flex justify-end">
        <Button
          buttonType="primary"
          onClick={handleSave}
          disabled={saving}
        >
          {intl.formatMessage(messages.save)}
        </Button>
      </div>

      {/* Queue status */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">
            {intl.formatMessage(messages.queueTitle)}
          </h3>
          <button
            onClick={() => mutateQueue()}
            className="text-xs text-stone-400 hover:text-white"
          >
            <ArrowPathIcon className="h-4 w-4" />
          </button>
        </div>

        {!queueData?.queue.length ? (
          <p className="text-sm text-stone-500">
            {intl.formatMessage(messages.queueEmpty)}
          </p>
        ) : (
          <ul className="space-y-2">
            {queueData.queue.map((item) => (
              <li
                key={item.key}
                className="flex items-center justify-between rounded bg-stone-800 px-3 py-2 text-sm"
              >
                <span className="text-stone-300">
                  {item.mediaType === 'movie' ? '🎬' : '📺'} TMDB {item.value}
                </span>
                <span className="text-xs text-stone-500">
                  {item.secondsRemaining}s
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default SettingsWebhooks;
