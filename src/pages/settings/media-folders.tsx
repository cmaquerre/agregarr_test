import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsMediaFolders from '@app/components/Settings/SettingsMediaFolders';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsMediaFoldersPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsMediaFolders />
    </SettingsLayout>
  );
};

export default SettingsMediaFoldersPage;
