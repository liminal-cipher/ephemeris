export function extractTextFromJson(node) {
  if (!node || typeof node !== 'object') return '';
  let text = '';
  if (node.type === 'text') {
    text += node.text;
  }
  if (node.content) {
    node.content.forEach(child => {
      text += extractTextFromJson(child);
    });
  }
  if (['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type)) {
    text += '\n';
  }
  return text;
}

export function extractLinksFromPages(pages) {
  const nodes = [];
  const edges = [];
  const titleToId = Object.create(null);
  const ids = new Map(pages.map(page => [String(page.id), page.id]));

  // Build nodes and lookup
  pages.forEach(p => {
    nodes.push({ id: p.id, name: p.title || 'Untitled', emoji: p.emoji });
    if (p.title) {
      titleToId[p.title.toLowerCase()] = p.id;
    }
  });

  const linkRegex = /\[\[(.*?)\]\]/g;

  pages.forEach(p => {
    if (!p.content) return;
    
    const seenLinks = new Set();
    
    try {
      const jsonContent = JSON.parse(p.content);
      
      // Traverse JSON structure for Tiptap mention nodes
      const traverse = (node) => {
        if (node.type === 'mention' && node.attrs && node.attrs.id) {
          const targetId = ids.get(String(node.attrs.id));
          if (targetId != null && String(targetId) !== String(p.id) && !seenLinks.has(targetId)) {
            seenLinks.add(targetId);
            edges.push({ source: p.id, target: targetId });
          }
        }
        if (node.content) {
          node.content.forEach(traverse);
        }
      };
      
      traverse(jsonContent);
      
      // Still extract raw text for fallback regex matching (legacy or unformatted text)
      const text = extractTextFromJson(jsonContent);
      let match;
      while ((match = linkRegex.exec(text)) !== null) {
        const linkedTitle = match[1].toLowerCase();
        const targetId = titleToId[linkedTitle];
        if (targetId != null && String(targetId) !== String(p.id) && !seenLinks.has(targetId)) {
          seenLinks.add(targetId);
          edges.push({ source: p.id, target: targetId });
        }
      }
    } catch {
      // Fallback for non-JSON content
      let match;
      while ((match = linkRegex.exec(p.content)) !== null) {
        const linkedTitle = match[1].toLowerCase();
        const targetId = titleToId[linkedTitle];
        if (targetId != null && String(targetId) !== String(p.id) && !seenLinks.has(targetId)) {
          seenLinks.add(targetId);
          edges.push({ source: p.id, target: targetId });
        }
      }
    }
  });

  return { nodes, edges };
}
