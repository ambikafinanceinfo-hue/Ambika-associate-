import React from 'react';

interface BrandMarkProps {
  logoDataUrl?: string | null;
  compact?: boolean;
  darkSurface?: boolean;
}

export const BrandMark: React.FC<BrandMarkProps> = ({
  logoDataUrl,
  compact = false,
  darkSurface = false,
}) => {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <img
        src={logoDataUrl || '/ambika-logo.png'}
        alt="AMBIKA ASSOCIATE Official Logo"
        referrerPolicy="no-referrer"
        className={`h-10 w-10 rounded-lg object-cover shrink-0 border ${
          logoDataUrl
            ? 'bg-white p-0.5 border-slate-200'
            : darkSurface
            ? 'bg-[#146B2E] border-yellow-400/70'
            : 'bg-[#146B2E] border-[#146B2E]/30'
        }`}
      />
      {!compact && (
        <div className="min-w-0">
          <div
            className={`font-display font-bold text-sm tracking-tight truncate ${
              darkSurface ? 'text-white' : 'text-[#0F2744]'
            }`}
          >
            AMBIKA ASSOCIATE
          </div>
          <div
            className={`text-[11px] font-medium tracking-wide truncate ${
              darkSurface ? 'text-yellow-300' : 'text-[#15803D]'
            }`}
          >
            SMART FINANCE SMART SAVING
          </div>
        </div>
      )}
    </div>
  );
};
