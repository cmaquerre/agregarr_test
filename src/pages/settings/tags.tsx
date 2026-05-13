import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsTags from '@app/components/Settings/SettingsTags';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsTagsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsTags />
    </SettingsLayout>
  );
};

export default SettingsTagsPage;
