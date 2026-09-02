(function () {
  'use strict';

  const SNIFFER_EVENT = '__claude_usage_meter__';
  const ORG_ID_PATTERN = /\/organizations\/([a-f0-9-]{36})\//i;
  const USAGE_PATTERN = /\/organizations\/[a-f0-9-]{36}\/usage(\?|$)/i;

  const originalFetch = window.fetch;

  function report(channel, payload) {
    window.postMessage({ type: SNIFFER_EVENT, channel, payload }, window.location.origin);
  }

  function reportOrgIdFromPageData() {
    const element = document.getElementById('__NEXT_DATA__');
    if (!element) return;

    try {
      const pageProps = JSON.parse(element.textContent)?.props?.pageProps;
      const orgId = pageProps?.organization?.uuid ?? pageProps?.account?.organization?.uuid;
      if (orgId) report('orgId', orgId);
    } catch {
    }
  }

  function parseSSEFrame(frame, onEvent) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      try {
        onEvent(JSON.parse(data));
      } catch {
      }
    }
  }

  async function readSSEStream(stream, onEvent) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        buffer += decoder.decode(chunk.value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const frame of frames) parseSSEFrame(frame, onEvent);
      }
    } catch {
      reader.cancel().catch(() => {});
    }
  }

  function sniff(url, response) {
    const orgId = url.match(ORG_ID_PATTERN);
    if (orgId) report('orgId', orgId[1]);

    if (USAGE_PATTERN.test(url)) {
      response
        .clone()
        .json()
        .then((data) => report('usage', data))
        .catch(() => {});
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) return null;

    const [forPage, forSniffer] = response.body.tee();
    readSSEStream(forSniffer, (event) => {
      if (event?.message_limit) report('messageLimit', event.message_limit);
    });

    return new Response(forPage, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const ORG_ID_ONLY = /^[a-f0-9-]{36}$/i;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== SNIFFER_EVENT) return;
    if (event.data.channel !== 'fetchUsage' || !ORG_ID_ONLY.test(event.data.payload ?? '')) return;

    window
      .fetch(`https://claude.ai/api/organizations/${event.data.payload}/usage`, {
        credentials: 'include',
      })
      .catch(() => {});
  });

  window.fetch = async function (...args) {
    const response = await originalFetch.call(window, ...args);

    try {
      return sniff(String(args[0]?.url ?? args[0] ?? ''), response) ?? response;
    } catch {
      return response;
    }
  };

  reportOrgIdFromPageData();
})();
