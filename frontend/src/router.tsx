/**
 * A router, in about eighty lines, because eight static routes do not justify a
 * dependency.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `react-router`
 * ---------------------------------------------------------------------------
 * What this app needs from routing is: read the path, render one of nine
 * things, and change the path without a reload. There are no nested routes, no
 * route params, no loaders, no data APIs. A library that does all of those is
 * several hundred kilobytes and a migration every major version, in exchange
 * for solving problems this product does not have.
 *
 * If nested routes or params ever arrive, replacing this is an afternoon —
 * everything outside this file talks to it through `useRoute`, `navigate` and
 * `RouteLink`, which are the same three ideas any router exposes.
 *
 * ---------------------------------------------------------------------------
 * THE LINKS ARE REAL ANCHORS, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * `RouteLink` renders `<a href>` and intercepts the click. It does **not**
 * render a `<button>` styled as a link, which is what the overlay version of
 * these pages effectively was.
 *
 * That matters for three things a button cannot do: a crawler can follow it, a
 * middle click or ctrl-click opens a real tab, and hovering shows the
 * destination in the status bar. Any modified click is left entirely alone —
 * intercepting ctrl-click is one of the most irritating things a hand-written
 * router can do.
 *
 * ---------------------------------------------------------------------------
 * NGINX ALREADY AGREES
 * ---------------------------------------------------------------------------
 * `frontend/nginx.conf` serves `try_files $uri $uri/ /index.html`, so a cold
 * load of `/safety` returns the app rather than a 404. That was already true
 * before this file existed; nothing on the server needs changing.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';

/** Subscribers to same-tab navigation, which `popstate` does not cover. */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function currentPath(): string {
  // Trailing slashes are normalised away so `/about/` and `/about` are one
  // route rather than two that differ only in whether the link was typed by
  // hand. `/` itself survives, because it is the only path that is a slash.
  const path = window.location.pathname;
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/**
 * The current path, re-rendering the caller when it changes.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect: it is the API
 * built for exactly this, and it avoids the tearing that shows up as a flash of
 * the old route during a concurrent render.
 */
export function useRoute(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

/**
 * Go somewhere, without a reload.
 *
 * Scrolls to the top, because a router that keeps the previous scroll position
 * lands the reader halfway down a page they have not read. Browser back
 * restores position on its own through `popstate`, which is why this only
 * applies to forward navigation.
 */
export function navigate(to: string): void {
  if (to === currentPath()) return;
  window.history.pushState({}, '', to);
  window.scrollTo({ top: 0 });
  emit();
}

interface RouteLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  readonly to: string;
  readonly children: ReactNode;
}

export function RouteLink({ to, children, onClick, ...rest }: RouteLinkProps): JSX.Element {
  const handle = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;

      // Everything a browser does better than this router, left alone: opening
      // in a new tab, a new window, a download, or a non-primary button.
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.button !== 0
      ) {
        return;
      }

      event.preventDefault();
      navigate(to);
    },
    [onClick, to],
  );

  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

/**
 * Keep the document title in step with the route.
 *
 * A single-page app that never updates its title leaves every entry in the
 * browser's history list called the same thing, which makes the history menu
 * useless and the back button a guess.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
