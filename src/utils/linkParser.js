export function extractTextFromJson(node) {
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
  const titleToId = {};

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
    
    let text = '';
    try {
      const jsonContent = JSON.parse(p.content);
      text = extractTextFromJson(jsonContent);
    } catch (e) {
      text = p.content; 
    }

    let match;
    const seenLinks = new Set();
    while ((match = linkRegex.exec(text)) !== null) {
      const linkedTitle = match[1].toLowerCase();
      const targetId = titleToId[linkedTitle];
      
      if (targetId && targetId !== p.id && !seenLinks.has(targetId)) {
        seenLinks.add(targetId);
        edges.push({
          source: p.id,
          target: targetId
        });
      }
    }
  });

  return { nodes, edges };
}
