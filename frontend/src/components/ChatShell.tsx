/**
 * The conversation layout: header, transcript, composer, actions.
 *
 * Covers both `searching` and `chatting`, because they are one continuous
 * place from the user's point of view — the search overlay sits on top of the
 * same shell rather than being a separate screen the layout jumps between.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clock, X } from 'lucide-react';

import { useDuration } from '../hooks/useDuration';
import type { ChatState } from '../state/machine';
import { colourFor, composerDisabled, glyphFor, searchingDetail, type ConnectionView } from '../view/presentation';
import { ActionBar } from './ActionBar';
import { AdRail } from './AdRail';
import { Avatar } from './Avatar';
import { ConnectionStatus } from './ConnectionStatus';
import { IcebreakerBar } from './IcebreakerBar';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import { ReconnectBanner } from './ReconnectBanner';

const SEARCHING_LINES = [
  'Looking for someone…',
  'Still searching…',
  'Nobody yet — hang on.',
  'Checking the rooms.',
  'Wandering the halls…',
] as const;

interface ChatShellProps {
  state: ChatState;
  connection: ConnectionView;
  searching: boolean;
  onSend(text: string): void;
  onTyping(active: boolean): void;
  onSkip(): void;
  onCancelSearch(): void;
  onOpenSafety(): void;
  onBack(): void;
}

export function ChatShell({
  state,
  connection,
  searching,
  onSend,
  onTyping,
  onSkip,
  onCancelSearch,
  onOpenSafety,
  onBack,
}: ChatShellProps): JSX.Element {
  const chatting = state.screen === 'chatting';
  const duration = useDuration(chatting ? state.matchStartedAt : null);
  const [icebreakerDismissed, setIcebreakerDismissed] = useState(false);

  // A new conversation gets a fresh offer of a prompt.
  useEffect(() => {
    setIcebreakerDismissed(false);
  }, [state.matchId]);

  const showIcebreaker = chatting && !icebreakerDismissed && state.messages.length === 0;
  const safetyAvailable = state.features.report || state.features.block;

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/80 backdrop-blur-md">
        <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4">
          <button
            onClick={onBack}
            aria-label="Back to home"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-200 transition-all hover:bg-ink-800 hover:text-ink-50 active:scale-95"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <Avatar
            glyph={glyphFor(state.partner)}
            colour={colourFor(state.partner)}
            size="sm"
            pulsing={searching}
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-ink-50">
                {searching ? 'Finding someone…' : (state.partner?.nickname ?? 'Stranger')}
              </h2>
              <ConnectionStatus state={connection} />
            </div>
            <div className="flex h-4 items-center gap-2 text-xs text-ink-400">
              {searching ? (
                'Looking for a stranger'
              ) : state.partnerTyping ? (
                <span className="text-amber-300">typing…</span>
              ) : (
                <>
                  <span>Anonymous</span>
                  {chatting && (
                    <>
                      <span className="text-ink-600">·</span>
                      <span className="inline-flex items-center gap-1 font-mono text-ink-500">
                        <Clock className="h-3 w-3" />
                        {duration}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {searching && (
            <button
              onClick={onCancelSearch}
              aria-label="Cancel search"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-ink-200 transition-all hover:bg-ink-800 hover:text-ink-50 active:scale-95"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
      </header>

      <ReconnectBanner connection={connection} />

      <div className="flex flex-1 overflow-hidden">
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {searching && <SearchingOverlay waiting={state.waiting} />}

          {showIcebreaker && (
            <IcebreakerBar onUse={onSend} onDismiss={() => setIcebreakerDismissed(true)} />
          )}

          <div
            className={`flex-1 overflow-hidden transition-opacity duration-300 ${
              searching ? 'pointer-events-none opacity-0' : 'opacity-100'
            }`}
          >
            <MessageList
              messages={state.messages}
              partnerTyping={state.partnerTyping}
              partnerColour={colourFor(state.partner)}
              conversationOpen={chatting}
              reported={state.reportSent}
            />
          </div>
        </div>

        <AdRail />
      </div>

      <MessageInput
        maxLength={state.limits?.maxMessageLength ?? 500}
        disabled={composerDisabled(state)}
        onSend={onSend}
        onTyping={onTyping}
      />

      {chatting && (
        <ActionBar
          safetyAvailable={safetyAvailable}
          onSkip={onSkip}
          onOpenSafety={onOpenSafety}
        />
      )}
    </div>
  );
}

function SearchingOverlay({ waiting }: { waiting: number }): JSX.Element {
  return (
    <div
      className="absolute inset-0 z-10 flex animate-fade-in flex-col items-center justify-center px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="relative flex h-40 w-40 items-center justify-center">
        <span className="absolute h-20 w-20 animate-pulse-ring rounded-full bg-amber-400/15" />
        <span
          className="absolute h-20 w-20 animate-pulse-ring rounded-full bg-amber-400/10"
          style={{ animationDelay: '0.7s' }}
        />
        <span
          className="absolute h-20 w-20 animate-pulse-ring rounded-full bg-amber-400/5"
          style={{ animationDelay: '1.4s' }}
        />
        <div className="absolute h-32 w-32 animate-[spin_8s_linear_infinite]">
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-amber-400 shadow-glow" />
        </div>
        <div className="absolute h-40 w-40 animate-[spin_12s_linear_infinite_reverse]">
          <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-sage-400" />
        </div>
        <span className="relative h-14 w-14 animate-float-slow rounded-full bg-amber-400 shadow-glow" />
      </div>

      <RotatingLine />
      <p className="mt-2 text-sm text-ink-400">{searchingDetail(waiting)}</p>
    </div>
  );
}

function RotatingLine(): JSX.Element {
  const [index, setIndex] = useState(0);
  const lengthRef = useRef(SEARCHING_LINES.length);

  useEffect(() => {
    const id = window.setInterval(() => setIndex((n) => (n + 1) % lengthRef.current), 2600);
    return () => window.clearInterval(id);
  }, []);

  return (
    <p
      key={index}
      className="mt-12 animate-fade-in font-display text-2xl font-medium text-ink-100"
    >
      {SEARCHING_LINES[index]}
    </p>
  );
}
