import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { useTheme } from './theme-provider';

export function ThemeToggle() {
  const { t } = useTranslation('common');
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={isDark ? t('theme.switchToLightLabel') : t('theme.switchToDarkLabel')}
      aria-pressed={isDark}
      onClick={toggleTheme}
    >
      {isDark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
      {isDark ? t('theme.light') : t('theme.dark')}
    </Button>
  );
}
