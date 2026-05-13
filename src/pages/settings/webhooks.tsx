import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsWebhooks from '@app/components/Settings/SettingsWebhooks';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsWebhooksPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsWebhooks />
    </SettingsLayout>
  );
};

export default SettingsWebhooksPage;
