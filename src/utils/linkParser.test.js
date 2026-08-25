import { describe, it, expect } from 'vitest';
import { extractLinksFromPages, extractTextFromJson } from './linkParser';

describe('linkParser', () => {
  it('extracts plain text from Tiptap JSON', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: '[[World]]' }
          ]
        }
      ]
    };
    const text = extractTextFromJson(json);
    expect(text).toContain('Hello [[World]]');
  });

  it('extracts edges from page array based on wiki-links', () => {
    const pages = [
      { id: 1, title: 'Alpha', content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Link to [[Beta]]' }] }] }) },
      { id: 2, title: 'Beta', content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Link to [[Gamma]] and [[Alpha]]' }] }] }) },
      { id: 3, title: 'Gamma', content: 'Plain text link [[Alpha]]' }
    ];

    const { nodes, edges } = extractLinksFromPages(pages);

    expect(nodes.length).toBe(3);
    
    // Alpha -> Beta
    expect(edges.some(e => e.source === 1 && e.target === 2)).toBe(true);
    // Beta -> Gamma
    expect(edges.some(e => e.source === 2 && e.target === 3)).toBe(true);
    // Beta -> Alpha
    expect(edges.some(e => e.source === 2 && e.target === 1)).toBe(true);
    // Gamma -> Alpha
    expect(edges.some(e => e.source === 3 && e.target === 1)).toBe(true);
  });
});
