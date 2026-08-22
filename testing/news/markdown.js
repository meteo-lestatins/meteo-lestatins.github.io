(function exposeNewsMarkdown(global) {
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);

  function renderInline(value) {
    const links = [];
    const tokenized = String(value).replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (match, label, href) => {
      if (!/^(?:https?:|mailto:|#|\/|\.\.?\/)/i.test(href)) return label;
      const token = `NEWSLINKTOKEN${links.length}END`;
      links.push(`<a href="${escapeHtml(href)}"${/^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(label)}</a>`);
      return token;
    });
    return escapeHtml(tokenized)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/NEWSLINKTOKEN(\d+)END/g, (match, index) => links[Number(index)] || "");
  }

  global.newsMarkdownToHtml = function newsMarkdownToHtml(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      if (/^```/.test(line)) {
        const code = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
        index += 1;
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
        output.push(`<blockquote><p>${renderInline(quote.join(" "))}</p></blockquote>`);
        continue;
      }
      const list = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
      if (list) {
        const ordered = Boolean(list[2]);
        const items = [];
        const pattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/;
        while (index < lines.length) {
          const item = lines[index].match(pattern);
          if (!item) break;
          items.push(item[1]);
          index += 1;
        }
        const tag = ordered ? "ol" : "ul";
        output.push(`<${tag}>${items.map(item => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
        continue;
      }
      const paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && lines[index].trim() && !/^(?:#{1,3}\s+|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[index])) paragraph.push(lines[index++].trim());
      output.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    }
    return output.join("\n");
  };
})(globalThis);
