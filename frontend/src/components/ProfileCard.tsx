/**
 * The "about you" card on the landing screen.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS COLLAPSED BY DEFAULT
 * ---------------------------------------------------------------------------
 * Every field is optional and the product works with all of them empty.
 * Presenting a form before a stranger chat would turn "click and talk" into
 * "fill this in first", which is the opposite of what the button promises — so
 * the default state is one line saying what is currently declared, and opening
 * it is a deliberate act.
 *
 * The editor itself lives in `ProfileFields`, shared with Settings, so the two
 * places a profile can be changed cannot drift apart.
 */
import { useState } from 'react';
import { ChevronDown, Pencil } from 'lucide-react';

import type { Profile } from '../protocol/types';
import { isEmptyProfile } from '../profile';
import { ProfileFields, summariseProfile } from './ProfileFields';

interface ProfileCardProps {
  profile: Profile;
  onChange: (profile: Profile) => void;
  onClear: () => void;
}

export function ProfileCard({ profile, onChange, onClear }: ProfileCardProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const empty = isEmptyProfile(profile);

  return (
    <div className="w-full max-w-md rounded-2xl border border-ink-800 bg-ink-900/50 text-left">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-ink-800/40"
      >
        <Pencil className="h-4 w-4 shrink-0 text-ink-500" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink-100">
            {empty ? 'Tell strangers about you' : summariseProfile(profile)}
          </span>
          <span className="block text-xs text-ink-500">
            {empty
              ? 'Optional · helps break the ice'
              : 'Shown to everyone you match with · tap to edit'}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-ink-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="border-t border-ink-800 px-4 py-4">
          <ProfileFields profile={profile} onChange={onChange} onClear={onClear} />
        </div>
      )}
    </div>
  );
}
