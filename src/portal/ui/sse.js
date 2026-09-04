// Server-Sent Events over fetch (EventSource cannot send the Authorization
// header the portal uses). Parses `event:`/`data:` frames and calls
// onEvent(event, data). Returns a stop() function.
export function sseSubscribe(url, onEvent, onState) {
  const P = window.NexusPortal;
  const controller = new AbortController();
  let stopped = false;

  (async () => {
    try {
      const res = await P.apiFetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) { onState && onState('error', 'HTTP ' + res.status); return; }
      onState && onState('open');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          const dataLines = [];
          frame.split('\n').forEach((line) => {
            if (line.startsWith(':')) return;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          });
          if (dataLines.length === 0) continue;
          try { onEvent(event, JSON.parse(dataLines.join('\n'))); } catch (_) { /* malformed frame */ }
        }
      }
      onState && onState('closed');
    } catch (err) {
      if (!stopped) onState && onState('error', err && err.message ? err.message : 'stream failed');
    }
  })();

  return () => { stopped = true; controller.abort(); };
}
