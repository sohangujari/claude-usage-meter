(function () {
  const EVT = '__cum_evt__';
  const originalFetch = window.fetch;

  function report(source, payload) {
    window.postMessage({ type: EVT, source, payload }, '*');
  }

  function tryReadNextData() {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (el) {
        const json = JSON.parse(el.textContent);
        const orgId =
          json?.props?.pageProps?.organization?.uuid ||
          json?.props?.pageProps?.account?.organization?.uuid ||
          null;
        if (orgId) report('orgId', orgId);
      }
    } catch (e) {}
  }
  tryReadNextData();

  // ---- SSE frame parser shared by fetch-stream and EventSource sniffing ----
  function parseSSEChunk(text, onEvent) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const evt = JSON.parse(raw);
        onEvent(evt);
      } catch (e) {}
    }
  }

  async function sniffStream(readableStream, onEvent) {
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const chunk of parts) parseSSEChunk(chunk, onEvent);
      }
    } catch (e) {}
  }

  // ---- fetch patch ----
  window.fetch = async function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req : req?.url || '';
    const response = await originalFetch.apply(this, args);

    try {
      const orgMatch = url.match(/\/organizations\/([a-f0-9-]{36})\//i);
      if (orgMatch) report('orgId', orgMatch[1]);

      // Direct usage endpoint response
      if (/\/organizations\/[a-f0-9-]{36}\/usage(\?|$)/i.test(url)) {
        response
          .clone()
          .json()
          .then((data) => report('usage', data))
          .catch(() => {});
        return response;
      }

      const contentType = response.headers.get('content-type') || '';
      const isStream = contentType.includes('text/event-stream') || contentType.includes('stream');

      if (isStream && response.body) {
        const [forPage, forSniff] = response.body.tee();

        sniffStream(forSniff, (evt) => {
          if (evt?.type === 'message_limit' && evt.message_limit) {
            report('message_limit', evt.message_limit);
          }
          // Some payload shapes nest it directly without a wrapper "type"
          if (evt?.message_limit && !evt.type) {
            report('message_limit', evt.message_limit);
          }
        });

        // When the stream ends, a turn just completed -> ask content.js to refresh /usage
        (async () => {
          const reader2 = forPage.getReader
            ? null
            : null; // no-op; the tee'd forPage stream is consumed by the page itself
        })();

        return new Response(forPage, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch (e) {}

    return response;
  };

  // ---- EventSource patch (fallback, in case Claude ever streams this way) ----
  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    window.EventSource = function (url, config) {
      const es = new OriginalEventSource(url, config);
      es.addEventListener('message', (e) => {
        try {
          const evt = JSON.parse(e.data);
          if (evt?.type === 'message_limit' && evt.message_limit) {
            report('message_limit', evt.message_limit);
          }
        } catch (err) {}
      });
      return es;
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  // Notify content.js that the sniffer is alive and ready
  report('ready', true);
})();