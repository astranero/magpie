import React from 'react';
import { useTranslation } from 'react-i18next';
import { Library, MessageSquare, SlidersHorizontal } from 'lucide-react';
import { View } from '../../types';

interface NavbarProps {
  view: View;
  setView: (view: View) => void;
  activeProjectId: string;
  researching: Record<string, boolean>;
  chatScrollTopRef: React.MutableRefObject<any>;
  chatScrollToBottomRef: React.MutableRefObject<any>;
}

export const Navbar: React.FC<NavbarProps> = ({
  view,
  setView,
  activeProjectId,
  researching,
  chatScrollTopRef,
  chatScrollToBottomRef
}) => {
  const { t } = useTranslation();
  const tabs = [
    { key: 'lore' as View, label: t('nav.lore'), Icon: Library, onClick: () => setView('lore') },
    {
      key: 'chat' as View,
      label: t('nav.chat'),
      Icon: MessageSquare,
      onClick: () => {
        chatScrollTopRef.current = null;
        setView('chat');
        chatScrollToBottomRef.current?.();
      }
    },
    { key: 'settings' as View, label: t('nav.config'), Icon: SlidersHorizontal, onClick: () => setView('settings') },
  ];

  return (
    <nav className="relative flex items-center justify-between px-4 py-2 bg-card border-t border-border/60 shrink-0 shadow-sm">
      <div className="flex w-full items-center justify-around gap-1">
        {tabs.map(({ key, label, Icon, onClick }) => {
          const isActive = view === key;
          return (
            <button
              key={key}
              className={`group flex flex-col items-center justify-center gap-1 py-1 px-3 text-[10px] font-semibold tracking-tight transition-all duration-300 rounded-xl relative flex-1 ${
                isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={onClick}
              aria-current={isActive ? 'page' : undefined}
            >
              {/* Icon Container with subtle scale on hover/active */}
              <div className={`p-1.5 rounded-lg transition-all duration-300 ${isActive ? 'bg-primary/10 scale-105' : 'group-hover:bg-accent group-hover:scale-105'}`}>
                <Icon size={15} className={`transition-colors ${isActive ? 'stroke-[2.5px]' : 'stroke-[2px]'}`} aria-hidden="true" />
              </div>
              
              <span className="font-display font-medium text-[10px] leading-none mt-0.5">{label}</span>
              
              {/* Active Indicator Underline */}
              <span className={`absolute bottom-[-6px] left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full bg-primary transition-all duration-300 ${isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`} />

              {/* Research Pulse Dot */}
              {key === 'chat' && activeProjectId && researching[activeProjectId] && (
                <span className="absolute top-1.5 right-6 flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
