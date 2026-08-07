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
      // Next.js payload shape is not guaranteed; network sniffing covers this.
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
        // Partial or non-JSON frame.
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

  // Returns a replacement Response when the body had to be tee'd, else null.
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

  window.fetch = async function (...args) {
    const response = await originalFetch.call(window, ...args);

    // Sniffing must never break the page's own request.
    try {
      return sniff(String(args[0]?.url ?? args[0] ?? ''), response) ?? response;
    } catch {
      return response;
    }
  };

  reportOrgIdFromPageData();
})();
