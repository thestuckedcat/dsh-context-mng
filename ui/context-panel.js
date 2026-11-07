/**
 * 07 context-mng: native client panel (React.createElement only, no JSX).
 *
 * This module is embedded verbatim into `client.js` (the rc.5 browser bundle
 * format has no relative-module resolution and no bundler step is in scope).
 * `tests/client-contract.test.mjs` verifies the embedded copy is
 * byte-identical to this source, so this file is the single UI source.
 *
 * Rendering rules (design §1, §8):
 *  - read-only: no session writes, no disk reads, no network beyond the
 *    connection RPC the store owns; React children only, never raw HTML;
 *  - every visible label comes from the client locale service (`t` prop),
 *    falling back to the English dictionary registered by `client.js`;
 *  - estimated UTF-8 bytes and provider-reported usage are separate blocks;
 *    provider numbers are never apportioned into the group estimate;
 *  - explicit empty/unbound/denied/stale/unavailable/error states; native
 *    buttons for every keyboard operation.
 */

export function createContextPanelIcon(React) {
  const h = React.createElement;
  return function ContextPanelIcon(props) {
    const size = props && typeof props.size === 'number' ? props.size : 18;
    const active = props && props.active === true;
    return h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        className: 'dsh-context-icon' + (active ? ' dsh-context-icon-active' : ''),
        style: { display: 'block' },
      },
      h('rect', { x: 4, y: 5, width: 4, height: 14, rx: 1, fill: 'currentColor', opacity: 0.9 }),
      h('rect', { x: 10, y: 5, width: 4, height: 8, rx: 1, fill: 'currentColor', opacity: 0.62 }),
      h('rect', { x: 16, y: 5, width: 4, height: 11, rx: 1, fill: 'currentColor', opacity: 0.38 }),
    );
  };
}

