import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsLanguageTagger from '@app/components/Settings/SettingsLanguageTagger';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsLanguageTaggerPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsLanguageTagger />
    </SettingsLayout>
  );
};

export default SettingsLanguageTaggerPage;
