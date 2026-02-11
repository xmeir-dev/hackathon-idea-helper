const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json());
app.use(express.static('public'));

app.post('/api/generate', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        messages: [{ role: 'user', content: req.body.prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    res.json({ text: data.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/generate-stream', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);
  // Padding to push past proxy buffer thresholds
  res.write(`: ${' '.repeat(4096)}\n\n`);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        stream: true,
        messages: [{ role: 'user', content: req.body.prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
      res.end();
      return;
    }

    let accumulated = '';
    let sentCount = 0;
    let parsePos = 0;
    const maxIdeas = 15;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    outer:
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            accumulated += event.delta.text;

            while (sentCount < maxIdeas) {
              const objStart = accumulated.indexOf('{', parsePos);
              if (objStart === -1) break;

              let depth = 0;
              let inString = false;
              let escape = false;
              let objEnd = -1;

              for (let i = objStart; i < accumulated.length; i++) {
                const c = accumulated[i];
                if (escape) { escape = false; continue; }
                if (c === '\\' && inString) { escape = true; continue; }
                if (c === '"') { inString = !inString; continue; }
                if (inString) continue;
                if (c === '{') depth++;
                if (c === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
              }

              if (objEnd === -1) break;

              const objStr = accumulated.substring(objStart, objEnd + 1);
              parsePos = objEnd + 1;
              try {
                const idea = JSON.parse(objStr);
                if (idea.name && idea.desc) {
                  sentCount++;
                  res.write(`data: ${JSON.stringify({ idea })}\n\n: ${' '.repeat(4096)}\n\n`);
                  if (sentCount >= maxIdeas) break outer;
                }
              } catch (_) { /* incomplete JSON, skip */ }
            }
          }
        } catch (_) { /* ignore parse errors */ }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