export function createContextPanel(React) {
  if (!React || typeof React.createElement !== 'function') {
    throw new TypeError('createContextPanel requires React.createElement');
  }
  const h = React.createElement;
  const STAGES = ['session_surface', 'agent_pre_step', 'llm_waterfall'];
  const N = 'panel';

  function selectCurrentSession(snapshot) {
    const byId = snapshot && snapshot.byId ? snapshot.byId : {};
    for (const id of Object.keys(byId)) {
      const row = byId[id];
      if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
    }
    return null;
  }

  function label(props, key) {
    const resolve = props && typeof props.t === 'function' ? props.t : undefined;
    if (resolve !== undefined) {
      const value = resolve(key);
      if (typeof value === 'string' && value.length > 0 && value !== key) return value;
    }
    return key;
  }

  function countText(value, unknownText) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : unknownText;
  }

  function field(props, name, value) {
    return h(
      'div',
      { key: name, className: 'dsh-context-field', 'data-field': name, title: name },
      h('span', { className: 'dsh-context-field-value' }, value),
    );
  }

  function renderHeaderFields(props, snap) {
    const fields = [
      field(props, 'session_ref', snap.session_ref === null ? '-' : snap.session_ref),
      field(props, 'context_ref', snap.context === null ? '-' : snap.context.context_ref),
      field(props, 'scope_id', snap.context === null ? '-' : snap.context.scope_id),
      h(
        'div',
        { key: 'stage', className: 'dsh-context-field', 'data-field': 'capture_stage' },
        h('span', { className: 'dsh-context-field-label' }, label(props, N + '.stage')),
        h('span', { className: 'dsh-context-field-value' }, snap.capture_stage),
      ),
      h(
        'div',
        { key: 'fidelity', className: 'dsh-context-field', 'data-field': 'fidelity' },
        h('span', { className: 'dsh-context-field-label' }, label(props, N + '.fidelity')),
        h('span', { className: 'dsh-context-field-value' }, snap.fidelity === null ? '-' : snap.fidelity),
      ),
      h(
        'div',
        { key: 'observed-at', className: 'dsh-context-field', 'data-field': 'observed_at' },
        h('span', { className: 'dsh-context-field-label' }, label(props, N + '.requestedAt')),
        h('span', { className: 'dsh-context-field-value' }, snap.observed_at === null ? '-' : snap.observed_at),
      ),
    ];
    return h('div', { className: 'dsh-context-header-fields' }, fields);
  }

  function renderToolbar(props, snap, store) {
    const stageButtons = STAGES.map((stage) =>
      h(
        'button',
        {
          key: stage,
          type: 'button',
          className: 'dsh-context-stage' + (snap.stage === stage ? ' dsh-context-stage-active' : ''),
          'aria-pressed': snap.stage === stage,
          onClick: () => store.setStage(stage),
        },
        stage,
      ),
    );
    return h(
      'div',
      { className: 'dsh-context-toolbar', role: 'group', 'aria-label': label(props, N + '.title') },
      h('div', { className: 'dsh-context-stage-group' }, stageButtons),
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-context-button',
          onClick: () => store.setPaused(!snap.paused),
        },
        snap.paused ? label(props, N + '.resume') : label(props, N + '.pause'),
      ),
      h(
        'button',
        { type: 'button', className: 'dsh-context-button', onClick: () => store.refresh() },
        label(props, N + '.refresh'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-context-button dsh-context-export',
          disabled: snap.observation === null || snap.export_roots.length === 0,
          onClick: () => store.exportReport(),
        },
        label(props, N + '.export'),
      ),
    );
  }

  function renderEstimate(props, snap) {
    const estimate = snap.estimate || {};
    const tokens = countText(estimate.tokens, label(props, N + '.unknown'));
    const children = [
      h('span', { key: 'label', className: 'dsh-context-label' }, label(props, N + '.estimated')),
      h('span', { key: 'value', className: 'dsh-context-value' }, tokens),
    ];
    if (snap.truncated === true) {
      children.push(h('span', { key: 'truncated', className: 'dsh-context-tag' }, label(props, N + '.truncated')));
    }
    if (estimate.complete === false) {
      children.push(h('span', { key: 'incomplete', className: 'dsh-context-tag' }, label(props, N + '.unknown')));
    }
    return h('div', { className: 'dsh-context-estimate', 'data-section': 'estimate' }, children);
  }

  function renderReportedUsage(props, snap) {
    const usage = snap.reported_usage;
    if (!usage) return h('div', { className: 'dsh-context-reported', 'data-section': 'reported-usage' }, h('span', { className: 'dsh-context-label' }, label(props, N + '.reported')));
    const unknown = label(props, N + '.unknown');
    return h(
      'div',
      { className: 'dsh-context-reported', 'data-section': 'reported-usage' },
      h('span', { className: 'dsh-context-label' }, label(props, N + '.reported')),
      h('span', { className: 'dsh-context-value' }, 'input=' + countText(usage.input_tokens, unknown)),
      h('span', { className: 'dsh-context-value' }, 'output=' + countText(usage.output_tokens, unknown)),
      h('span', { className: 'dsh-context-value' }, 'cached=' + countText(usage.cached_input_tokens, unknown)),
    );
  }

  function renderGroup(props, snap, store, group, totalBytes) {
    const groupId = group.group_id;
    const expanded = snap.expanded[groupId] === true;
    const textState = snap.group_texts[groupId];
    const unknown = label(props, N + '.unknown');
    const percent = totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((group.bytes / totalBytes) * 100))) : 0;
    const category = group.category === 'unknown' ? unknown : group.category;
    const rows = [
      h(
        'div',
        { key: 'summary', className: 'dsh-context-group-summary' },
        h('span', { className: 'dsh-context-category' }, category),
        h('span', { className: 'dsh-context-certainty' }, group.certainty),
        h('span', { className: 'dsh-context-count' }, 'chars=' + countText(group.characters, unknown)),
        h('span', { className: 'dsh-context-count' }, 'bytes=' + countText(group.bytes, unknown)),
        h('span', { className: 'dsh-context-count' }, label(props, N + '.estimated') + '=' + countText(group.estimated_tokens, unknown)),
        group.redaction_count > 0
          ? h('span', { key: 'redactions', className: 'dsh-context-count' }, label(props, N + '.redactions') + '=' + countText(group.redaction_count, unknown))
          : null,
        group.truncated === true ? h('span', { key: 'truncated', className: 'dsh-context-tag' }, label(props, N + '.truncated')) : null,
      ),
      h(
        'div',
        { key: 'bar', className: 'dsh-context-bar', 'aria-hidden': true },
        h('div', { className: 'dsh-context-bar-fill', style: { width: percent + '%' } }),
      ),
      h('p', { key: 'preview', className: 'dsh-context-preview' }, group.preview),
      h(
        'button',
        {
          key: 'expand',
          type: 'button',
          className: 'dsh-context-button dsh-context-expand',
          'aria-expanded': expanded,
          onClick: () => store.toggleGroup(groupId),
        },
        expanded ? label(props, N + '.group.collapse') : label(props, N + '.group.expand'),
      ),
    ];
    if (expanded) {
      if (textState === undefined || textState.loading === true) {
        rows.push(h('p', { key: 'text-loading', className: 'dsh-context-body-text' }, label(props, N + '.loading')));
      } else {
        if (textState.error) {
          rows.push(h('p', { key: 'text-error', className: 'dsh-context-error' }, label(props, N + '.unavailable')));
        }
        rows.push(h('pre', { key: 'text', className: 'dsh-context-body-text' }, textState.text === undefined ? '' : textState.text));
        if (textState.next_offset !== null && textState.next_offset !== undefined) {
          rows.push(
            h(
              'button',
              {
                key: 'more',
                type: 'button',
                className: 'dsh-context-button',
                title: 'next_offset',
                onClick: () => store.loadMoreGroup(groupId),
              },
              '…',
            ),
          );
        }
      }
    }
    return h('li', { key: groupId, className: 'dsh-context-group', 'data-group-id': groupId }, rows);
  }

  function renderReady(props, snap, store) {
    const groups = snap.groups || [];
    let totalBytes = 0;
    for (const group of groups) {
      if (typeof group.bytes === 'number' && Number.isSafeInteger(group.bytes) && group.bytes > 0) totalBytes += group.bytes;
    }
    const children = [
      h('div', { key: 'totals', className: 'dsh-context-totals', 'data-section': 'estimate' }, [
        h('span', { key: 'label', className: 'dsh-context-label' }, label(props, N + '.estimated')),
        h('span', { key: 'value', className: 'dsh-context-value' }, countText(totalBytes, label(props, N + '.unknown'))),
      ]),
      renderEstimate(props, snap),
      renderReportedUsage(props, snap),
      groups.length === 0
        ? h('p', { key: 'no-groups', className: 'dsh-context-empty' }, label(props, N + '.empty'))
        : h('ul', { key: 'groups', className: 'dsh-context-groups' }, groups.map((group) => renderGroup(props, snap, store, group, totalBytes))),
    ];
    return children;
  }

  function renderExportState(props, snap) {
    const state = snap.export_state || { phase: 'idle' };
    const unknown = label(props, N + '.unknown');
    if (state.phase === 'idle') {
      if (snap.export_roots.length === 0) {
        return h('p', { className: 'dsh-context-hint' }, label(props, N + '.export.emptyHint'));
      }
      return null;
    }
    if (state.phase === 'exporting') {
      return h('p', { className: 'dsh-context-export-state' }, label(props, N + '.loading'));
    }
    if (state.phase === 'saved') {
      return h(
        'p',
        { className: 'dsh-context-export-state', 'data-export-phase': 'saved' },
        label(props, N + '.export') + ' ' + (state.report_ref === null ? unknown : state.report_ref) + ' ' + (state.digest === null ? unknown : state.digest),
      );
    }
    if (state.phase === 'conflict') {
      return h('p', { className: 'dsh-context-export-state', 'data-export-phase': 'conflict' }, label(props, N + '.export') + ' EXPORT_CONFLICT');
    }
    if (state.phase === 'denied') {
      return h('p', { className: 'dsh-context-error', 'data-export-phase': 'denied' }, label(props, N + '.denied'));
    }
    return h(
      'p',
      { className: 'dsh-context-error', 'data-export-phase': 'error' },
      label(props, N + '.unavailable') + ' ' + (state.reason_code === null || state.reason_code === undefined ? 'TRANSPORT_FAILURE' : state.reason_code),
    );
  }

  function renderStatus(props, snap) {
    if (snap.status === 'loading' || snap.status === 'idle') return h('p', { className: 'dsh-context-state' }, label(props, N + '.loading'));
    if (snap.status === 'unbound') return h('p', { className: 'dsh-context-state' }, label(props, N + '.unbound'));
    if (snap.status === 'empty') return h('p', { className: 'dsh-context-state' }, label(props, N + '.empty'));
    if (snap.status === 'denied') return h('p', { className: 'dsh-context-error' }, label(props, N + '.denied'));
    if (snap.status === 'stale') return h('p', { className: 'dsh-context-state' }, label(props, N + '.stale'));
    if (snap.status === 'unavailable') return h('p', { className: 'dsh-context-state' }, label(props, N + '.unavailable'));
    if (snap.status === 'error') {
      return h(
        'p',
        { className: 'dsh-context-error', 'data-error-code': snap.error_code === null ? 'INTERNAL_FAILURE' : snap.error_code },
        label(props, N + '.unavailable') + ' ' + (snap.error_code === null ? 'INTERNAL_FAILURE' : snap.error_code),
      );
    }
    return null;
  }

  return function ContextPanel(props) {
    const store = props && props.store;
    if (!store || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') {
      return h('div', { className: 'dsh-context-panel dsh-context-panel-error' }, h('p', null, label(props, N + '.unavailable')));
    }
    const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    const useSessions = props.useSessions;
    const currentSessionId = typeof useSessions === 'function' ? useSessions(selectCurrentSession) : null;
    React.useEffect(() => {
      store.setPanelActive(true);
      return () => store.setPanelActive(false);
    }, []);
    React.useEffect(() => {
      // A null current session is a real state change: clearing the store is
      // what drops the previous session's groups/text/exports and stops its
      // polling (design §6). Only waiting for non-null ids would leak the old
      // session's data when the main session goes away.
      store.selectSession(currentSessionId === null || currentSessionId === undefined ? null : currentSessionId);
    }, [currentSessionId]);

    const children = [
      h(
        'header',
        { key: 'header', className: 'dsh-context-header' },
        h('h2', { className: 'dsh-context-title' }, label(props, N + '.title')),
        h(
          'button',
          {
            key: 'close',
            type: 'button',
            className: 'dsh-context-close',
            'aria-label': '×',
            title: label(props, N + '.title'),
            onClick: () => {
              if (typeof props.closePanel === 'function') props.closePanel();
            },
          },
          '×',
        ),
      ),
      h('div', { key: 'fields', className: 'dsh-context-meta' }, renderHeaderFields(props, snap)),
      h('div', { key: 'toolbar', className: 'dsh-context-actions' }, renderToolbar(props, snap, store)),
    ];

    const status = renderStatus(props, snap);
    if (status !== null) children.push(h('div', { key: 'status', className: 'dsh-context-body' }, status));
    if (snap.status === 'ready') {
      children.push(h('div', { key: 'ready', className: 'dsh-context-body' }, renderReady(props, snap, store)));
    }
    const exportState = renderExportState(props, snap);
    if (exportState !== null) children.push(h('div', { key: 'export', className: 'dsh-context-export-state-wrap' }, exportState));
    return h('section', { className: 'dsh-context-panel', 'aria-label': label(props, N + '.title') }, children);
  };
}
