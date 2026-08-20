/**
 * Telling someone they matched, when they are not looking at the page.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * Finding a stranger takes seconds to tens of seconds, which is exactly long
 * enough for a person to switch tabs. They come back to a conversation the
 * stranger already abandoned, and the product reads as dead when it was working
 * perfectly.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ONLY FIRES WHEN THE TAB IS HIDDEN
 * ---------------------------------------------------------------------------
 * Someone watching the screen can see they matched. A sound at that moment is
 * noise, and a desktop notification is worse — it is a notification about
 * something already visible. Every path here is gated on `document.hidden`.
 *
 * ---------------------------------------------------------------------------
 * NO AUDIO FILE
 * ---------------------------------------------------------------------------
 * The tone is synthesised. A bundled sound would be a network request, a cache
 * entry and a CSP `media-src` to widen, all for two hundred milliseconds of
 * sine wave. It also means the sound cannot fail to load.
 *
 * Browsers refuse to start audio without a user gesture, so the context is
 * unlocked on the click that starts a search — the one gesture guaranteed to
 * precede any match.
 */

let audioContext: AudioContext | null = null;

/**
 * Prepare audio on a user gesture.
 *
 * Called from the click that begins a search. Safe to call repeatedly, and
 * silently does nothing where Web Audio is unavailable — a missing chime must
 * never be the reason anything else fails.
 */
export function unlockSound(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioContext ??= new Ctor();
    if (audioContext.state === 'suspended') void audioContext.resume();
  } catch {
    audioContext = null;
  }
}

/**
 * Two short notes, quietly.
 *
 * Deliberately unobtrusive: this fires while someone is doing something else,
 * and a chat app that startles people is one they close. The gain envelope
 * ramps rather than switching, because an abrupt start and stop is what makes a
 * synthesised tone sound like a click.
 */
export function playMatchChime(): void {
  const context = audioContext;
  if (!context || context.state !== 'running') return;

  try {
    const now = context.currentTime;
    for (const [index, frequency] of [660, 880].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + index * 0.12;

      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.06, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.2);
    }
  } catch {
    // A chime is a courtesy. Never let one break a conversation.
  }
}

/**
 * Put the news in the tab title.
 *
 * The one channel that needs no permission, makes no sound, and is visible in
 * the place someone actually looks when scanning their tabs. Restored the
 * moment the page is looked at again.
 */
export function setTitleAlert(active: boolean, baseTitle: string): void {
  try {
    document.title = active ? `\u{1F7E2} Matched! · ${baseTitle}` : baseTitle;
  } catch {
    // Non-fatal by construction.
  }
}

export type NotificationOutcome = 'granted' | 'denied' | 'unsupported';

/**
 * Ask for desktop notification permission.
 *
 * Called **only** when someone turns the setting on, never on page load. An
 * unprompted permission dialog from a site the visitor has used for ten seconds
 * is the pattern everyone has learned to dismiss, and a denial is sticky — one
 * badly-timed prompt costs the capability permanently.
 */
export async function requestNotificationPermission(): Promise<NotificationOutcome> {
  try {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    const result = await Notification.requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/**
 * A desktop notification, if the person granted one.
 *
 * Carries no conversation content — not the partner's declared name, not a
 * message. A notification is rendered by the operating system, lands in a
 * notification centre, and may sit on a lock screen where someone else can read
 * it. None of that is inside the boundary conversation content is allowed to
 * occupy (I8), and "a stranger is waiting" is the whole message anyway.
 */
export function showMatchNotification(): void {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const notification = new Notification('You matched', {
      body: 'A stranger is waiting to talk.',
      tag: 'karobakbak-match',
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers throw on construction rather than reporting unsupported.
  }
}
