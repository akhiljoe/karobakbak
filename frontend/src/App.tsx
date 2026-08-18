/**
 * The application shell.
 *
 * One screen at a time, chosen by the state machine. The controls a user sees
 * are gated on `features` from the `connected` frame, so this build never
 * offers a button for something the server has turned off — a client that
 * discovers a capability through a rejection is a client that has to explain
 * the rejection.
 */
import { useState } from 'react';

import { AdSlot } from './components/AdSlot';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { ReportDialog } from './components/ReportDialog';
import { useChat } from './hooks/useChat';
import type { ReportCategory } from './protocol/types';

export function App(): JSX.Element {
  const chat = useChat();
  const { state } = chat;
  const [reporting, setReporting] = useState(false);

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">karobakbak</h1>
        {state.features.presence && state.presence ? (
          <p className="presence" title="Counts are approximate">
            <span className="presence__dot" aria-hidden="true" />
            {state.presence.online.toLocaleString()} here · {state.presence.conversations.toLocaleString()} talking
            <span className="presence__hint"> (approx.)</span>
          </p>
        ) : null}
      </header>

      {state.notice ? (
        <p className="notice" role="status">
          {state.notice}
          <button className="notice__close" onClick={chat.dismissNotice} aria-label="Dismiss">
            ×
          </button>
        </p>
      ) : null}

      <main className="main">
        {state.screen === 'connecting' ? <Connecting /> : null}
        {state.screen === 'disconnected' ? <Connecting reconnecting /> : null}

        {state.screen === 'idle' ? (
          <section className="panel">
            <h2 className="panel__title">Talk to a stranger</h2>
            <p className="panel__lead">
              Text only. No account, no profile, no history you carry around. Either of you can leave
              at any moment.
            </p>
            <button className="button button--primary" onClick={chat.start}>
              Start chatting
            </button>
            <AdSlot slot="landing" />
          </section>
        ) : null}

        {state.screen === 'searching' ? (
          <section className="panel">
            <h2 className="panel__title">Finding someone…</h2>
            <p className="panel__lead">
              {state.waiting > 1
                ? `${state.waiting.toLocaleString()} people are looking right now.`
                : 'You are first in the queue. This usually takes a moment.'}
            </p>
            <button className="button" onClick={chat.stop}>
              Cancel
            </button>
          </section>
        ) : null}

        {state.screen === 'ended' ? (
          <section className="panel">
            <h2 className="panel__title">
              {state.endReason === 'you_blocked' ? 'Blocked' : 'Conversation ended'}
            </h2>
            <p className="panel__lead">
              {state.endReason === 'you_blocked'
                ? 'You will not be matched with them again.'
                : 'They are gone. There is no way back to that conversation.'}
            </p>
            <button className="button button--primary" onClick={chat.start}>
              Find someone else
            </button>
            <AdSlot slot="between-chats" />
          </section>
        ) : null}

        {state.screen === 'chatting' && state.you && state.partner ? (
          <section className="chat">
            <div className="chat__bar">
              <span className="chat__partner" style={{ color: state.partner.colour }}>
                {state.partner.nickname}
              </span>
              <div className="chat__actions">
                {state.features.report ? (
                  <button
                    className="button button--quiet"
                    onClick={() => setReporting(true)}
                    disabled={state.reportSent}
                  >
                    {state.reportSent ? 'Reported' : 'Report'}
                  </button>
                ) : null}
                {state.features.block ? (
                  <button className="button button--quiet" onClick={chat.block}>
                    Block
                  </button>
                ) : null}
                <button className="button" onClick={chat.skip}>
                  Next stranger
                </button>
              </div>
            </div>

            <MessageList
              messages={state.messages}
              youNickname={state.you.nickname}
              partnerNickname={state.partner.nickname}
              youColour={state.you.colour}
              partnerColour={state.partner.colour}
            />

            <p className="typing" aria-live="polite">
              {state.partnerTyping ? `${state.partner.nickname} is typing…` : ' '}
            </p>

            <Composer
              maxLength={state.limits?.maxMessageLength ?? 500}
              onSend={chat.send}
              onTyping={chat.typing}
            />
          </section>
        ) : null}
      </main>

      <footer className="footer">
        <p>
          Conversations are kept for a limited period so abuse can be investigated, then deleted.
          They are never shown back to you.
        </p>
      </footer>

      {reporting ? (
        <ReportDialog
          maxNoteLength={state.limits?.maxReportNoteLength ?? 500}
          onCancel={() => setReporting(false)}
          onSubmit={(category: ReportCategory, note: string) => {
            chat.report(category, note);
            setReporting(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Connecting({ reconnecting = false }: { reconnecting?: boolean }): JSX.Element {
  return (
    <section className="panel">
      <h2 className="panel__title">{reconnecting ? 'Reconnecting…' : 'Connecting…'}</h2>
      <p className="panel__lead">
        {reconnecting
          ? 'A dropped connection ends the conversation — there is no way to resume one.'
          : 'One moment.'}
      </p>
    </section>
  );
}
