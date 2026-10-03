// Small, safe Markdown renderer for Sai replies: escapes all HTML first, then
// handles paragraphs, headings, lists, bold/italic, inline code, code blocks and links.
(function () {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function fileEmoji(name) {
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return '🖼️';
    if (/\.(pdf)$/i.test(name)) return '📕';
    if (/\.(csv|xlsx?)$/i.test(name)) return '📊';
    return '📄';
  }

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      if (/^https:\/\/(drive|docs)\.google\.com\//.test(url)) {
        return `<a href="${url}" class="ext file-chip" title="Open in Google Drive"><span class="fc-icon">${fileEmoji(label)}</span>${label}<span class="fc-open">Drive ↗</span></a>`;
      }
      if (/^https:\/\//.test(url)) return `<a href="${url}" class="ext">${label}</a>`;
      if (/^sai:\/\/file\//.test(url)) {
        return `<span class="file-chip local" title="Saved on your Sai computer. It isn't downloadable from this app yet."><span class="fc-icon">${fileEmoji(label)}</span>${label}</span>`;
      }
      if (/^sai:\/\/machineview\//.test(url)) return `<a href="#computer" class="workspace-link" title="See the computer's screen">🖥️ ${label}</a>`;
      return `<span class="pill-ref">${label}</span>`;
    });
    s = s.replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, '$1<a href="$2" class="ext">$2</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
  }

  function render(src) {
    const lines = (src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flushPara(); flushList();
        const buf = [];
        while (++i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i]);
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const ul = line.match(/^\s*[-*]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[2])}</h4>`); }
      else if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else if (/^\s*\|/.test(line)) { flushList(); para.push(line); }
      else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
    return out.join('');
  }

  window.renderMarkdown = render;
})();
