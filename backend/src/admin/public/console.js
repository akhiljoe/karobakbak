/*
 * Moderation console.
 *
 * ---------------------------------------------------------------------------
 * EVERY PIECE OF USER TEXT GOES IN THROUGH textContent
 * ---------------------------------------------------------------------------
 * This page renders message bodies and report notes — strings a stranger typed
 * with no expectation that they would be read by a program. There is not one
 * `innerHTML` assignment in this file, and there must never be one.
 *
 * The reason is sharper here than on an ordinary page. This origin holds a
 * session that can read every retained conversation, so a script injected
 * through a message body would be able to walk the entire queue and exfiltrate
 * it. The Content-Security-Policy (`script-src 'self'`, no inline) is the
 * second line; `textContent` is the first, and it is the one that does not
 * depend on a header surviving a future refactor.
 *
 * ---------------------------------------------------------------------------
 * NO FRAMEWORK
 * ---------------------------------------------------------------------------
 * Roughly four hundred lines and three screens, served by a Node process that
 * has four dependencies. A build step and a framework would add a toolchain,
 * a bundle and a supply chain to the one origin in this system with the most
 * to lose, in exchange for convenience on a page with two forms.
 */

(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var state = {
    identity: null,
    reports: [],
    selected: null,
    detail: null,
    busy: false,
  };

  /* --- transport --------------------------------------------------------- */

  /**
   * Every call is same-origin with credentials. A 401 anywhere drops straight
   * back to the sign-in screen rather than leaving a half-usable page: the
   * session has an absolute expiry, so this happens to a working console
   * roughly once a shift.
   */
  function api(method, path, body) {
    var options = {
      method: method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    };
    if (body !== undefined) options.body = JSON.stringify(body);

    return fetch(path, options).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (payload) {
          if (response.status === 401) {
            state.identity = null;
            render();
            throw new Error('Your session has ended. Sign in again.');
          }
          if (!response.ok) {
            throw new Error(messageFor(response.status, payload));
          }
          return payload;
        });
    });
  }

  /** Turn an API error into something an operator can act on. */
  function messageFor(status, payload) {
    if (payload && typeof payload.detail === 'string') return payload.detail;
    var code = payload && payload.error;
    if (code === 'invalid_request') return 'That request was rejected. Check the reason field.';
    if (code === 'already_resolved') return 'Someone else has already decided this report.';
    if (code === 'not_found') return 'That report is gone. It may have passed its retention deadline.';
    if (code === 'no_subject') return 'No identity was recorded for this conversation.';
    if (code === 'apply_failed') return 'The ban was recorded and then withdrawn: it could not be applied.';
    if (status === 429) return 'Too many attempts. Wait a minute.';
    if (status === 423) return 'This account is locked. Try again later.';
    if (status === 503) return 'The service is unavailable. Try again shortly.';
    return 'Something went wrong (' + status + ').';
  }

  /* --- small helpers ----------------------------------------------------- */

  function show(node, visible) {
    node.hidden = !visible;
  }

  function setError(node, message) {
    if (!message) {
      show(node, false);
      node.textContent = '';
      return;
    }
    node.textContent = message;
    show(node, true);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // Always textContent. See the header of this file.
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** "3 days" / "4 hours" / "12 minutes" — enough to judge urgency. */
  function age(iso) {
    var seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 90) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 90) return minutes + ' min';
    var hours = Math.round(minutes / 60);
    if (hours < 36) return hours + ' hr';
    return Math.round(hours / 24) + ' days';
  }

  function clock(iso) {
    var date = new Date(iso);
    return (
      String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    );
  }

  function busy(value) {
    state.busy = value;
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = value;
  }

  /* --- sign in ----------------------------------------------------------- */

  $('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    setError($('login-error'), '');
    busy(true);

    api('POST', '/api/login', {
      username: $('username').value,
      password: $('password').value,
      code: $('code').value,
    })
      .then(function (identity) {
        state.identity = identity;
        // Clear the credentials out of the DOM immediately. They are of no
        // further use to the page and a filled password field survives a
        // back-navigation.
        $('password').value = '';
        $('code').value = '';
        render();
        return loadQueue();
      })
      .catch(function (err) {
        setError($('login-error'), err.message);
      })
      .then(function () {
        busy(false);
      });
  });

  $('logout').addEventListener('click', function () {
    busy(true);
    api('POST', '/api/logout', {})
      .catch(function () {
        // A failed logout still ends the session on this page. Leaving the
        // console looking signed-in because the request failed is worse than
        // forgetting locally.
        return null;
      })
      .then(function () {
        state.identity = null;
        state.detail = null;
        state.selected = null;
        busy(false);
        render();
      });
  });

  /* --- the queue --------------------------------------------------------- */

  function loadQueue() {
    return api('GET', '/api/reports')
      .then(function (payload) {
        state.reports = payload.reports || [];
        renderQueue();
      })
      .catch(function () {
        // Rendering an empty queue on a transport error would read as "nothing
        // to do", which is the most dangerous wrong answer this screen can
        // give. Leave whatever was there and say nothing changed.
        return null;
      });
  }

  $('refresh').addEventListener('click', function () {
    busy(true);
    loadQueue().then(function () {
      busy(false);
    });
  });

  function renderQueue() {
    var list = $('queue-list');
    clear(list);
    show($('queue-empty'), state.reports.length === 0);

    state.reports.forEach(function (report) {
      var item = document.createElement('li');
      var button = el('button', 'queue-item');
      button.type = 'button';
      button.setAttribute('aria-current', String(report.reportId === state.selected));

      var row = el('div', 'queue-row');
      row.appendChild(el('span', 'category', report.category));
      row.appendChild(el('span', 'age', age(report.createdAt)));
      button.appendChild(row);

      var chips = el('div', 'chips');
      chips.appendChild(el('span', 'chip', report.messageCount + ' msg'));
      (report.flags || []).forEach(function (flag) {
        chips.appendChild(el('span', 'chip', flag));
      });
      if (report.hasWithheldMessage) chips.appendChild(el('span', 'chip withheld', 'withheld'));
      button.appendChild(chips);

      button.addEventListener('click', function () {
        selectReport(report);
      });
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  /* --- opening a case ---------------------------------------------------- */

  function selectReport(report) {
    state.selected = report.reportId;
    state.detail = null;
    renderQueue();

    show($('placeholder'), false);
    show($('review'), false);
    show($('open-gate'), true);

    $('open-title').textContent = 'Report · ' + report.category;
    var meta = $('open-meta');
    clear(meta);
    addMeta(meta, 'Reported', age(report.createdAt) + ' ago');
    addMeta(meta, 'Messages', String(report.messageCount));
    if ((report.flags || []).length > 0) addMeta(meta, 'Rules fired', report.flags.join(', '));

    $('open-reason').value = '';
    setError($('open-error'), '');
    $('open-reason').focus();
  }

  function addMeta(list, term, value) {
    list.appendChild(el('dt', null, term));
    list.appendChild(el('dd', null, value));
  }

  $('open-gate').addEventListener('submit', function (event) {
    event.preventDefault();
    if (!state.selected) return;
    setError($('open-error'), '');
    busy(true);

    api('POST', '/api/reports/open', {
      reportId: state.selected,
      justification: $('open-reason').value,
    })
      .then(function (detail) {
        state.detail = detail;
        renderReview();
      })
      .catch(function (err) {
        setError($('open-error'), err.message);
      })
      .then(function () {
        busy(false);
      });
  });

  /* --- the transcript ---------------------------------------------------- */

  function renderReview() {
    var detail = state.detail;
    show($('open-gate'), false);
    show($('placeholder'), false);
    show($('review'), true);

    $('review-title').textContent = 'Conversation · ' + detail.category;

    var meta = $('review-meta');
    clear(meta);
    addMeta(meta, 'Started', new Date(detail.startedAt).toLocaleString());
    addMeta(meta, 'Ended', detail.endedAt ? detail.endReason || 'ended' : 'still open');
    addMeta(meta, 'Messages', String(detail.messages.length));
    // Said plainly, because a ban button that silently does nothing is worse
    // than one that is visibly unavailable.
    var hasSubject = Boolean(detail.reportedKeys.ipHash || detail.reportedKeys.clientHash);
    addMeta(meta, 'Can be banned', hasSubject ? 'yes' : 'no identity recorded');

    // Declarations, before the transcript: a report is often *about* one of
    // these, and they never appear in the conversation itself.
    renderDeclared(detail.declared);

    var noteBlock = $('note-block');
    if (detail.note) {
      $('note-text').textContent = detail.note;
      show(noteBlock, true);
    } else {
      show(noteBlock, false);
    }

    var transcript = $('transcript');
    clear(transcript);
    detail.messages.forEach(function (message) {
      var line = document.createElement('li');
      line.className = 'line ' + message.side;

      var head = el('div', 'line-head');
      head.appendChild(el('span', null, message.side === 'reported' ? 'reported party' : message.side === 'reporter' ? 'reporter' : 'unknown'));
      head.appendChild(el('span', null, clock(message.at)));
      if (message.moderationAction && message.moderationAction !== 'allow') {
        head.appendChild(el('span', 'withheld-mark', message.moderationAction));
      }
      line.appendChild(head);

      line.appendChild(el('div', 'line-body', message.body));

      if ((message.flags || []).length > 0) {
        var flags = el('div', 'line-flags');
        message.flags.forEach(function (flag) {
          flags.appendChild(el('span', 'chip', flag));
        });
        line.appendChild(flags);
      }
      transcript.appendChild(line);
    });

    $('verdict-reason').value = '';
    setError($('verdict-error'), '');
    show($('verdict-ok'), false);
    $('verdict-bot').disabled = !hasSubject;
  }

  /**
   * Render both declarations, labelled as claims.
   *
   * "declared" is doing real work in that label. Nothing here was verified,
   * `age` is not age assurance, and a moderator reading "27" as a fact about a
   * person is the mistake this wording exists to prevent.
   */
  function renderDeclared(declared) {
    var block = $('declared-block');
    var list = $('declared-list');
    clear(list);

    var sides = [
      ['Reported party declared', declared.reported],
      ['Reporter declared', declared.reporter],
    ];
    var any = false;

    sides.forEach(function (entry) {
      var label = entry[0];
      var profile = entry[1];
      list.appendChild(el('dt', null, label));
      if (!profile) {
        list.appendChild(el('dd', 'muted', 'nothing'));
        return;
      }
      any = true;
      var parts = [];
      if (profile.name) parts.push('name: ' + profile.name);
      if (profile.age !== null && profile.age !== undefined) parts.push('age: ' + profile.age);
      if (profile.gender) parts.push('gender: ' + profile.gender);
      if (profile.country) parts.push('country: ' + profile.country);
      list.appendChild(el('dd', null, parts.length > 0 ? parts.join(' · ') : 'nothing'));
    });

    show(block, true);
    $('declared-caveat').hidden = !any;
  }

  /* --- deciding ---------------------------------------------------------- */

  function finish(message) {
    $('verdict-ok').textContent = message;
    show($('verdict-ok'), true);
    setError($('verdict-error'), '');
    state.detail = null;
    state.selected = null;
    // The report leaves the queue, so the pane it was filling has to go too.
    window.setTimeout(function () {
      show($('review'), false);
      show($('placeholder'), true);
    }, 1200);
    return loadQueue();
  }

  $('verdict-bot').addEventListener('click', function () {
    var reason = $('verdict-reason').value;
    var reportId = state.selected;
    if (!reportId) return;
    setError($('verdict-error'), '');
    busy(true);

    // Ban first, then close the report. The other order would leave a closed
    // report behind if the ban failed, and a closed report is one nobody looks
    // at again — the sanction would be quietly lost.
    api('POST', '/api/enforcement/ban', {
      reportId: reportId,
      seconds: Number($('ban-length').value),
      reason: 'moderation',
      justification: reason,
    })
      .then(function (result) {
        return api('POST', '/api/reports/resolve', {
          reportId: reportId,
          outcome: 'ACTIONED',
          resolution: 'banned for ' + result.dimensions + ' dimensions',
          justification: reason,
        }).then(function () {
          return finish('Banned until ' + new Date(result.expiresAt).toLocaleDateString() + '.');
        });
      })
      .catch(function (err) {
        setError($('verdict-error'), err.message);
      })
      .then(function () {
        busy(false);
      });
  });

  $('verdict-human').addEventListener('click', function () {
    var reportId = state.selected;
    if (!reportId) return;
    setError($('verdict-error'), '');
    busy(true);

    api('POST', '/api/reports/resolve', {
      reportId: reportId,
      outcome: 'DISMISSED',
      resolution: 'reviewed, no action',
      justification: $('verdict-reason').value,
    })
      .then(function () {
        return finish('Dismissed. No sanction recorded.');
      })
      .catch(function (err) {
        setError($('verdict-error'), err.message);
      })
      .then(function () {
        busy(false);
      });
  });

  /* --- boot -------------------------------------------------------------- */

  function render() {
    var signedIn = state.identity !== null;
    show($('gate'), !signedIn);
    show($('console'), signedIn);
    show($('who'), signedIn);
    if (signedIn) {
      $('who-name').textContent = state.identity.username;
      $('who-role').textContent = state.identity.role.replace(/_/g, ' ');
    }
  }

  // Ask whether a session already exists before showing a sign-in form, so a
  // reload does not look like a logout.
  fetch('/api/session', { credentials: 'same-origin' })
    .then(function (response) {
      return response.ok ? response.json() : null;
    })
    .catch(function () {
      return null;
    })
    .then(function (identity) {
      state.identity = identity;
      render();
      if (identity) loadQueue();
    });
})();
